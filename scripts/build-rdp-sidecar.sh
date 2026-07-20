#!/usr/bin/env bash
# Build the RDP sidecar (termihub-rdp-helper) and optionally stage it for Tauri.
#
# The sidecar (#1747) is a workspace-EXCLUDED crate with its own Cargo.lock:
# IronRDP's CredSSP crypto and russh pin incompatible RustCrypto pre-releases,
# and Cargo allows one version per crate per lockfile (#1725). It therefore
# builds as its own cargo unit, separate from the main workspace build.
#
# The sidecar runs on the SAME machine as termiHub, so a released build ships it
# NEXT TO the desktop binary via Tauri `externalBin` (#1754). The app resolves
# the helper next to its own executable, or via $TERMIHUB_RDP_HELPER.
#
# Usage: ./scripts/build-rdp-sidecar.sh [--release] [--target <triple>]
#                                       [--tauri-externalbin] [--out <dir>]
#   --release             Build with optimizations (default: debug).
#   --target <triple>     Cross-build for a specific Rust target triple (e.g.
#                         x86_64-apple-darwin). Default: the host triple. Output
#                         lands under rdp-sidecar/target/<triple>/<profile>/.
#   --tauri-externalbin   Stage the built binary into src-tauri/binaries/ named
#                         `termihub-rdp-helper-<triple>[.exe]`, the layout Tauri
#                         `externalBin` expects. Tauri strips the -<triple>
#                         suffix and drops the helper next to the app binary,
#                         where SidecarRdp's next-to-exe resolution finds it.
#   --out <dir>           Also copy the binary into <dir> (e.g. next to a
#                         locally-built desktop binary for manual testing).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PROFILE="debug"
CARGO_FLAGS=()
OUT_DIR=""
TARGET=""
EXTERNALBIN=0

while [ $# -gt 0 ]; do
    case "$1" in
    --release)
        PROFILE="release"
        CARGO_FLAGS+=(--release)
        shift
        ;;
    --target)
        TARGET="${2:?--target requires a triple}"
        shift 2
        ;;
    --tauri-externalbin)
        EXTERNALBIN=1
        shift
        ;;
    --out)
        OUT_DIR="${2:?--out requires a directory}"
        shift 2
        ;;
    --help | -h)
        sed -n '2,25p' "$0"
        exit 0
        ;;
    *)
        echo "Unknown argument: $1" >&2
        exit 2
        ;;
    esac
done

# `externalBin` staging needs a concrete triple for the filename suffix, so
# resolve the host triple when none was given. Without either flag we keep the
# historical host-native layout (rdp-sidecar/target/<profile>/) untouched.
if [ "$EXTERNALBIN" -eq 1 ] && [ -z "$TARGET" ]; then
    TARGET="$(rustc -vV | sed -n 's/^host: //p')"
    if [ -z "$TARGET" ]; then
        echo "ERROR: could not determine host target triple from 'rustc -vV'" >&2
        exit 1
    fi
fi

# The `.exe` suffix and cargo output dir depend on the *target*, not the host,
# so a cross-build (e.g. a Windows target) names the file correctly.
if [ -n "$TARGET" ]; then
    case "$TARGET" in
    *windows*) BIN_NAME="termihub-rdp-helper.exe" ;;
    *) BIN_NAME="termihub-rdp-helper" ;;
    esac
    CARGO_FLAGS+=(--target "$TARGET")
    BIN_PATH="rdp-sidecar/target/${TARGET}/${PROFILE}/${BIN_NAME}"
else
    BIN_NAME="termihub-rdp-helper"
    case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN* | Windows_NT) BIN_NAME="termihub-rdp-helper.exe" ;;
    esac
    BIN_PATH="rdp-sidecar/target/${PROFILE}/${BIN_NAME}"
fi

echo "=== Building RDP sidecar (${PROFILE}${TARGET:+, ${TARGET}}) ==="
# The excluded crate is built by pointing cargo at its own manifest.
cargo build --manifest-path rdp-sidecar/Cargo.toml "${CARGO_FLAGS[@]}"

if [ ! -f "$BIN_PATH" ]; then
    echo "ERROR: expected binary not found at $BIN_PATH" >&2
    exit 1
fi
echo "Built: $BIN_PATH"

if [ "$EXTERNALBIN" -eq 1 ]; then
    STAGE_DIR="src-tauri/binaries"
    # Tauri appends -<triple> and (on Windows) .exe; it strips the triple at
    # bundle time, leaving `termihub-rdp-helper[.exe]` next to the app binary.
    case "$TARGET" in
    *windows*) STAGE_NAME="termihub-rdp-helper-${TARGET}.exe" ;;
    *) STAGE_NAME="termihub-rdp-helper-${TARGET}" ;;
    esac
    mkdir -p "$STAGE_DIR"
    cp "$BIN_PATH" "$STAGE_DIR/$STAGE_NAME"
    echo "Staged for Tauri externalBin: $STAGE_DIR/$STAGE_NAME"

    # Compute the sidecar's SHA-256 (#1762). `core/build.rs` hashes this exact
    # staged binary to embed the expected digest the adapter checks before spawn,
    # so this is purely for transparency/local verification: it prints the digest
    # and writes a `.sha256` sidecar next to the staged binary. Tauri `externalBin`
    # only picks the exact `termihub-rdp-helper-<triple>[.exe]` name, so the extra
    # `.sha256` file is ignored by the bundler.
    if command -v sha256sum >/dev/null 2>&1; then
        DIGEST="$(sha256sum "$STAGE_DIR/$STAGE_NAME" | cut -d' ' -f1)"
    else
        # macOS has no sha256sum; `shasum -a 256` is the BSD equivalent.
        DIGEST="$(shasum -a 256 "$STAGE_DIR/$STAGE_NAME" | cut -d' ' -f1)"
    fi
    printf '%s  %s\n' "$DIGEST" "$STAGE_NAME" >"$STAGE_DIR/$STAGE_NAME.sha256"
    echo "SHA-256: $DIGEST"
    echo "Wrote checksum sidecar: $STAGE_DIR/$STAGE_NAME.sha256"
fi

if [ -n "$OUT_DIR" ]; then
    mkdir -p "$OUT_DIR"
    cp "$BIN_PATH" "$OUT_DIR/"
    echo "Copied to: $OUT_DIR/${BIN_NAME}"
    echo "Point termiHub at it by placing it next to the desktop binary, or set:"
    echo "  export TERMIHUB_RDP_HELPER=\"$OUT_DIR/${BIN_NAME}\""
fi
