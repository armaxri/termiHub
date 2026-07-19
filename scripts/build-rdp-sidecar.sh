#!/usr/bin/env bash
# Build the RDP sidecar (termihub-rdp-helper) for the host platform.
#
# The sidecar (#1747) is a workspace-EXCLUDED crate with its own Cargo.lock:
# IronRDP's CredSSP crypto and russh pin incompatible RustCrypto pre-releases,
# and Cargo allows one version per crate per lockfile (#1725). It therefore
# builds as its own cargo unit, separate from the main workspace build.
#
# Unlike the remote agent (scripts/build-agents.sh), the sidecar runs on the
# SAME machine as termiHub, so only a native host build is needed. Cross-target
# release bundling (Tauri externalBin + CI matrix) is a sequenced follow-up.
#
# Usage: ./scripts/build-rdp-sidecar.sh [--release] [--out <dir>] [--help]
#   --release     Build with optimizations (default: debug).
#   --out <dir>   After building, copy the binary into <dir> (e.g. next to the
#                 desktop binary, or the Tauri resources dir). The app resolves
#                 the helper next to its own executable, or via $TERMIHUB_RDP_HELPER.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PROFILE="debug"
CARGO_FLAGS=()
OUT_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
    --release)
        PROFILE="release"
        CARGO_FLAGS+=(--release)
        shift
        ;;
    --out)
        OUT_DIR="${2:?--out requires a directory}"
        shift 2
        ;;
    --help | -h)
        sed -n '2,20p' "$0"
        exit 0
        ;;
    *)
        echo "Unknown argument: $1" >&2
        exit 2
        ;;
    esac
done

BIN_NAME="termihub-rdp-helper"
case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN* | Windows_NT) BIN_NAME="termihub-rdp-helper.exe" ;;
esac

echo "=== Building RDP sidecar (${PROFILE}) ==="
# The excluded crate is built by pointing cargo at its own manifest.
cargo build --manifest-path rdp-sidecar/Cargo.toml "${CARGO_FLAGS[@]}"

BIN_PATH="rdp-sidecar/target/${PROFILE}/${BIN_NAME}"
if [ ! -f "$BIN_PATH" ]; then
    echo "ERROR: expected binary not found at $BIN_PATH" >&2
    exit 1
fi
echo "Built: $BIN_PATH"

if [ -n "$OUT_DIR" ]; then
    mkdir -p "$OUT_DIR"
    cp "$BIN_PATH" "$OUT_DIR/"
    echo "Copied to: $OUT_DIR/${BIN_NAME}"
    echo "Point termiHub at it by placing it next to the desktop binary, or set:"
    echo "  export TERMIHUB_RDP_HELPER=\"$OUT_DIR/${BIN_NAME}\""
fi
