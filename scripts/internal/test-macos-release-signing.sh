#!/usr/bin/env bash
#
# Local dry run of release.yml's isolated macOS signing phases (#5781), with a
# THROWAWAY identity in a temporary keychain, on a fake app.
#
# It walks the four phases the release takes, with the real helper scripts:
#   1. build:  compiles two tiny helpers (cc -g + dsymutil), ad-hoc signs them
#      under their installed names as build-rdp-sidecar.sh / build-plugin-runner.sh
#      do, and stages their debug symbols (debug-symbols.mjs stage);
#   2. sign-macos-helpers: `macos-signing-keychain.sh ci-import` (no pin ->
#      ad hoc + ::notice::, pin without secret -> ::error::, pin + matching
#      secret -> identity) and `macos-release-signing.sh sign-helpers`;
#   3. build-app: `stage-helpers` (digest-checked), then a fake termihub that
#      embeds both helpers' SHA-256 as core/build.rs does, a nested dylib, and
#      a Tauri-like DMG (the .app + an Applications link);
#   4. sign-macos-app: `sign-app` (re-sign, helper digests, DR checks, debug
#      symbols, DMG swap, updater .app.tar.gz).
# Once with the identity, once ad hoc; plus the refusals (tampered helper,
# wrong digest, unexpected file). The identity and keychain live in a mktemp
# directory and are deleted on exit; the login keychain, the default keychain
# and the keychain search list are never touched, and the run fails if either
# changed. Nothing is uploaded and nothing in the repository is written.
#
# Usage:
#   scripts/internal/test-macos-release-signing.sh [--keep]
#       --keep      leave the work directory (printed) for inspection; the
#                   keychain is deleted regardless.
#   --help, -h  Show this help.
#
# macOS only (codesign, security, hdiutil, cc, dsymutil, openssl, node).
# check-script-headless.sh runs it on macOS and skips it elsewhere.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGN="$SCRIPT_DIR/macos-release-signing.sh"
KEYCHAIN_TOOL="$SCRIPT_DIR/macos-signing-keychain.sh"
SIGNING_TOOL="$SCRIPT_DIR/macos-signing.mjs"
SYMBOLS_TOOL="$SCRIPT_DIR/debug-symbols.mjs"
CODESIGN_TOOL="$SCRIPT_DIR/macos-codesign.sh"
BUNDLE_ID="com.termihub.selftest"

usage() {
    sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

KEEP=0
case "${1:-}" in
--help | -h)
    usage
    exit 0
    ;;
--keep) KEEP=1 ;;
"") ;;
*)
    echo "unknown argument: $1 (see --help)" >&2
    exit 2
    ;;
esac

[ "$(uname -s)" = "Darwin" ] || {
    echo "test-macos-release-signing: macOS only" >&2
    exit 2
}
for tool in codesign security hdiutil cc dsymutil openssl node shasum; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "test-macos-release-signing: $tool not found" >&2
        exit 2
    }
done

case "$(uname -m)" in
arm64) TARGET="aarch64-apple-darwin" ;;
*) TARGET="x86_64-apple-darwin" ;;
esac

W="$(mktemp -d)"
KC_STATE_BEFORE="$(security list-keychains -d user; security default-keychain -d user)"
failures=0
cleanup() {
    for kc in "$W"/runner-*/termihub-signing.keychain-db; do
        [ -e "$kc" ] && bash "$KEYCHAIN_TOOL" delete "$kc" || true
    done
    for m in "$W"/*/mount "$W"/*/*/mount; do
        [ -d "$m" ] && hdiutil detach "$m" -quiet >/dev/null 2>&1 || true
    done
    if [ "$KEEP" -eq 1 ]; then
        echo "work directory kept: $W"
    else
        rm -rf "$W"
    fi
}
trap cleanup EXIT

