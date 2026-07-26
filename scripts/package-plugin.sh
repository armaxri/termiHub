#!/usr/bin/env bash
# Package a plugin source directory into a validated `.termihub-plugin` archive.
#
# The heavy lifting (manifest validation, zipping the concept §1 layout, and
# round-trip validating the result) is done by the `termihub-plugin-pack` binary
# in termihub-core. This wrapper adds the one thing that binary deliberately does
# NOT do: if the source is a Rust backend crate (`Cargo.toml` present), it builds
# the `cdylib` in `--release`, stages the compiled library into a temporary
# `backend/` directory alongside the manifest, and packages that staged tree.
#
# Usage: ./scripts/package-plugin.sh <plugin-source-dir> [--out <dir>] [--no-build]
#   <plugin-source-dir>   Directory containing manifest.json (required).
#   --out <dir>           Output directory for the package (default: ./dist).
#   --no-build            Do not build a backend crate; package the tree as-is
#                         (any `backend/` directory is copied verbatim).
#
# See docs/plugin-authoring.md for the manifest schema and the ABI caveat.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

SOURCE=""
OUT_DIR="dist"
BUILD=1

while [ $# -gt 0 ]; do
    case "$1" in
    --out)
        OUT_DIR="${2:?--out requires a directory}"
        shift 2
        ;;
    --no-build)
        BUILD=0
        shift
        ;;
    --help | -h)
        sed -n '2,18p' "$0"
        exit 0
        ;;
    -*)
        echo "Unknown argument: $1" >&2
        exit 2
        ;;
    *)
        if [ -n "$SOURCE" ]; then
            echo "Unexpected extra argument: $1" >&2
            exit 2
        fi
        SOURCE="$1"
        shift
        ;;
    esac
done

if [ -z "$SOURCE" ]; then
    echo "ERROR: no plugin source directory given" >&2
    sed -n '10,18p' "$0" >&2
    exit 2
fi
if [ ! -f "$SOURCE/manifest.json" ]; then
    echo "ERROR: $SOURCE has no manifest.json" >&2
    exit 1
fi

# The directory actually handed to the packer. For a backend crate we stage a
# clean copy into a tempdir; otherwise we package the source tree directly.
STAGE="$SOURCE"
CLEANUP=""
# An `if` (not `&&`) so the handler always ends with status 0 — a bare `&&` that
# short-circuits would leak status 1 out as the script's exit code under an EXIT
# trap.
cleanup() {
    if [ -n "$CLEANUP" ]; then
        rm -rf "$CLEANUP"
    fi
}
trap cleanup EXIT

if [ "$BUILD" -eq 1 ] && [ -f "$SOURCE/Cargo.toml" ]; then
    echo "=== Building backend crate ($SOURCE) ==="
    cargo build --release --manifest-path "$SOURCE/Cargo.toml"

    # Predict the cdylib file name from the crate's [lib] name (or package name),
    # then apply the platform's dynamic-library naming convention.
    LIB_NAME="$(sed -n 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$SOURCE/Cargo.toml" | head -1)"
    LIB_BASE="${LIB_NAME//-/_}"
    case "$(uname -s)" in
    Darwin) DYLIB="lib${LIB_BASE}.dylib" ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT) DYLIB="${LIB_BASE}.dll" ;;
    *) DYLIB="lib${LIB_BASE}.so" ;;
    esac

    # A workspace-member crate builds into the workspace target/; a standalone
    # crate builds next to its own manifest. Check both.
    BUILT=""
    for d in "$ROOT/target/release" "$SOURCE/target/release"; do
        if [ -f "$d/$DYLIB" ]; then
            BUILT="$d/$DYLIB"
            break
        fi
    done
    if [ -z "$BUILT" ]; then
        echo "ERROR: built library $DYLIB not found under target/release" >&2
        exit 1
    fi

    # Stage a clean tree: manifest + optional README + themes/frontend + the
    # freshly built library under backend/.
    CLEANUP="$(mktemp -d)"
    STAGE="$CLEANUP"
    cp "$SOURCE/manifest.json" "$STAGE/"
    [ -f "$SOURCE/README.md" ] && cp "$SOURCE/README.md" "$STAGE/"
    for sub in themes frontend; do
        [ -d "$SOURCE/$sub" ] && cp -R "$SOURCE/$sub" "$STAGE/$sub"
    done
    mkdir -p "$STAGE/backend"
    cp "$BUILT" "$STAGE/backend/$DYLIB"
    echo "Staged backend library: backend/$DYLIB"
fi

echo "=== Packaging ==="
cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-pack -- \
    --source "$STAGE" --out "$OUT_DIR"
