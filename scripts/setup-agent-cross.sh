#!/usr/bin/env bash
# Install toolchains needed to cross-compile the remote agent for Linux
# targets (static musl binaries). Run once before using build-agents.sh.
#
# Usage: ./scripts/setup-agent-cross.sh [--help]
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'USAGE'
Usage: setup-agent-cross.sh

Installs the cross-compilation toolchains required by build-agents.sh.

All platforms:
  - cross-rs (via cargo install) for all targets
  - Verifies Docker or Podman is available
  - Rust targets for both architectures
  - Builds custom cross-rs Docker images with libudev-dev

Prerequisites:
  - Rust toolchain (rustup)
  - Docker or Podman (required for cross-rs)
  - Set CROSS_CONTAINER_ENGINE=podman to use Podman with cross-rs
USAGE
    exit 0
fi

TARGETS=(
    x86_64-unknown-linux-musl
    aarch64-unknown-linux-musl
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

# --- Install cross-rs ---
echo "--- Installing cross-rs ---"
if command -v cross >/dev/null 2>&1; then
    echo "  cross is already installed: $(cross --version 2>/dev/null || echo 'unknown version')"
else
    echo "  Installing cross via cargo..."
    cargo install cross --git https://github.com/cross-rs/cross
fi

echo ""
echo "--- Checking container runtime ---"
if command -v docker >/dev/null 2>&1; then
    echo "  Docker found: $(docker --version)"
    if ! docker info >/dev/null 2>&1; then
        echo "  WARNING: Docker daemon is not running. Start Docker Desktop before building."
    fi
elif command -v podman >/dev/null 2>&1; then
    echo "  Podman found: $(podman --version)"
    export CROSS_CONTAINER_ENGINE=podman
    echo "  Using Podman for cross-rs (CROSS_CONTAINER_ENGINE=podman)"
else
    echo "  ERROR: Neither Docker nor Podman found. cross-rs requires a container runtime."
    echo "  Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    echo "  Or Podman Desktop: https://podman-desktop.io/"
    exit 1
fi

# --- Build custom cross-rs images ---
# Detect which container command is available.
CONTAINER_CMD=""
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    CONTAINER_CMD=docker
elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    CONTAINER_CMD=podman
fi

if [ -n "$CONTAINER_CMD" ]; then
    echo ""
    echo "--- Building custom cross-rs images ---"
    echo "  Images extend ghcr.io/cross-rs/<target>:main with libudev-dev for serialport."
    echo ""

    build_failed=0
    for target in "${TARGETS[@]}"; do
        echo "  localhost/termihub-cross:$target ..."
        if "$CONTAINER_CMD" build \
            -t "localhost/termihub-cross:$target" \
            -f "agent/docker/Dockerfile.$target" \
            agent/docker; then
            echo "  OK"
        else
            echo "  FAILED: localhost/termihub-cross:$target"
            build_failed=$((build_failed + 1))
        fi
        echo ""
    done

    if [ "$build_failed" -gt 0 ]; then
        echo "ERROR: $build_failed image(s) failed to build. Resolve the errors above and retry."
        exit 1
    fi
else
    echo ""
    echo "WARNING: No running container runtime found — skipping custom image build."
    echo "  Start Docker or Podman and re-run this script before running build-agents.sh."
fi

echo ""
echo "=== Setup complete ==="
echo "Run ./scripts/build-agents.sh to cross-compile the agent."