ok() { echo "ok    macOS release signing: $1"; }
fail() {
    echo "::error::macOS release signing: $1"
    failures=$((failures + 1))
}
step() { # <description> <command...>: expect exit 0
    local desc="$1" out
    shift
    if out="$("$@" 2>&1)"; then
        ok "$desc"
    else
        fail "$desc failed (exit $?)"
        printf '%s\n' "$out" | sed 's/^/    | /'
    fi
}
refuse() { # <description> <command...>: expect a non-zero exit
    local desc="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        fail "$desc succeeded but must be refused"
    else
        ok "$desc (refused)"
    fi
}
sha() { shasum -a 256 "$1" | cut -c1-64; }

# --- A throwaway identity (as setup-macos-signing-identity.sh makes it) ---
mkdir -p "$W/id"
cat >"$W/id/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = termiHub release-signing selftest (throwaway)
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -config "$W/id/cert.cnf" \
    -keyout "$W/id/key.pem" -out "$W/id/cert.pem" 2>/dev/null
openssl rand -hex 16 | tr -d '\n' >"$W/id/password"
openssl pkcs12 -export -inkey "$W/id/key.pem" -in "$W/id/cert.pem" -name selftest \
    -out "$W/id/identity.p12" -passout "file:$W/id/password" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
CERT_SHA1="$(openssl x509 -in "$W/id/cert.pem" -noout -fingerprint -sha1 |
    sed 's/^.*=//; s/://g' | tr '[:upper:]' '[:lower:]')"
printf '{"certificateSha1":"%s","subject":"selftest"}\n' "$CERT_SHA1" >"$W/id/pin.json"
printf '{"certificateSha1":"","subject":""}\n' >"$W/id/no-pin.json"

# ci_import <runner-dir> <pin-file> [VAR=value...]: run ci-import like the
# workflow step does, with $RUNNER_TEMP / $GITHUB_ENV / $GITHUB_OUTPUT in
# <runner-dir>.
ci_import() {
    local dir="$1" pin="$2"
    shift 2
    mkdir -p "$dir"
    : >"$dir/env"
    : >"$dir/output"
    env -u MACOS_SIGNING_P12_BASE64 -u MACOS_SIGNING_P12_PASSWORD \
        RUNNER_TEMP="$dir" GITHUB_ENV="$dir/env" GITHUB_OUTPUT="$dir/output" \
        MACOS_SIGNING_PIN_FILE="$pin" "$@" bash "$KEYCHAIN_TOOL" ci-import
}
P12_B64="$(base64 <"$W/id/identity.p12" | tr -d '\n')"
P12_PW="$(cat "$W/id/password")"

# --- Phase 2 decision paths (the ones release.yml keeps) ---
if out="$(ci_import "$W/runner-nopin" "$W/id/no-pin.json" 2>&1)" &&
    grep -q '^::notice::No macOS signing identity pinned' <<<"$out" &&
    grep -qx 'enabled=false' "$W/runner-nopin/output" && [ ! -s "$W/runner-nopin/env" ]; then
    ok "ci-import without a pin: ad hoc with a ::notice::"
else
    fail "ci-import without a pin did not fall back to ad hoc with a ::notice::"
fi
if out="$(ci_import "$W/runner-nosecret" "$W/id/pin.json" 2>&1)"; then
    fail "ci-import with a pin but no secret succeeded"
elif grep -q '^::error::.*secrets are missing' <<<"$out"; then
    ok "ci-import with a pin but no secret: ::error:: (refused)"
else
    fail "ci-import with a pin but no secret failed without the ::error::"
fi
step "ci-import with a pin and the matching secret" ci_import "$W/runner-id" "$W/id/pin.json" \
    MACOS_SIGNING_P12_BASE64="$P12_B64" MACOS_SIGNING_P12_PASSWORD="$P12_PW"
IDENTITY="$(sed -n 's/^TERMIHUB_MACOS_SIGNING_IDENTITY=//p' "$W/runner-id/env")"
KEYCHAIN="$(sed -n 's/^TERMIHUB_MACOS_SIGNING_KEYCHAIN=//p' "$W/runner-id/env")"
if [ "$IDENTITY" = "$CERT_SHA1" ] && [ -f "$KEYCHAIN" ]; then
    ok "ci-import exported the pinned identity and its temporary keychain"
