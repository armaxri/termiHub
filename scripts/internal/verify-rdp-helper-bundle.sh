#!/usr/bin/env bash
#
# Verify the RDP helper shipped next to a built or installed termiHub (#4222).
#
# Usage:
#   scripts/internal/verify-rdp-helper-bundle.sh [--helper <path>] <app-binary>
#
# <app-binary> is the main executable (termihub, termihub.exe, or
# termiHub.app/Contents/MacOS/termihub). The bundled helper must sit in the same
# directory as termihub-rdp-helper[.exe] (Tauri `externalBin`; --helper names it
# elsewhere), and:
#   1. be an executable file;
#   2. hash to a SHA-256 embedded in <app-binary>. core/build.rs embeds the
#      staged helper's digest (#1762) and the RDP adapter refuses a helper that
#      does not match it, so this catches a bundling or signing step (the macOS
#      ad-hoc re-sign, PKG-005; the AppImage patchelf, #4243) that rewrote the
#      file after staging.
#
# Exit status: 0 = all checks passed, 1 = a check failed, 2 = usage error.
# Runs in release.yml / dev-build.yml (inside the re-signed macOS .app; on
# Linux in the target dir, .deb, .rpm and AppImage) and the release install
# smokes; check-script-headless.sh runs it against stubs per PR.

set -euo pipefail

# Byte-wise matching: the app binary is not valid UTF-8.
export LC_ALL=C

usage() {
    sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

APP=""
HELPER=""
while [ $# -gt 0 ]; do
    case "$1" in
    --help | -h)
        usage
        exit 0
        ;;
    --helper)
        HELPER="${2:?--helper requires a path}"
        shift 2
        ;;
    -*)
        echo "Unknown argument: $1" >&2
        exit 2
        ;;
    *)
        if [ -n "$APP" ]; then
            echo "Only one <app-binary> is accepted" >&2
            exit 2
        fi
        APP="$1"
        shift
        ;;
    esac
done

if [ -z "$APP" ]; then
    echo "usage: $0 [--helper <path>] <app-binary>" >&2
    exit 2
fi
if [ ! -f "$APP" ]; then
    echo "::error::app binary not found: $APP"
    exit 1
fi

if [ -z "$HELPER" ]; then
    case "$APP" in
    *.exe | *.EXE) HELPER="$(dirname "$APP")/termihub-rdp-helper.exe" ;;
    *) HELPER="$(dirname "$APP")/termihub-rdp-helper" ;;
    esac
fi

if [ ! -f "$HELPER" ] || [ ! -x "$HELPER" ]; then
    echo "::error::bundled RDP helper missing or not executable at $HELPER"
    exit 1
fi
echo "RDP helper: $HELPER"

if command -v sha256sum >/dev/null 2>&1; then
    DIGEST="$(sha256sum "$HELPER" | cut -c1-64)"
else
    # macOS has no sha256sum; `shasum -a 256` is the BSD equivalent.
    DIGEST="$(shasum -a 256 "$HELPER" | cut -c1-64)"
fi
case "$DIGEST" in
*[!0-9a-f]* | "")
    echo "::error::could not hash $HELPER (got '$DIGEST')"
    exit 1
    ;;
esac
if ! grep -qaF "$DIGEST" "$APP"; then
    echo "::error::the RDP helper's SHA-256 $DIGEST is not embedded in $APP; the app would" \
        "refuse it as tampered. Was it rewritten after staging (signing, bundling), or was the" \
        "app built without staging it (scripts/build-rdp-sidecar.sh --tauri-externalbin)?"
    exit 1
fi
echo "  integrity: SHA-256 $DIGEST is the digest embedded in $(basename "$APP")"
echo "RDP helper bundle OK."
