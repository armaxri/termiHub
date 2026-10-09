#!/usr/bin/env bash
# Build the plugin runner (termihub-plugin-runner) and optionally stage it for Tauri.
#
# The runner (#4182) is the out-of-process host for native plugin backends. It
# is a workspace member, but ships like the RDP sidecar: NEXT TO the desktop
# binary via Tauri `externalBin` (#4202). The app resolves it next to its own
# executable (debug builds: also $TERMIHUB_PLUGIN_RUNNER or target/<profile>/).
#
# Usage: ./scripts/build-plugin-runner.sh [--release] [--locked] [--target <triple>]
#                                         [--tauri-externalbin] [--out <dir>]
#   --release             Build with optimizations (default: debug).
#   --locked              Pass --locked to cargo: fail instead of updating a
#                         stale Cargo.lock (release builds use it, #4282).
#   --target <triple>     Cross-build for a specific Rust target triple (e.g.
#                         x86_64-apple-darwin). Default: the host triple. Output
#                         lands under target/<triple>/<profile>/.
#   --tauri-externalbin   Stage the built binary into src-tauri/binaries/ named
#                         `termihub-plugin-runner-<triple>[.exe]`, the layout
#                         Tauri `externalBin` expects, plus a .sha256 file.
#                         core/build.rs embeds that file's SHA-256, which the
#                         app checks before spawning the bundled runner. macOS:
#                         ad-hoc signed first, under its installed name, so the
#                         release re-sign leaves the bytes (and digest) as is.
#                         Linux: RUNPATH set to $ORIGIN/../lib first (needs
#                         patchelf), so the AppImage bundler leaves it as is.
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
    --locked)
        CARGO_FLAGS+=(--locked)
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
        sed -n '2,27p' "$0"
        exit 0
        ;;
    *)
        echo "Unknown argument: $1" >&2
        exit 2
        ;;
    esac
done

# `externalBin` staging needs a concrete triple for the filename suffix, so
# resolve the host triple when none was given.
if [ "$EXTERNALBIN" -eq 1 ] && [ -z "$TARGET" ]; then
    TARGET="$(rustc -vV | sed -n 's/^host: //p')"
    if [ -z "$TARGET" ]; then
        echo "ERROR: could not determine host target triple from 'rustc -vV'" >&2
        exit 1
    fi
fi

TARGET_DIR="${CARGO_TARGET_DIR:-target}"
# The `.exe` suffix and cargo output dir depend on the *target*, not the host.
if [ -n "$TARGET" ]; then
    case "$TARGET" in
    *windows*) BIN_NAME="termihub-plugin-runner.exe" ;;
    *) BIN_NAME="termihub-plugin-runner" ;;
    esac
    CARGO_FLAGS+=(--target "$TARGET")
    # Windows MSVC: link the Visual C++ runtime statically (#4172), so the runner
    # shipped in the installer needs no VC++ redistributable, like termihub.exe
    # (src-tauri/build.rs) and the RDP helper. With an explicit --target,
    # RUSTFLAGS reach only the target's crates, never build scripts or proc macros.
    case "$TARGET" in
    *-windows-msvc) export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-feature=+crt-static" ;;
    esac
    BIN_PATH="${TARGET_DIR}/${TARGET}/${PROFILE}/${BIN_NAME}"
else
    BIN_NAME="termihub-plugin-runner"
    case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN* | Windows_NT) BIN_NAME="termihub-plugin-runner.exe" ;;
    esac
    BIN_PATH="${TARGET_DIR}/${PROFILE}/${BIN_NAME}"
fi

echo "=== Building plugin runner (${PROFILE}${TARGET:+, ${TARGET}}) ==="
cargo build -p termihub-plugin-runner --bin termihub-plugin-runner "${CARGO_FLAGS[@]}"

if [ ! -f "$BIN_PATH" ]; then
    echo "ERROR: expected binary not found at $BIN_PATH" >&2
    exit 1
fi
echo "Built: $BIN_PATH"