else
    fail "ci-import did not export TERMIHUB_MACOS_SIGNING_IDENTITY/_KEYCHAIN"
fi

# --- Phase 1: build the helpers (no identity) ---
build_helpers() { # <dir>: two tiny helpers + their staged debug symbols
    local dir="$1" h
    mkdir -p "$dir/bin" "$dir/symbols"
    for h in termihub-rdp-helper termihub-plugin-runner; do
        printf 'int main(void) { return 64; } /* %s */\n' "$h" >"$dir/$h.c"
        (cd "$dir" && cc -g -c -o "$h.o" "$h.c" && cc -o "bin/$h" "$h.o" &&
            dsymutil "bin/$h")
        # The build scripts sign under the installed name, ad hoc here.
        env -u TERMIHUB_MACOS_SIGNING_IDENTITY -u TERMIHUB_MACOS_SIGNING_KEYCHAIN \
            bash "$CODESIGN_TOOL" sign "$dir/bin/$h"
        node "$SYMBOLS_TOOL" stage --out "$dir/symbols" --name "$h" --version selftest \
            --commit selftest "$dir/bin/$h" >/dev/null
        mkdir -p "$dir/unsigned"
        cp "$dir/bin/$h" "$dir/unsigned/$h-$TARGET"
        # Workflow artifacts drop the executable bit.
        chmod 644 "$dir/unsigned/$h-$TARGET"
    done
}

# --- Phase 3: the app build, from the signed helpers ---
build_app() { # <dir> <sums>: stage the helpers, build termihub + a DMG
    local dir="$1" sums="$2" rdp runner app
    mkdir -p "$dir/stage" "$dir/image"
    bash "$SIGN" stage-helpers "$sums" "$dir/signed" "$TARGET" "$dir/stage"
    rdp="$(sha "$dir/stage/termihub-rdp-helper-$TARGET")"
    runner="$(sha "$dir/stage/termihub-plugin-runner-$TARGET")"
    # core/build.rs embeds both digests as strings; so does this stand-in.
    cat >"$dir/termihub.c" <<EOF
#include <stdio.h>
const char *rdp_sha = "$rdp";
const char *runner_sha = "$runner";
extern int fake_lib(void);
int main(void) { printf("%s %s\n", rdp_sha, runner_sha); return fake_lib(); }
EOF
    printf 'int fake_lib(void) { return 0; }\n' >"$dir/lib.c"
    app="$dir/image/termiHub.app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks"
    (cd "$dir" && cc -g -dynamiclib -install_name @rpath/libfake.dylib -o \
        "$app/Contents/Frameworks/libfake.dylib" lib.c)
    (cd "$dir" && cc -g -c -o termihub.o termihub.c && cc -o termihub termihub.o -L"$app/Contents/Frameworks" -lfake \
        -Wl,-rpath,@executable_path/../Frameworks && dsymutil termihub)
    cp "$dir/termihub" "$app/Contents/MacOS/termihub"
    node "$SYMBOLS_TOOL" stage --out "$dir/symbols" --name termihub --version selftest \
        --commit selftest "$dir/termihub" >/dev/null
    cp "$dir/stage/termihub-rdp-helper-$TARGET" "$app/Contents/MacOS/termihub-rdp-helper"
    cp "$dir/stage/termihub-plugin-runner-$TARGET" "$app/Contents/MacOS/termihub-plugin-runner"
    cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>termihub</string>
<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
<key>CFBundleName</key><string>termiHub</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.0.0</string>
</dict></plist>
EOF
    ln -s /Applications "$dir/image/Applications"
    hdiutil create -quiet -volname termiHub -srcfolder "$dir/image" -format UDZO \
        -o "$dir/termiHub-0.0.0-dryrun-selftest.dmg"
}

