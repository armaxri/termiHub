#!/usr/bin/env bash
# Fetch and stage the sideloaded ConPTY host for the Windows bundle (#4121).
#
# Windows local terminals run under ConPTY. The inbox host
# (kernel32!CreatePseudoConsole) drops SIXEL and other graphics DCS strings, so
# inline images never reach the terminal. portable-pty prefers a conpty.dll
# next to termihub.exe, and that conpty.dll starts the OpenConsole.exe beside
# it, which passes those strings through unchanged. This script downloads both
# from Microsoft's official Microsoft.Windows.Console.ConPTY NuGet package and
# stages them for src-tauri/tauri.conpty.conf.json, which bundles them next to
# termihub.exe (MSI, NSIS, and the target/<profile>/ dir of a `tauri build`).
#
# Supply chain: the binaries are never committed. The package version and the
# SHA-256 of the package AND of each extracted file are pinned in
# src-tauri/packaging/windows/conpty.env. A hash mismatch fails the script
# (exit 1) and stages nothing. Files already staged with matching hashes are
# kept, so a rebuild does not download again.
#
# Usage: scripts/internal/fetch-conpty.sh [--arch x64|arm64] [--dest DIR]
#   --arch   Host architecture of the files (default: x64, the only Windows
#            desktop target release.yml builds).
#   --dest   Where to stage conpty.dll + OpenConsole.exe
#            (default: src-tauri/binaries/conpty, gitignored).
#
# Runs anywhere bash, curl and unzip (or bsdtar, or Python) exist. CI runs it on the
# Windows runner through Git Bash; scripts/internal/fetch-conpty.cmd is the
# native Windows twin (PowerShell).
set -euo pipefail

ARCH="x64"
DEST=""

while [ "$#" -gt 0 ]; do
    case "$1" in
    --arch)
        [ "$#" -ge 2 ] || { echo "--arch needs a value" >&2; exit 1; }
        ARCH="$2"
        shift
        ;;
    --dest)
        [ "$#" -ge 2 ] || { echo "--dest needs a value" >&2; exit 1; }
        DEST="$2"
        shift
        ;;
    --help | -h)
        awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
        exit 0
        ;;
    *)
        echo "Unknown argument: $1 (see --help)" >&2
        exit 1
        ;;
    esac
    shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PIN_FILE="$REPO_ROOT/src-tauri/packaging/windows/conpty.env"
[ -n "$DEST" ] || DEST="$REPO_ROOT/src-tauri/binaries/conpty"

# shellcheck source=SCRIPTDIR/../../src-tauri/packaging/windows/conpty.env
. "$PIN_FILE"

case "$ARCH" in
x64)
    DLL_SHA="$CONPTY_DLL_X64_SHA256"
    HOST_SHA="$OPENCONSOLE_X64_SHA256"
    ;;
arm64)
    DLL_SHA="$CONPTY_DLL_ARM64_SHA256"
    HOST_SHA="$OPENCONSOLE_ARM64_SHA256"
    ;;
*)
    echo "Unsupported --arch '$ARCH' (expected x64 or arm64)" >&2
    exit 1
    ;;
esac
DLL_ENTRY="runtimes/win-${ARCH}/native/conpty.dll"
HOST_ENTRY="build/native/runtimes/${ARCH}/OpenConsole.exe"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum <"$1" | cut -c1-64
    else
        shasum -a 256 <"$1" | cut -c1-64
    fi
}

# verify FILE EXPECTED LABEL: fail loudly on a mismatch.
verify() {
    local actual
    actual="$(sha256_of "$1")"
    if [ "$actual" != "$2" ]; then
        echo "::error::SHA-256 mismatch for $3" >&2
        echo "  expected: $2" >&2
        echo "  actual:   $actual" >&2
        return 1
    fi
    echo "  verified $3 ($actual)"
}

staged_ok() {
    [ -f "$DEST/conpty.dll" ] && [ -f "$DEST/OpenConsole.exe" ] &&
        [ "$(sha256_of "$DEST/conpty.dll")" = "$DLL_SHA" ] &&
        [ "$(sha256_of "$DEST/OpenConsole.exe")" = "$HOST_SHA" ]
}

echo "=== Sideloaded ConPTY ${CONPTY_VERSION} (${ARCH}) -> ${DEST} ==="
if staged_ok; then
    echo "  already staged with the pinned hashes; nothing to do"
    exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

URL="https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/${CONPTY_VERSION}/microsoft.windows.console.conpty.${CONPTY_VERSION}.nupkg"
echo "  downloading $URL"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --retry-delay 5 -o "$WORK/conpty.nupkg" "$URL"
verify "$WORK/conpty.nupkg" "$CONPTY_NUPKG_SHA256" "Microsoft.Windows.Console.ConPTY ${CONPTY_VERSION}.nupkg"

# extract ENTRY OUT: one file out of the package (a zip). Tries unzip, then a
# bsdtar (on Windows: %SystemRoot%\System32\tar.exe reads zips; Git Bash's
# GNU tar does not), then Python's zipfile.
extract() {
    if command -v unzip >/dev/null 2>&1; then
        unzip -p "$WORK/conpty.nupkg" "$1" >"$2"
        return
    fi
    local bsdtar=""
    if command -v bsdtar >/dev/null 2>&1; then
        bsdtar="bsdtar"
    elif [ -n "${SYSTEMROOT:-}" ] && [ -x "$SYSTEMROOT/System32/tar.exe" ]; then
        bsdtar="$SYSTEMROOT/System32/tar.exe"
    fi
    if [ -n "$bsdtar" ]; then
        "$bsdtar" -xOf "$WORK/conpty.nupkg" "$1" >"$2"
        return
    fi
    local py
    for py in python3 python; do
        if command -v "$py" >/dev/null 2>&1 && "$py" -c "import zipfile" >/dev/null 2>&1; then
            "$py" - "$WORK/conpty.nupkg" "$1" "$2" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z, open(sys.argv[3], "wb") as out:
    out.write(z.read(sys.argv[2]))
PY
            return
        fi
    done
    echo "::error::need unzip, bsdtar or Python to extract the .nupkg" >&2
    return 1
}

extract "$DLL_ENTRY" "$WORK/conpty.dll"
extract "$HOST_ENTRY" "$WORK/OpenConsole.exe"
verify "$WORK/conpty.dll" "$DLL_SHA" "$DLL_ENTRY"
verify "$WORK/OpenConsole.exe" "$HOST_SHA" "$HOST_ENTRY"

mkdir -p "$DEST"
cp "$WORK/conpty.dll" "$WORK/OpenConsole.exe" "$DEST/"
echo "  staged conpty.dll + OpenConsole.exe in $DEST"
