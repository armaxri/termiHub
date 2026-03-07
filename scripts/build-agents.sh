#!/usr/bin/env bash
# Cross-compile the remote agent (termihub-agent) for Linux targets (musl, static).
# Uses cross-rs for all targets.
#
# Usage: ./scripts/build-agents.sh [--targets <list>] [--help]
#
# Run ./scripts/setup-agent-cross.sh first to install required toolchains.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# --- Defaults ---
ALL_TARGETS=(
    x86_64-unknown-linux-musl
    aarch64-unknown-linux-musl
)
SELECTED_TARGETS=()

# --- Argument parsing ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --targets)
            shift
            IFS=',' read -ra SELECTED_TARGETS <<< "$1"
            shift
            ;;
        --help|-h)
            cat <<'USAGE'
Usage: build-agents.sh [OPTIONS]

Cross-compile the remote agent for Linux targets (static musl binaries).

Options:
  --targets <list>   Comma-separated list of targets to build (default: all)
  --help, -h         Show this help message

Targets:
  x86_64-unknown-linux-musl       Static x64 binaries (musl)
  aarch64-unknown-linux-musl      Static ARM64 binaries (musl)

Examples:
  ./scripts/build-agents.sh
  ./scripts/build-agents.sh --targets aarch64-unknown-linux-musl
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

# --- Detect cross-rs ---
if ! command -v cross >/dev/null 2>&1; then
    echo "ERROR: cross-rs not found. Run ./scripts/setup-agent-cross.sh first."
    exit 1
fi

# If Podman is the container engine (explicit override or auto-detected), disable
# cross-rs rootless handling.  Without this, cross-rs adds --user UID:GID to the
# podman run command which causes the injected cargo/rustc toolchain to be
# non-executable inside the container ("Permission denied").
if [ "${CROSS_CONTAINER_ENGINE:-}" = "podman" ] || \
   ( [ -z "${CROSS_CONTAINER_ENGINE:-}" ] && ! docker info >/dev/null 2>&1 && podman info >/dev/null 2>&1 ); then
    export CROSS_CONTAINER_ENGINE=podman
    export CROSS_ROOTLESS_CONTAINER_ENGINE=false
fi

# --- Build ---
echo "=== Building agent for ${#SELECTED_TARGETS[@]} target(s) ==="
echo ""

built=0
failed=0
results=()

for target in "${SELECTED_TARGETS[@]}"; do
    echo "--- $target ---"

    # Ensure Rust target is installed
    if ! rustup target list --installed | grep -q "^${target}$"; then
        echo "  Adding Rust target $target..."
        rustup target add "$target"
    fi

    echo "  Building with cross-rs..."
    if CROSS_CONFIG=agent/Cross.toml cross build --release --target "$target" -p termihub-agent 2>&1; then
        binary="target/$target/release/termihub-agent"
        if [ -f "$binary" ]; then
            size=$(du -h "$binary" | cut -f1)
            results+=("  OK    $target  ($size)")
            echo "  -> $binary ($size)"
            built=$((built + 1))
        else
            results+=("  FAIL  $target  (binary not found)")
            echo "  FAILED: binary not found"
            failed=$((failed + 1))
        fi
    else
        results+=("  FAIL  $target")
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
echo "Built: $built | Failed: $failed"

if [ "$failed" -gt 0 ]; then
    exit 1
fi
