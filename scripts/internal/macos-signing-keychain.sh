#!/usr/bin/env bash
#
# Temporary keychain for termiHub's self-signed macOS code-signing identity (#5545).
#
# codesign needs the identity's private key in a keychain. This helper puts it
# into a NEW, throwaway keychain file and leaves every existing keychain alone:
# it never touches the login keychain, the default keychain or the keychain
# search list (codesign is pointed at the file with --keychain), and it fails
# if either changed underneath it.
#
# Usage:
#   scripts/internal/macos-signing-keychain.sh create <keychain> <p12> <p12-password-file>
#       Create <keychain> (must not exist), import the .p12 into it for
#       /usr/bin/codesign only, and print the identity's certificate SHA-1.
#   scripts/internal/macos-signing-keychain.sh delete <keychain>
#       Delete a keychain this helper created (never a login keychain).
#   scripts/internal/macos-signing-keychain.sh ci-import
#       release.yml: decide how the macOS build is signed. Reads the secrets
#       MACOS_SIGNING_P12_BASE64 / MACOS_SIGNING_P12_PASSWORD from the
#       environment and the pin scripts/internal/macos-signing-identity.json:
#         * no pin              -> ad-hoc signing, with a ::notice::
#         * pin, no secret      -> ::error:: (would silently ship ad hoc again)
#         * pin, other cert     -> ::error::
#         * pin, matching cert  -> keychain in $RUNNER_TEMP; exports
#           TERMIHUB_MACOS_SIGNING_IDENTITY / TERMIHUB_MACOS_SIGNING_KEYCHAIN
#           to $GITHUB_ENV (read by build-rdp-sidecar.sh, build-plugin-runner.sh
#           and the re-sign step) and enabled=true to $GITHUB_OUTPUT.
#       MACOS_SIGNING_PIN_FILE overrides the pin file (local testing only).
#   --help, -h  Show this help.
#
# The keychain password is random, never printed, and only lives in this
# process. `security import` takes the .p12 password as an argument, so it is
# visible in the process list for the second the import runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Overridable so the ci-import paths can be exercised against a scratch pin.
PIN_FILE="${MACOS_SIGNING_PIN_FILE:-$SCRIPT_DIR/macos-signing-identity.json}"

usage() {
    sed -n '3,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "macos-signing-keychain: $*" >&2
    exit 1
}

# The user's keychain configuration; must be identical before and after.
keychain_state() {
    security list-keychains -d user
    security default-keychain -d user
}

refuse_login_keychain() {
    case "$(basename "$1")" in
    login.keychain | login.keychain-db) die "refusing to operate on a login keychain: $1" ;;
    esac
}

# populate_keychain <keychain> <keychain-password> <p12> <p12-password-file>:
# unlock, import for codesign and print the identity's SHA-1. Every step
# returns on failure explicitly (errexit does not apply under `if !`).
populate_keychain() {
    local kc="$1" kcpw="$2" p12="$3" pwfile="$4" sha1
    # Stay unlocked for 6 h (a release build), no lock on sleep.
    security set-keychain-settings -t 21600 "$kc" || return 1
    security unlock-keychain -p "$kcpw" "$kc" || return 1
    security import "$p12" -k "$kc" -f pkcs12 -P "$(cat "$pwfile")" \
        -T /usr/bin/codesign >/dev/null || return 1
    # Let codesign use the key without a UI prompt.
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
        -k "$kcpw" "$kc" >/dev/null || return 1
    # `find-identity` lists untrusted (self-signed) identities too, with
    # CSSMERR_TP_NOT_TRUSTED; codesign signs with them all the same.
    sha1="$(security find-identity -p codesigning "$kc" |
        sed -n 's/^ *1) \([0-9A-F]\{40\}\) .*/\1/p' | head -n 1)" || return 1
    [ -n "$sha1" ] || return 1
    echo "$sha1"
}

