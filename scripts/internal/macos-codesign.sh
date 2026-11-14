#!/usr/bin/env bash
#
# Sign termiHub's macOS code: with the project's self-signed identity when one is
# configured (#5545), ad hoc otherwise.
#
# The identity comes from the environment, as macos-signing-keychain.sh ci-import
# exports it in release.yml:
#   TERMIHUB_MACOS_SIGNING_IDENTITY  certificate SHA-1 of the identity
#   TERMIHUB_MACOS_SIGNING_KEYCHAIN  keychain file holding its private key
# Both unset -> ad-hoc signatures (`codesign -s -`), exactly as before #5545.
#
# Usage:
#   scripts/internal/macos-codesign.sh sign <file>...
#       Sign Mach-O files (the build scripts sign the RDP helper and the plugin
#       runner under their installed names before staging them).
#   scripts/internal/macos-codesign.sh resign-app <termiHub.app>
#       Re-sign the whole bundle inside-out (Mach-O files, then nested bundles,
#       then the app; no --deep), then verify it with `codesign --verify --deep
#       --strict`. With an identity it also checks that the app and both
#       helpers carry a designated requirement naming the certificate
#       (macos-signing.mjs), so keychain access survives updates.
#   --help, -h  Show this help.
#
# The bundled helpers (termihub-rdp-helper, termihub-plugin-runner) are special:
# the app embeds their SHA-256 and refuses a helper that does not match it. An
# ad-hoc re-sign of an ad-hoc signature is byte-identical, so ad-hoc mode
# re-signs them like everything else. A certificate signature carries its
# signing time, so re-signing one changes its bytes: identity mode leaves the
# helpers as the build script signed them and only checks their signature.
#
# Hardened runtime (--options runtime) is deliberately NOT enabled: it is only
# required for notarization, which needs an Apple Developer ID the project does
# not have, it does not change the designated requirement, and its library
# validation would stop the plugin runner from loading third-party plugin
# dylibs (a self-signed identity has no Team ID they could match).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNING_TOOL="$SCRIPT_DIR/macos-signing.mjs"
PRESIGNED_HELPERS=(termihub-rdp-helper termihub-plugin-runner)

usage() {
    sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "::error::macos-codesign: $*" >&2
    exit 1
}

IDENTITY="${TERMIHUB_MACOS_SIGNING_IDENTITY:-}"
KEYCHAIN="${TERMIHUB_MACOS_SIGNING_KEYCHAIN:-}"
if [ -n "$IDENTITY" ] && [ -z "$KEYCHAIN" ]; then
    die "TERMIHUB_MACOS_SIGNING_IDENTITY is set but TERMIHUB_MACOS_SIGNING_KEYCHAIN is not"
fi

sign_one() {
    if [ -n "$IDENTITY" ]; then
        # --timestamp=none: no Apple timestamp server for a self-signed identity.
        codesign --force --timestamp=none --keychain "$KEYCHAIN" -s "$IDENTITY" "$1"
    else
        codesign --force -s - "$1"
    fi
}

is_presigned_helper() {
    local path="$1" app="$2" name
    [ -n "$IDENTITY" ] || return 1
    for name in "${PRESIGNED_HELPERS[@]}"; do
        [ "$path" = "$app/Contents/MacOS/$name" ] && return 0
    done
    return 1
}

resign_app() {
    local app="${1%/}" f bundle bundle_id name
    [ -d "$app/Contents" ] || die "not an app bundle: $app"
    if [ -n "$IDENTITY" ]; then
        echo "Signing $app with the self-signed identity $IDENTITY"
    else
        echo "Signing $app ad hoc (no signing identity configured)"
    fi

    # 1. Every Mach-O file (dylibs, executables, helpers). A failure is FATAL
    #    (PKG-005): a swallowed inner-sign failure is how an inconsistent,
    #    Gatekeeper-"damaged" bundle would ship while the job reports success.
    while IFS= read -r -d '' f; do
        file "$f" 2>/dev/null | grep -q 'Mach-O' || continue
        if is_presigned_helper "$f" "$app"; then
            echo "Keeping the build script's signature on $f (its digest is embedded)"
            continue
        fi
        sign_one "$f" || die "codesign failed for Mach-O file: $f"
    done < <(find "$app" -type f -print0)

    # 2. Nested bundles (frameworks, plugins, XPC services) as bundles.
    while IFS= read -r -d '' bundle; do
        sign_one "$bundle" || die "codesign failed for nested bundle: $bundle"
    done < <(find "$app" -mindepth 1 -type d \( \
        -name "*.framework" -o -name "*.app" -o \
        -name "*.bundle" -o -name "*.appex" -o -name "*.xpc" \) -print0)

    # 3. The app itself (no --deep: inner content is already signed).
    sign_one "$app" || die "codesign failed for $app"

    # 4. HARD GATE: the whole bundle must verify as consistently signed.
    echo "=== Signature verification (strict, deep) ==="
    codesign --verify --deep --strict --verbose=2 "$app" ||
        die "codesign --verify --deep --strict failed for $app: the bundle is inconsistently signed"

    # 5. Identity mode: the designated requirements must name the certificate,
    #    under the identifiers every release uses (keychain items match both).
    if [ -n "$IDENTITY" ]; then
        bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")"
        echo "=== Designated requirements ==="
        node "$SIGNING_TOOL" check --cert-sha1 "$IDENTITY" --identifier "$bundle_id" "$app" ||
            die "the app's designated requirement does not name the signing certificate"
        for name in "${PRESIGNED_HELPERS[@]}"; do
            [ -e "$app/Contents/MacOS/$name" ] || continue
            node "$SIGNING_TOOL" check --cert-sha1 "$IDENTITY" --identifier "$name" \
                "$app/Contents/MacOS/$name" ||
                die "$name is not signed with the identity (sign it in its build script)"
        done
    fi
}

case "${1:-}" in
--help | -h)
    usage
    exit 0
    ;;
sign)
    shift
    [ "$#" -ge 1 ] || die "usage: sign <file>..."
    for f in "$@"; do
        sign_one "$f" || die "codesign failed for $f"
    done
    ;;
resign-app)
    [ "$#" -eq 2 ] || die "usage: resign-app <termiHub.app>"
    resign_app "$2"
    ;;
*)
    die "unknown command: ${1:-(none)} (see --help)"
    ;;
esac