# run_phases <name> [VAR=value...]: phases 1-4 in $W/<name>, signing with the
# environment given (the identity's, or none for ad hoc).
run_phases() {
    local name="$1" dir="$W/$1" check app
    shift
    build_helpers "$dir"
    step "$name: sign-helpers" env "$@" bash "$SIGN" sign-helpers "$dir/unsigned" "$dir/signed"
    [ -f "$dir/signed/SHA256SUMS" ] || return 0
    # The job output, as build-app and sign-macos-app receive it.
    cp "$dir/signed/SHA256SUMS" "$dir/sums"
    if [ "$(wc -l <"$dir/sums" | tr -d ' ')" = 2 ]; then
        ok "$name: SHA256SUMS lists both helpers"
    else
        fail "$name: SHA256SUMS does not list exactly both helpers"
    fi
    step "$name: build-app stages the signed helpers and bundles" build_app "$dir" "$dir/sums"
    [ -f "$dir/termiHub-0.0.0-dryrun-selftest.dmg" ] || return 0
    step "$name: sign-app" env "$@" bash "$SIGN" sign-app --sums "$dir/sums" --target "$TARGET" \
        --symbols "$dir/symbols" --updater-bundle "$dir/termiHub-selftest.app.tar.gz" \
        "$dir/termiHub-0.0.0-dryrun-selftest.dmg"

    # Independent re-check of what would ship: the DMG's app and the tarball.
    check="$dir/check"
    mkdir -p "$check/mount" "$check/tar"
    hdiutil attach "$dir/termiHub-0.0.0-dryrun-selftest.dmg" -mountpoint "$check/mount" \
        -nobrowse -noautoopen -readonly -quiet
    ditto "$check/mount/termiHub.app" "$check/termiHub.app"
    hdiutil detach "$check/mount" -quiet
    app="$check/termiHub.app"
    step "$name: the shipped app passes codesign --verify --deep --strict" \
        codesign --verify --deep --strict "$app"
    if [ "$(sha "$app/Contents/MacOS/termihub-rdp-helper")" = \
        "$(sha "$dir/signed/termihub-rdp-helper-$TARGET")" ] &&
        [ "$(sha "$app/Contents/MacOS/termihub-plugin-runner")" = \
            "$(sha "$dir/signed/termihub-plugin-runner-$TARGET")" ]; then
        ok "$name: the shipped helpers are byte-identical to the signed ones"
    else
        fail "$name: the shipped helpers differ from the ones sign-helpers signed"
    fi
    step "$name: the shipped app still embeds the RDP helper digest" \
        bash "$SCRIPT_DIR/verify-rdp-helper-bundle.sh" "$app/Contents/MacOS/termihub"
    step "$name: the DMG keeps the drag-to-install layout" \
        bash "$SCRIPT_DIR/macos-dmg-layout.sh" check "$dir/termiHub-0.0.0-dryrun-selftest.dmg"
    tar -xzf "$dir/termiHub-selftest.app.tar.gz" -C "$check/tar"
    step "$name: the updater bundle verifies --deep --strict" \
        codesign --verify --deep --strict "$check/tar/termiHub.app"
    if tar -tzf "$dir/termiHub-selftest.app.tar.gz" | grep -q '/\._'; then
        fail "$name: the updater bundle carries AppleDouble entries"
    else
        ok "$name: the updater bundle has no AppleDouble entries"
    fi
}

ID_ENV=(TERMIHUB_MACOS_SIGNING_IDENTITY="$IDENTITY" TERMIHUB_MACOS_SIGNING_KEYCHAIN="$KEYCHAIN")
if [ -n "$IDENTITY" ]; then
    run_phases identity "${ID_ENV[@]}"
    app="$W/identity/check/termiHub.app"
    if [ -d "$app" ]; then
        step "identity: the app's DR names the throwaway certificate" node "$SIGNING_TOOL" check \
            --cert-sha1 "$CERT_SHA1" --identifier "$BUNDLE_ID" "$app"
        for h in termihub-rdp-helper termihub-plugin-runner; do
            step "identity: $h's DR names the certificate" node "$SIGNING_TOOL" check \
                --cert-sha1 "$CERT_SHA1" --identifier "$h" "$app/Contents/MacOS/$h"
        done
        step "identity: the updater app's DR names the certificate" node "$SIGNING_TOOL" check \
            --cert-sha1 "$CERT_SHA1" --identifier "$BUNDLE_ID" "$W/identity/check/tar/termiHub.app"
    fi
