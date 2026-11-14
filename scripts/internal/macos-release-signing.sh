#!/usr/bin/env bash
#
# The macOS signing phases of release.yml (#5781): sign the bundled helpers and
# the finished app in jobs that run no third-party build code.
#
# release.yml builds macOS in four phases so that the signing identity
# (#5545) never shares a runner with dependency or build code:
#   1. build-macos-helpers  builds the RDP helper and the plugin runner (ad-hoc
#                           signed under their installed names by their build
#                           scripts), no identity;
#   2. sign-macos-helpers   `sign-helpers`: signs them with the identity;
#   3. build-app (macOS)    `stage-helpers`: stages exactly the signed bytes as
#                           Tauri externalBin, so core/build.rs embeds their
#                           SHA-256; compiles and bundles the app, no identity;
#   4. sign-macos-app       `sign-app`: signs the app around the helpers, checks
#                           it and rewrites the DMG and the updater bundle.
# Only phases 2 and 4 import the identity (macos-signing-keychain.sh ci-import),
# and they run only this script, macos-codesign.sh, macos-signing.mjs,
# macos-dmg-layout.sh, the verify-*-bundle.sh checks and debug-symbols.mjs:
# first-party and dependency-free. Neither executes anything that was built.
#
# Usage:
#   scripts/internal/macos-release-signing.sh sign-helpers <in-dir> <out-dir>
#       Sign every termihub-rdp-helper-<target> / termihub-plugin-runner-<target>
#       in <in-dir> under its installed name (macos-codesign.sh sign: the
#       identity from the environment, ad hoc without one), verify it
#       (`codesign --verify --strict`; with the identity, that its designated
#       requirement names the certificate under that identifier), write it to
#       <out-dir> under the same file name and record "<sha256>  <file>" in
#       <out-dir>/SHA256SUMS. Every target needs both helpers; any other file
#       is refused.
#   scripts/internal/macos-release-signing.sh stage-helpers <sums> <signed-dir>
#                                             <target> <stage-dir>
#       Copy <target>'s two signed helpers from <signed-dir> into <stage-dir>
#       (src-tauri/binaries) as executables, with their .sha256 transparency
#       files, after checking each against <sums> (sign-macos-helpers' job
#       output, not the artifact). Fails on any mismatch.
#   scripts/internal/macos-release-signing.sh sign-app --sums <sums>
#                                             --target <target> [--symbols <dir>]
#                                             [--updater-bundle <out.app.tar.gz>]
#                                             <dmg>
#       Copy the .app out of <dmg>, check its helpers are the signed ones from
#       <sums>, re-sign it inside-out (macos-codesign.sh resign-app: keeps the
#       helpers' signatures, `codesign --verify --deep --strict`, DR checks),
#       check the helpers are unchanged and still match the digests the app
#       embeds, check the binaries against the unpacked debug symbols in
#       <dir>, swap the app into <dmg> (macos-dmg-layout.sh replace-app +
#       check) and, with --updater-bundle, write the updater .app.tar.gz from
#       the app in the rewritten DMG after verifying it again.
#   --help, -h  Show this help.
#
# Local dry run with a throwaway identity: see docs/contributing.md ->
# "macOS Signing Identity" (check-script-headless.sh runs the same on macOS).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODESIGN_TOOL="$SCRIPT_DIR/macos-codesign.sh"
SIGNING_TOOL="$SCRIPT_DIR/macos-signing.mjs"
DMG_TOOL="$SCRIPT_DIR/macos-dmg-layout.sh"
HELPERS="termihub-rdp-helper termihub-plugin-runner"
TARGET_RE='^(x86_64|aarch64)-apple-darwin$'
SUMS_NAME="SHA256SUMS"

usage() {
    sed -n '3,53p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "::error::macos-release-signing: $*" >&2
    exit 1
}

IDENTITY="${TERMIHUB_MACOS_SIGNING_IDENTITY:-}"

sha256_of() {
    shasum -a 256 "$1" | cut -c1-64
}

# expected_sum <sums-file> <file-name>: the recorded digest, or fail.
expected_sum() {
    local sums="$1" name="$2" hex
    hex="$(awk -v n="$name" '$2 == n { print $1 }' "$sums")"
    case "$hex" in
    "" | *[!0-9a-f]*) die "no SHA-256 for $name in $sums" ;;
    esac
    [ "${#hex}" -eq 64 ] || die "malformed SHA-256 for $name in $sums"
    echo "$hex"
}

# check_sum <sums-file> <file-name> <path>
check_sum() {
    local want got
    want="$(expected_sum "$1" "$2")"
    got="$(sha256_of "$3")"
    [ "$got" = "$want" ] ||
        die "$3 hashes to $got, but sign-macos-helpers signed $2 as $want"
}

