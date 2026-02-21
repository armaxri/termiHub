#!/usr/bin/env bash
# Install toolchains needed to cross-compile the remote agent for 6 Linux
# targets. Run once before using build-agents.sh.
#
# Usage: ./scripts/setup-agent-cross.sh [--help]
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'USAGE'
Usage: setup-agent-cross.sh

Installs the cross-compilation toolchains required by build-agents.sh.

Linux (Debian/Ubuntu):
  - Native cross-compilers (gcc-aarch64-linux-gnu, gcc-arm-linux-gnueabihf)
  - Multi-arch libudev-dev for gnu targets
  - cross-rs (via cargo install) for musl targets
  - Rust targets for all 6 architectures

macOS:
  - cross-rs (via cargo install) for all targets
  - Verifies Docker is available
  - Rust targets for all 6 architectures

Prerequisites:
  - Rust toolchain (rustup)
  - Docker (required for cross-rs on all platforms; also used for musl
    targets on Linux)
USAGE
    exit 0
fi

TARGETS=(
    x86_64-unknown-linux-gnu
    aarch64-unknown-linux-gnu
    armv7-unknown-linux-gnueabihf
    x86_64-unknown-linux-musl
    aarch64-unknown-linux-musl
    armv7-unknown-linux-musleabihf
)

echo "=== Agent Cross-Compilation Setup ==="
echo ""

OS="$(uname -s)"

# --- Add Rust targets ---
echo "--- Adding Rust targets ---"
for target in "${TARGETS[@]}"; do
    if rustup target list --installed | grep -q "^${target}$"; then
        echo "  $target (already installed)"
    else
        echo "  Adding $target..."
        rustup target add "$target"
    fi
done
echo ""

if [ "$OS" = "Linux" ]; then
    echo "--- Installing native cross-compilers (requires sudo) ---"
    echo "  Adding architectures for multi-arch libudev-dev..."
    sudo dpkg --add-architecture arm64 2>/dev/null || true
    sudo dpkg --add-architecture armhf 2>/dev/null || true

    sudo apt-get update -qq

    sudo apt-get install -y \
        gcc-aarch64-linux-gnu \
        gcc-arm-linux-gnueabihf \
        libudev-dev \
        libudev-dev:arm64 \
        libudev-dev:armhf \
        pkg-config
    echo ""

    echo "--- Installing cross-rs (for musl targets) ---"
    if command -v cross >/dev/null 2>&1; then
        echo "  cross is already installed: $(cross --version 2>/dev/null || echo 'unknown version')"
    else
        echo "  Installing cross via cargo..."
        cargo install cross --git https://github.com/cross-rs/cross
    fi

    echo ""
    echo "--- Checking Docker ---"
    if command -v docker >/dev/null 2>&1; then
        echo "  Docker found: $(docker --version)"
    else
        echo "  WARNING: Docker not found. cross-rs needs Docker for musl targets."
        echo "  Install Docker: https://docs.docker.com/engine/install/"
    fi

elif [ "$OS" = "Darwin" ]; then
    echo "--- Installing cross-rs (all targets use Docker on macOS) ---"
    if command -v cross >/dev/null 2>&1; then
        echo "  cross is already installed: $(cross --version 2>/dev/null || echo 'unknown version')"
    else
        echo "  Installing cross via cargo..."
        cargo install cross --git https://github.com/cross-rs/cross
    fi

    echo ""
    echo "--- Checking Docker ---"
    if command -v docker >/dev/null 2>&1; then
        echo "  Docker found: $(docker --version)"
        if ! docker info >/dev/null 2>&1; then
            echo "  WARNING: Docker daemon is not running. Start Docker Desktop before building."
        fi
    else
        echo "  ERROR: Docker not found. cross-rs requires Docker on macOS."
        echo "  Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
        exit 1
    fi

else
    echo "Unsupported OS: $OS"
    echo "Use setup-agent-cross.cmd on Windows."
    exit 1
fi

echo ""
echo "=== Setup complete ==="
echo "Run ./scripts/build-agents.sh to cross-compile the agent."