fi
run_phases adhoc env -u TERMIHUB_MACOS_SIGNING_IDENTITY -u TERMIHUB_MACOS_SIGNING_KEYCHAIN
if [ -d "$W/adhoc/check/termiHub.app" ]; then
    refuse "adhoc: the ad-hoc app carries no certificate DR" node "$SIGNING_TOOL" check \
        --cert-sha1 "$CERT_SHA1" "$W/adhoc/check/termiHub.app"
fi

# --- Refusals ---
D="$W/identity"
if [ -f "$D/sums" ]; then
    mkdir -p "$W/refuse/in"
    cp "$D/unsigned/"* "$W/refuse/in/"
    cp "$D/unsigned/termihub-rdp-helper-$TARGET" "$W/refuse/in/termihub-rdp-helper-$TARGET.sha256"
    refuse "sign-helpers with an unexpected file" env "${ID_ENV[@]}" \
        bash "$SIGN" sign-helpers "$W/refuse/in" "$W/refuse/out1"
    rm "$W/refuse/in/termihub-rdp-helper-$TARGET.sha256" \
        "$W/refuse/in/termihub-plugin-runner-$TARGET"
    refuse "sign-helpers with a helper missing" env "${ID_ENV[@]}" \
        bash "$SIGN" sign-helpers "$W/refuse/in" "$W/refuse/out2"
    sed 's/^./0/' "$D/sums" >"$W/refuse/wrong-sums"
    refuse "stage-helpers against other digests" \
        bash "$SIGN" stage-helpers "$W/refuse/wrong-sums" "$D/signed" "$TARGET" "$W/refuse/stage"
    refuse "sign-app against other digests" env "${ID_ENV[@]}" bash "$SIGN" sign-app \
        --sums "$W/refuse/wrong-sums" --target "$TARGET" "$D/termiHub-0.0.0-dryrun-selftest.dmg"
    # An app whose helper was swapped after signing (e.g. by the build job).
    mkdir -p "$W/refuse/image"
    ditto "$D/image/termiHub.app" "$W/refuse/image/termiHub.app"
    cp "$D/bin/termihub-rdp-helper" "$W/refuse/image/termiHub.app/Contents/MacOS/termihub-rdp-helper"
    ln -s /Applications "$W/refuse/image/Applications"
    hdiutil create -quiet -volname termiHub -srcfolder "$W/refuse/image" -format UDZO \
        -o "$W/refuse/swapped.dmg"
    refuse "sign-app with a helper swapped after signing" env "${ID_ENV[@]}" bash "$SIGN" \
        sign-app --sums "$D/sums" --target "$TARGET" "$W/refuse/swapped.dmg"
    refuse "sign-app in identity mode with an ad-hoc helper set" env "${ID_ENV[@]}" bash "$SIGN" \
        sign-app --sums "$W/adhoc/sums" --target "$TARGET" "$W/adhoc/termiHub-0.0.0-dryrun-selftest.dmg"
fi

# --- The user's keychain configuration is untouched ---
for kc in "$W"/runner-*/termihub-signing.keychain-db; do
    [ -e "$kc" ] && bash "$KEYCHAIN_TOOL" delete "$kc"
done
if [ "$(security list-keychains -d user; security default-keychain -d user)" = "$KC_STATE_BEFORE" ]; then
    ok "keychain search list and default keychain unchanged"
else
    fail "the keychain search list or default keychain changed"
fi
if [ "$failures" -gt 0 ]; then
    echo "test-macos-release-signing: $failures check(s) failed"
    exit 1
fi
echo "test-macos-release-signing: all checks passed"
