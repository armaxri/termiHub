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
#                                    [--target <triple>]... [--sign <key>]
#        ./scripts/package-plugin.sh --merge <pkg> --merge <pkg>... [--out <dir>] [--sign <key>]
#   <plugin-source-dir>   Directory containing manifest.json (required unless --merge).
#   --out <dir>           Output directory for the package (default: ./dist).
#   --no-build            Do not build a backend crate; package the tree as-is
#                         (any `backend/` directory is copied verbatim).
#   --target <triple>     Build the backend for this Rust target triple and stage
#                         it as backend/<triple>/ (multi-platform format). Repeat
#                         for several targets; `host` means this machine's triple.
#   --merge <pkg>         Merge per-platform packages (each built with --target)
#                         into one multi-platform package. Repeat per input.
#   --sign <key-file>     After packaging, sign the package with a keypair from
#                         `termihub-plugin-keygen` (writes signature.json).
#
# See docs/plugin-authoring.md for the manifest schema, signing, and the ABI caveat.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

SOURCE=""
OUT_DIR="dist"
BUILD=1
SIGN_KEY=""
TARGETS=()
MERGE_INPUTS=()

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
    --target)
        TARGETS+=("${2:?--target requires a target triple (or 'host')}")
        shift 2
        ;;
    --merge)
        MERGE_INPUTS+=("${2:?--merge requires a package path}")
        shift 2
        ;;
    --sign)
        SIGN_KEY="${2:?--sign requires a key file}"
        shift 2
        ;;
    --help | -h)
        sed -n '2,26p' "$0"
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

# Sign the package whose path follows "Created " in the packer output ($1).
sign_created() {
    if [ -n "$SIGN_KEY" ]; then
        local pkg_path="${1#Created }"
        echo "=== Signing ($SIGN_KEY) ==="
        cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-sign -- \
            --key "$SIGN_KEY" "$pkg_path"
    fi
}

# --- Merge mode: combine per-platform packages into one fat package. ---
if [ "${#MERGE_INPUTS[@]}" -gt 0 ]; then
    if [ -n "$SOURCE" ] || [ "${#TARGETS[@]}" -gt 0 ]; then
        echo "ERROR: --merge cannot be combined with a source directory or --target" >&2
        exit 2
    fi
    MERGE_ARGS=()
    for pkg in "${MERGE_INPUTS[@]}"; do
        MERGE_ARGS+=(--merge "$pkg")
    done
    echo "=== Merging ${#MERGE_INPUTS[@]} package(s) ==="
    PACK_OUT="$(cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-pack -- \
        "${MERGE_ARGS[@]}" --out "$OUT_DIR")"
    echo "$PACK_OUT"
    cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-pack -- \
        --inspect "${PACK_OUT#Created }"
    sign_created "$PACK_OUT"
    exit 0
fi

if [ -z "$SOURCE" ]; then
    echo "ERROR: no plugin source directory given" >&2
    sed -n '11,24p' "$0" >&2
    exit 2
fi
if [ ! -f "$SOURCE/manifest.json" ]; then
    echo "ERROR: $SOURCE has no manifest.json" >&2
    exit 1
fi
if [ "${#TARGETS[@]}" -gt 0 ] && { [ "$BUILD" -eq 0 ] || [ ! -f "$SOURCE/Cargo.toml" ]; }; then
    echo "ERROR: --target builds a backend crate; it needs a Cargo.toml and no --no-build" >&2
    echo "       (a pre-built backend/<triple>/ tree is packaged as-is with --no-build)" >&2
    exit 2
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

# The cdylib file name for a target triple ($2; empty = this OS) given the
# crate's library base name ($1), following each platform's naming convention.
dylib_name() {
    local base="$1" triple="$2"
    if [ -z "$triple" ]; then
        case "$(uname -s)" in
        Darwin) triple="apple" ;;
        MINGW* | MSYS* | CYGWIN* | Windows_NT) triple="windows" ;;
        *) triple="linux" ;;
        esac
    fi
    case "$triple" in
    *windows*) echo "${base}.dll" ;;
    *apple* | *darwin*) echo "lib${base}.dylib" ;;
    *) echo "lib${base}.so" ;;
    esac
}

# Find a built library ($1) under the workspace or the crate's own target dir,
# in the release profile sub-directory $2 (`release` or `<triple>/release`).
find_built() {
    local name="$1" profile_dir="$2" d
    for d in "$ROOT/target/$profile_dir" "$SOURCE/target/$profile_dir"; do
        if [ -f "$d/$name" ]; then
            echo "$d/$name"
            return 0
        fi
    done
    echo "ERROR: built library $name not found under target/$profile_dir" >&2
    return 1
}

if [ "$BUILD" -eq 1 ] && [ -f "$SOURCE/Cargo.toml" ]; then
    # Predict the cdylib file name from the crate's [lib] name (or package name),
    # then apply the platform's dynamic-library naming convention.
    LIB_NAME="$(sed -n 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$SOURCE/Cargo.toml" | head -1)"
    LIB_BASE="${LIB_NAME//-/_}"

    # Stage a clean tree: manifest + optional README + themes/frontend + the
    # freshly built library (or libraries) under backend/.
    CLEANUP="$(mktemp -d)"
    STAGE="$CLEANUP"
    cp "$SOURCE/manifest.json" "$STAGE/"
    [ -f "$SOURCE/README.md" ] && cp "$SOURCE/README.md" "$STAGE/"
    for sub in themes frontend; do
        [ -d "$SOURCE/$sub" ] && cp -R "$SOURCE/$sub" "$STAGE/$sub"
    done
    mkdir -p "$STAGE/backend"

    if [ "${#TARGETS[@]}" -eq 0 ]; then
        # Legacy single-platform package: this OS's library, flat in backend/.
        echo "=== Building backend crate ($SOURCE) ==="
        cargo build --release --manifest-path "$SOURCE/Cargo.toml"
        DYLIB="$(dylib_name "$LIB_BASE" "")"
        BUILT="$(find_built "$DYLIB" release)"
        cp "$BUILT" "$STAGE/backend/$DYLIB"
        echo "Staged backend library: backend/$DYLIB"
    else
        # Multi-platform package: one backend/<triple>/ directory per target.
        # The packer derives the manifest `libraries` map from this tree.
        for TRIPLE in "${TARGETS[@]}"; do
            if [ "$TRIPLE" = "host" ]; then
                TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
            fi
            echo "=== Building backend crate ($SOURCE) for $TRIPLE ==="
            cargo build --release --manifest-path "$SOURCE/Cargo.toml" --target "$TRIPLE"
            DYLIB="$(dylib_name "$LIB_BASE" "$TRIPLE")"
            BUILT="$(find_built "$DYLIB" "$TRIPLE/release")"
            mkdir -p "$STAGE/backend/$TRIPLE"
            cp "$BUILT" "$STAGE/backend/$TRIPLE/$DYLIB"
            echo "Staged backend library: backend/$TRIPLE/$DYLIB"
        done
    fi
fi

echo "=== Packaging ==="
PACK_OUT="$(cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-pack -- \
    --source "$STAGE" --out "$OUT_DIR")"
echo "$PACK_OUT"
sign_created "$PACK_OUT"