# create <keychain> <p12> <p12-password-file>; prints the certificate SHA-1.
create_keychain() {
    local kc="$1" p12="$2" pwfile="$3" before after kcpw sha1
    refuse_login_keychain "$kc"
    case "$kc" in
    /*) ;;
    *) die "keychain path must be absolute: $kc" ;;
    esac
    [ ! -e "$kc" ] || die "$kc already exists"
    [ -f "$p12" ] || die "$p12 not found"
    [ -f "$pwfile" ] || die "$pwfile not found"
    before="$(keychain_state)"

    kcpw="$(openssl rand -hex 24)"
    security create-keychain -p "$kcpw" "$kc" >/dev/null
    # From here on a failure removes the half-built keychain again.
    if ! sha1="$(populate_keychain "$kc" "$kcpw" "$p12" "$pwfile")"; then
        security delete-keychain "$kc" 2>/dev/null || true
        die "could not import $p12 into $kc (wrong password, or no code-signing identity in it?)"
    fi

    after="$(keychain_state)"
    if [ "$before" != "$after" ]; then
        security delete-keychain "$kc" 2>/dev/null || true
        die "the keychain search list or default keychain changed; aborting"
    fi
    echo "$sha1" | tr '[:upper:]' '[:lower:]'
}

delete_keychain() {
    local kc="$1"
    refuse_login_keychain "$kc"
    [ -e "$kc" ] || return 0
    security delete-keychain "$kc"
}

ci_import() {
    local pinned sha1
    : "${GITHUB_ENV:?ci-import runs in GitHub Actions (GITHUB_ENV unset)}"
    : "${GITHUB_OUTPUT:?ci-import runs in GitHub Actions (GITHUB_OUTPUT unset)}"
    : "${RUNNER_TEMP:?ci-import runs in GitHub Actions (RUNNER_TEMP unset)}"
    pinned="$(node "$SCRIPT_DIR/macos-signing.mjs" pinned --file "$PIN_FILE")"
    if [ -z "$pinned" ]; then
        echo "::notice::No macOS signing identity pinned in scripts/internal/macos-signing-identity.json: this build is ad-hoc signed, so macOS keychain access does not survive updates. Set it up with scripts/internal/setup-macos-signing-identity.sh (maintainer, see docs/contributing.md -> 'macOS signing identity')."
        echo "enabled=false" >>"$GITHUB_OUTPUT"
        return 0
    fi
    if [ -z "${MACOS_SIGNING_P12_BASE64:-}" ] || [ -z "${MACOS_SIGNING_P12_PASSWORD:-}" ]; then
        echo "::error::scripts/internal/macos-signing-identity.json pins certificate $pinned, but the MACOS_SIGNING_P12_BASE64 / MACOS_SIGNING_P12_PASSWORD secrets are missing. An ad-hoc build would make every installed copy lose its keychain access. Run scripts/internal/setup-macos-signing-identity.sh (maintainer) - see docs/contributing.md -> 'macOS signing identity'."
        return 1
    fi
    # The decoded .p12 and its password exist only until the import is done.
    CI_WORK="$(mktemp -d "$RUNNER_TEMP/macos-signing.XXXXXX")"
    trap 'find "$CI_WORK" -type f -exec rm -P {} + 2>/dev/null; rm -rf "$CI_WORK"' EXIT
    (
        umask 077
        printf '%s' "$MACOS_SIGNING_P12_BASE64" | base64 --decode >"$CI_WORK/identity.p12"
        printf '%s' "$MACOS_SIGNING_P12_PASSWORD" >"$CI_WORK/password"
    )
    sha1="$(create_keychain "$RUNNER_TEMP/termihub-signing.keychain-db" \
        "$CI_WORK/identity.p12" "$CI_WORK/password")"
    if [ "$sha1" != "$pinned" ]; then
        delete_keychain "$RUNNER_TEMP/termihub-signing.keychain-db"
        echo "::error::The MACOS_SIGNING_P12_BASE64 secret holds certificate $sha1, but scripts/internal/macos-signing-identity.json pins $pinned. Signing with another certificate would make every installed copy lose its keychain access."
        return 1
    fi
    {
        echo "TERMIHUB_MACOS_SIGNING_IDENTITY=$sha1"
        echo "TERMIHUB_MACOS_SIGNING_KEYCHAIN=$RUNNER_TEMP/termihub-signing.keychain-db"
    } >>"$GITHUB_ENV"
    echo "enabled=true" >>"$GITHUB_OUTPUT"
    echo "macOS signing identity imported: certificate $sha1 (pinned)."
}

case "${1:-}" in
--help | -h)
    usage
    exit 0
    ;;
create)
    [ "$#" -eq 4 ] || die "usage: create <keychain> <p12> <p12-password-file>"
    create_keychain "$2" "$3" "$4"
    ;;
delete)
    [ "$#" -eq 2 ] || die "usage: delete <keychain>"
    delete_keychain "$2"
    ;;
ci-import)
    [ "$#" -eq 1 ] || die "ci-import takes no arguments"
    cd "$REPO_ROOT"
    ci_import
    ;;
*)
    die "unknown command: ${1:-(none)} (see --help)"
    ;;
esac