if [ "$EXTERNALBIN" -eq 1 ]; then
    STAGE_DIR="src-tauri/binaries"
    # Tauri appends -<triple> and (on Windows) .exe; it strips the triple at
    # bundle time, leaving `termihub-plugin-runner[.exe]` next to the app binary.
    case "$TARGET" in
    *windows*) STAGE_NAME="termihub-plugin-runner-${TARGET}.exe" ;;
    *) STAGE_NAME="termihub-plugin-runner-${TARGET}" ;;
    esac
    mkdir -p "$STAGE_DIR"

    case "$TARGET" in
    *-apple-darwin)
        # The macOS release re-signs every Mach-O in the bundle ad hoc
        # (release.yml / dev-build.yml), which rewrites the signature and so the
        # file's SHA-256. An ad-hoc signature derives its identifier from the
        # file name, and re-signing the same code under the same name is
        # byte-identical, so sign it here under its installed name: the bytes
        # Tauri bundles, the digest core/build.rs embeds and the re-signed file
        # in the .app then all match.
        if command -v codesign >/dev/null 2>&1; then
            SIGN_DIR="$(mktemp -d)"
            cp "$BIN_PATH" "$SIGN_DIR/termihub-plugin-runner"
            codesign -s - --force "$SIGN_DIR/termihub-plugin-runner"
            cp "$SIGN_DIR/termihub-plugin-runner" "$STAGE_DIR/$STAGE_NAME"
            rm -rf "$SIGN_DIR"
            echo "Ad-hoc signed as termihub-plugin-runner"
        else
            echo "WARNING: codesign not found; staging the runner unsigned. A macOS" >&2
            echo "  bundle re-signed later will not match the embedded digest." >&2
            cp "$BIN_PATH" "$STAGE_DIR/$STAGE_NAME"
        fi
        ;;
    *-linux-*)
        # The AppImage bundler (Tauri's linuxdeploy) runs
        # `patchelf --set-rpath '$ORIGIN/../lib'` on every ELF in usr/bin,
        # which rewrites the file and so its SHA-256: the runner in the
        # AppImage would no longer match the digest core/build.rs embedded,
        # and the app would refuse it as tampered (#4243). patchelf leaves a
        # file whose RUNPATH already has that exact value untouched (no
        # write), so set it here: the bytes the .deb/.rpm/AppImage ship and
        # the digest core/build.rs embeds then all match. Outside an AppImage
        # it resolves to /usr/lib (or a missing target/<triple>/lib), adding
        # no search path the loader would not use anyway.
        cp "$BIN_PATH" "$STAGE_DIR/$STAGE_NAME"
        if command -v patchelf >/dev/null 2>&1; then
            LINUXDEPLOY_RPATH="\$ORIGIN/../lib" # literal; ld.so expands it
            patchelf --set-rpath "$LINUXDEPLOY_RPATH" "$STAGE_DIR/$STAGE_NAME"
            if [ "$(patchelf --print-rpath "$STAGE_DIR/$STAGE_NAME")" != "$LINUXDEPLOY_RPATH" ]; then
                echo "ERROR: failed to set RUNPATH $LINUXDEPLOY_RPATH on $STAGE_DIR/$STAGE_NAME" >&2
                exit 1
            fi
            echo "Set RUNPATH $LINUXDEPLOY_RPATH (as the AppImage bundler would)"
        else
            echo "WARNING: patchelf not found; staging the runner without the AppImage" >&2
            echo "  RUNPATH. An AppImage bundled later will not match the embedded digest." >&2
        fi
        ;;
    *)
        cp "$BIN_PATH" "$STAGE_DIR/$STAGE_NAME"
        ;;
    esac
    echo "Staged for Tauri externalBin: $STAGE_DIR/$STAGE_NAME"

    # For transparency/local verification only: core/build.rs hashes the staged
    # binary itself. Tauri `externalBin` only picks the exact
    # `termihub-plugin-runner-<triple>[.exe]` name, so this file is not bundled.
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
    echo "Point a debug termiHub at it by placing it next to the desktop binary, or set:"
    echo "  export TERMIHUB_PLUGIN_RUNNER=\"$OUT_DIR/${BIN_NAME}\""
fi