# verify_signature <file> <identifier>
verify_signature() {
    codesign --verify --strict --verbose=2 "$1" ||
        die "codesign --verify --strict failed for $1"
    if [ -n "$IDENTITY" ]; then
        node "$SIGNING_TOOL" check --cert-sha1 "$IDENTITY" --identifier "$2" "$1" ||
            die "$1 is not signed with the identity $IDENTITY as $2"
    fi
}

sign_helpers() {
    local in="$1" out="$2" f fname h helper target work count=0 targets=""
    [ -d "$in" ] || die "$in is not a directory"
    mkdir -p "$out"
    [ ! -e "$out/$SUMS_NAME" ] || die "$out/$SUMS_NAME already exists"
    work="$(mktemp -d)"
    for f in "$in"/*; do
        [ -e "$f" ] || continue
        fname="$(basename "$f")"
        [ -f "$f" ] && [ ! -L "$f" ] || die "not a regular file: $f"
        helper=""
        for h in $HELPERS; do
            case "$fname" in "$h"-*) helper="$h" ;; esac
        done
        [ -n "$helper" ] || die "unexpected file in $in: $fname"
        target="${fname#"$helper"-}"
        echo "$target" | grep -Eq "$TARGET_RE" || die "unexpected target in $fname"
        file "$f" | grep -q 'Mach-O' || die "$fname is not a Mach-O binary"
        # Signed under its installed name: an ad-hoc signature's identifier is
        # the file name, and the DR check below expects it.
        rm -rf "${work:?}/$helper"
        cp "$f" "$work/$helper"
        chmod 755 "$work/$helper"
        bash "$CODESIGN_TOOL" sign "$work/$helper"
        verify_signature "$work/$helper" "$helper"
        cp "$work/$helper" "$out/$fname"
        printf '%s  %s\n' "$(sha256_of "$out/$fname")" "$fname" >>"$out/$SUMS_NAME"
        echo "Signed $fname as $helper (${IDENTITY:-ad hoc})"
        count=$((count + 1))
        case " $targets " in *" $target "*) ;; *) targets="$targets $target" ;; esac
    done
    rm -rf "$work"
    [ "$count" -gt 0 ] || die "no helpers found in $in"
    for target in $targets; do
        for h in $HELPERS; do
            [ -f "$out/$h-$target" ] || die "$h-$target is missing from $in"
        done
    done
    cat "$out/$SUMS_NAME"
}

stage_helpers() {
    local sums="$1" signed="$2" target="$3" stage="$4" h file
    [ -f "$sums" ] || die "$sums not found"
    echo "$target" | grep -Eq "$TARGET_RE" || die "not a macOS target: $target"
    mkdir -p "$stage"
    for h in $HELPERS; do
        file="$h-$target"
        [ -f "$signed/$file" ] || die "$signed/$file not found"
        check_sum "$sums" "$file" "$signed/$file"
        cp "$signed/$file" "$stage/$file"
        # Workflow artifacts drop the executable bit.
        chmod 755 "$stage/$file"
        check_sum "$sums" "$file" "$stage/$file"
        printf '%s  %s\n' "$(expected_sum "$sums" "$file")" "$file" >"$stage/$file.sha256"
        echo "Staged the signed $file ($(expected_sum "$sums" "$file"))"
    done
}

# check_app_helpers <sums> <target> <app>
check_app_helpers() {
    local h
    for h in $HELPERS; do
        [ -f "$3/Contents/MacOS/$h" ] || die "$h is missing from $3"
        check_sum "$1" "$h-$2" "$3/Contents/MacOS/$h"
    done
}

# extract_app <dmg> <dir>: copy the image's only .app into <dir>, print its path.
extract_app() {
    local dmg="$1" dir="$2" app name
    mkdir "$dir/mount"
    hdiutil attach "$dmg" -mountpoint "$dir/mount" -nobrowse -noautoopen -readonly -quiet
    app="$(find "$dir/mount" -mindepth 1 -maxdepth 1 -name '*.app' | head -n 1)"
    if [ -z "$app" ]; then
        hdiutil detach "$dir/mount" -quiet || true
        die "no .app in $dmg"
    fi
    name="$(basename "$app")"
    ditto "$app" "$dir/$name"
    hdiutil detach "$dir/mount" -quiet
    rmdir "$dir/mount"
    echo "$dir/$name"
}

sign_app() {
    local sums="" target="" symbols="" updater="" dmg="" work app exe bundle_id m out
    while [ $# -gt 0 ]; do
        case "$1" in
        --sums) sums="${2:?--sums requires a file}" && shift 2 ;;
        --target) target="${2:?--target requires a triple}" && shift 2 ;;
        --symbols) symbols="${2:?--symbols requires a directory}" && shift 2 ;;
        --updater-bundle) updater="${2:?--updater-bundle requires a path}" && shift 2 ;;
        -*) die "unknown option: $1" ;;
        *)
            [ -z "$dmg" ] || die "only one <dmg> is accepted"
            dmg="$1"
            shift
            ;;
        esac
    done
    [ -n "$dmg" ] && [ -f "$dmg" ] || die "usage: sign-app --sums <file> --target <t> <dmg>"
    [ -n "$sums" ] && [ -f "$sums" ] || die "--sums <file> is required"
    echo "$target" | grep -Eq "$TARGET_RE" || die "--target must be a macOS target"

    work="$(mktemp -d)"
    app="$(extract_app "$dmg" "$work")"
    exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
    m="$app/Contents/MacOS"

    # The helpers in the bundle must be exactly the ones sign-macos-helpers signed.
    check_app_helpers "$sums" "$target" "$app"

    # Inside-out re-sign, `codesign --verify --deep --strict` and, with the
    # identity, the designated requirements of the app and both helpers.
    bash "$CODESIGN_TOOL" resign-app "$app"

    # The re-sign kept the helpers' bytes (identity: their signatures are
    # left alone; ad hoc: a re-sign under the same name is byte-identical),
    # so they still match the digests the app embeds (#1762, #4202, #4222).
    check_app_helpers "$sums" "$target" "$app"
    bash "$SCRIPT_DIR/verify-rdp-helper-bundle.sh" "$m/$exe"
    # --no-run: this job executes nothing that was built; Release macOS Smoke
    # starts the runner natively.
    bash "$SCRIPT_DIR/verify-plugin-runner-bundle.sh" --no-run "$m/$exe"

    # codesign leaves LC_UUID unchanged: the signed binaries must still match
    # the debug-symbols asset (#4504).
    if [ -n "$symbols" ]; then
        dwarfdump --uuid "$m/$exe" "$symbols/termihub.dSYM"
        node "$SCRIPT_DIR/debug-symbols.mjs" check "$symbols" termihub="$m/$exe" \
            termihub-rdp-helper="$m/termihub-rdp-helper" \
            termihub-plugin-runner="$m/termihub-plugin-runner"
    fi

    # Advisory only: Gatekeeper rejects any bundle without a Developer ID.
    echo "=== Gatekeeper assessment (advisory) ==="
    if ! spctl --assess --type exec --verbose=2 "$app" 2>&1; then
        echo "::notice::spctl rejected the bundle (expected without a Developer ID)"
    fi
    echo "=== Signature info ==="
    codesign -dv "$app" 2>&1
    codesign -d -r- "$app" 2>&1

    # Swap the signed app into Tauri's own image (keeps the drag-to-install
    # layout, PKG2-009); the helper rewrites the DMG only once it verifies.
    bash "$DMG_TOOL" replace-app "$dmg" "$app"
    bash "$DMG_TOOL" check "$dmg"

    if [ -n "$updater" ]; then
        # From the app in the rewritten image, so the updater installs exactly
        # what the DMG ships; it must carry the identity too (#5545).
        mkdir "$work/updater"
        app="$(extract_app "$dmg" "$work/updater")"
        codesign --verify --deep --strict "$app" ||
            die "codesign --verify --deep --strict failed for the updater app"
        check_app_helpers "$sums" "$target" "$app"
        if [ -n "$IDENTITY" ]; then
            bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")"
            node "$SIGNING_TOOL" check --cert-sha1 "$IDENTITY" --identifier "$bundle_id" "$app"
        fi
        out="$(cd "$(dirname "$updater")" && pwd)/$(basename "$updater")"
        # No AppleDouble (._*) entries: the updater unpacks this over the app.
        COPYFILE_DISABLE=1 tar -czf "$out" -C "$(dirname "$app")" "$(basename "$app")"
        echo "Wrote the updater bundle $out"
    fi
    rm -rf "$work"
}

case "${1:-}" in
--help | -h)
    usage
    exit 0
    ;;
sign-helpers)
    [ "$#" -eq 3 ] || die "usage: sign-helpers <in-dir> <out-dir>"
    sign_helpers "$2" "$3"
    ;;
stage-helpers)
    [ "$#" -eq 5 ] || die "usage: stage-helpers <sums> <signed-dir> <target> <stage-dir>"
    stage_helpers "$2" "$3" "$4" "$5"
    ;;
sign-app)
    shift
    sign_app "$@"
    ;;
*)
    die "unknown command: ${1:-(none)} (see --help)"
    ;;
esac
