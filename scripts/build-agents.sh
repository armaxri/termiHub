#!/usr/bin/env bash
# Cross-compile the remote agent (termihub-agent) for up to 6 Linux targets.
# Tries native toolchains first (Linux gnu targets), falls back to cross-rs.
#
# Usage: ./scripts/build-agents.sh [--targets <list>] [--cross-only] [--help]
#
# Run ./scripts/setup-agent-cross.sh first to install required toolchains.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# --- Defaults ---
ALL_TARGETS=(
    x86_64-unknown-linux-gnu
    aarch64-unknown-linux-gnu
    armv7-unknown-linux-gnueabihf
    x86_64-unknown-linux-musl
    aarch64-unknown-linux-musl
    armv7-unknown-linux-musleabihf
)
SELECTED_TARGETS=()
CROSS_ONLY=false

# --- Argument parsing ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --targets)
            shift
            IFS=',' read -ra SELECTED_TARGETS <<< "$1"
            shift
            ;;
        --cross-only)
            CROSS_ONLY=true
            shift
            ;;
        --help|-h)
            cat <<'USAGE'
Usage: build-agents.sh [OPTIONS]

Cross-compile the remote agent for Linux targets.

Options:
  --targets <list>   Comma-separated list of targets to build (default: all 6)
  --cross-only       Skip native toolchains, always use cross-rs
  --help, -h         Show this help message

Targets:
  x86_64-unknown-linux-gnu        Standard x64 servers (glibc)
  aarch64-unknown-linux-gnu       Raspberry Pi 3/4/5, ARM servers (glibc)
  armv7-unknown-linux-gnueabihf   Raspberry Pi 2, older ARM (glibc)
  x86_64-unknown-linux-musl       Static x64 binaries (musl)
  aarch64-unknown-linux-musl      Static ARM64 binaries (musl)
  armv7-unknown-linux-musleabihf  Static ARMv7 binaries (musl)

Examples:
  ./scripts/build-agents.sh
  ./scripts/build-agents.sh --targets aarch64-unknown-linux-gnu,armv7-unknown-linux-gnueabihf
  ./scripts/build-agents.sh --cross-only
USAGE
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage information."
            exit 1
            ;;
    esac
done

if [ ${#SELECTED_TARGETS[@]} -eq 0 ]; then
    SELECTED_TARGETS=("${ALL_TARGETS[@]}")
fi

# --- Detect host ---
OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
HAS_CROSS=false
if command -v cross >/dev/null 2>&1; then
    HAS_CROSS=true
fi

# --- Linker lookup for native builds ---
# Maps target triples to their GCC cross-compiler name.
get_native_linker() {
    local target="$1"
    case "$target" in
        x86_64-unknown-linux-gnu)
            # Native on x86_64 Linux — no cross-linker needed
            if [ "$OS" = "Linux" ] && [ "$HOST_ARCH" = "x86_64" ]; then
                echo "native"
            else
                echo ""
            fi
            ;;
        aarch64-unknown-linux-gnu)
            if [ "$OS" = "Linux" ] && command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then
                echo "aarch64-linux-gnu-gcc"
            else
                echo ""
            fi
            ;;
        armv7-unknown-linux-gnueabihf)
            if [ "$OS" = "Linux" ] && command -v arm-linux-gnueabihf-gcc >/dev/null 2>&1; then
                echo "arm-linux-gnueabihf-gcc"
            else
                echo ""
            fi
            ;;
        *)
            # musl targets — no native toolchain; always needs cross-rs
            echo ""
            ;;
    esac
}

# --- Build ---
echo "=== Building agent for ${#SELECTED_TARGETS[@]} target(s) ==="
echo ""

built=0
skipped=0
failed=0
results=()

for target in "${SELECTED_TARGETS[@]}"; do
    echo "--- $target ---"

    # Ensure Rust target is installed
    if ! rustup target list --installed | grep -q "^${target}$"; then
        echo "  Adding Rust target $target..."
        rustup target add "$target"
    fi

    method=""
    success=false

    # Try native toolchain first (Linux gnu targets only)
    if [ "$CROSS_ONLY" = false ]; then
        linker="$(get_native_linker "$target")"
        if [ -n "$linker" ]; then
            method="native"
            echo "  Building with native toolchain..."

            linker_env="CARGO_TARGET_$(echo "$target" | tr '[:lower:]' '[:upper:]' | tr '-' '_')_LINKER"

            if [ "$linker" = "native" ]; then
                # Host-native target — no cross-linker needed
                if cargo build --release --target "$target" -p termihub-agent 2>&1; then
                    success=true
                fi
            else
                if env "$linker_env=$linker" \
                    PKG_CONFIG_SYSROOT_DIR="/usr/$( echo "$linker" | sed 's/-gcc$//' )" \
                    cargo build --release --target "$target" -p termihub-agent 2>&1; then
                    success=true
                fi
            fi
        fi
    fi

    # Fall back to cross-rs
    if [ "$success" = false ] && [ "$HAS_CROSS" = true ]; then
        if [ -n "$method" ]; then
            echo "  Native build failed, falling back to cross-rs..."
        else
            echo "  Building with cross-rs..."
        fi
        method="cross"

        if cross build --release --target "$target" -p termihub-agent 2>&1; then
            success=true
        fi
    fi

    # Record result
    binary="target/$target/release/termihub-agent"
    if [ "$success" = true ] && [ -f "$binary" ]; then
        size=$(du -h "$binary" | cut -f1)
        results+=("  OK    $target  ($method, $size)")
        echo "  -> $binary ($size)"
        built=$((built + 1))
    elif [ -z "$method" ]; then
        results+=("  SKIP  $target  (no toolchain available)")
        echo "  Skipped: no native toolchain or cross-rs available"
        skipped=$((skipped + 1))
    else
        results+=("  FAIL  $target  ($method)")
        echo "  FAILED"
        failed=$((failed + 1))
    fi
    echo ""
done

# --- Summary ---
echo "=== Summary ==="
echo ""
for line in "${results[@]}"; do
    echo "$line"
done
echo ""
echo "Built: $built | Skipped: $skipped | Failed: $failed"

if [ "$failed" -gt 0 ]; then
    exit 1
fi
