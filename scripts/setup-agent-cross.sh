#!/usr/bin/env bash
# Install toolchains needed to cross-compile the remote agent for Linux
# targets (static musl binaries). Run once before using build-agents.sh.
#
# Native targets (macOS *-apple-darwin, Windows *-pc-windows-msvc) do NOT use
# this script: they are built with native cargo (build-agents.sh --native) and
# only need the platform's own toolchain — Xcode CLT on macOS, the MSVC build
# tools (Visual Studio Build Tools) on Windows.
#
# cross-rs is installed at the ONE version pinned in .github/cross-version, the
# same release CI installs through .github/actions/setup-cross (#4360, #4731):
# the SHA256-verified release tarball on x86_64 Linux hosts, otherwise
# `cargo install cross --locked --git ... --tag v<version>`.
#
# Usage: ./scripts/setup-agent-cross.sh [--dry-run] [--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# The cross-rs pin (version + x86_64 Linux tarball SHA256); see
# docs/contributing.md -> "cross-rs version".
CROSS_PIN_FILE="$REPO_ROOT/.github/cross-version"
CROSS_GIT_URL="https://github.com/cross-rs/cross"

DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --help | -h)
            cat <<'USAGE'
Usage: setup-agent-cross.sh [--dry-run]

Installs the cross-compilation toolchains required by build-agents.sh.

Not needed for native targets: macOS (*-apple-darwin) and Windows
(*-pc-windows-msvc) agents are built with `build-agents.sh --native` and only
require the platform's native toolchain (Xcode CLT / MSVC build tools).

All platforms:
  - cross-rs at the version pinned in .github/cross-version (same as CI):
    the SHA256-verified release tarball on x86_64 Linux, otherwise
    `cargo install cross --locked --git ... --tag v<version>`
  - Verifies Docker or Podman is available
  - Rust targets for both architectures
  - Builds custom cross-rs Docker images with the system LLD linker

Options:
  --dry-run   Resolve the pinned cross-rs version, print how it would be
              installed, and exit without changing anything

Prerequisites:
  - Rust toolchain (rustup)
  - Docker or Podman (required for cross-rs)
  - Set CROSS_CONTAINER_ENGINE=podman to use Podman with cross-rs
USAGE
            exit 0
            ;;
        --dry-run) DRY_RUN=1 ;;
        *)
            echo "Unknown argument: $1 (see --help)" >&2
            exit 2
            ;;
    esac
    shift
done
# Paths below (agent/docker) are repo-relative, as in setup-agent-cross.cmd.
cd "$REPO_ROOT"

# --- Resolve the pinned cross-rs release ---
if [ ! -f "$CROSS_PIN_FILE" ]; then
    echo "ERROR: cross-rs pin file not found: $CROSS_PIN_FILE" >&2
    exit 1
fi
CROSS_VERSION="$(sed -n 's/^version=//p' "$CROSS_PIN_FILE" | tr -d '[:space:]')"
CROSS_SHA256="$(sed -n 's/^sha256=//p' "$CROSS_PIN_FILE" | tr -d '[:space:]')"
if ! [[ "$CROSS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    ! [[ "$CROSS_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: missing or malformed cross-rs pin in $CROSS_PIN_FILE" >&2
    exit 1
fi

# The pinned SHA256 is for the x86_64 Linux tarball only; every other host
# builds the same tag from source.
if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
    CROSS_INSTALL_METHOD=tarball
else
    CROSS_INSTALL_METHOD=cargo
fi

# The version of the cross on PATH ("cross 0.2.5 (...)" -> 0.2.5), or empty.
installed_cross_version() {
    if command -v cross >/dev/null 2>&1; then
        cross --version 2>/dev/null | sed -n '1s/^cross \([0-9][0-9.]*\).*/\1/p'
    fi
}

install_cross_tarball() {
    local bin_dir tmp url
    bin_dir="${CARGO_HOME:-$HOME/.cargo}/bin"
    mkdir -p "$bin_dir"
    tmp="$(mktemp -d)"
    url="$CROSS_GIT_URL/releases/download/v${CROSS_VERSION}/cross-x86_64-unknown-linux-gnu.tar.gz"
    echo "  Downloading cross-rs v$CROSS_VERSION (SHA256-verified) into $bin_dir"
    curl -fsSL --retry 3 "$url" -o "$tmp/cross.tar.gz"
    if ! echo "${CROSS_SHA256}  $tmp/cross.tar.gz" | sha256sum -c - >/dev/null; then
        rm -rf "$tmp"
        echo "  ERROR: SHA256 mismatch for $url" >&2
        exit 1
    fi
    tar xzf "$tmp/cross.tar.gz" -C "$bin_dir"
    rm -rf "$tmp"
}

install_cross_cargo() {
    echo "  Building cross-rs v$CROSS_VERSION from source via cargo..."
    cargo install cross --locked --git "$CROSS_GIT_URL" --tag "v$CROSS_VERSION"
}

if [ "$DRY_RUN" -eq 1 ]; then
    installed="$(installed_cross_version)"
    echo "=== Agent Cross-Compilation Setup (dry run) ==="
    echo "  Pinned cross-rs: v$CROSS_VERSION (from .github/cross-version)"
    echo "  Installed cross: ${installed:-none}"
    if [ "$CROSS_INSTALL_METHOD" = tarball ]; then
        echo "  Install method:  SHA256-verified release tarball (x86_64 Linux)"
    else
        echo "  Install method:  cargo install cross --locked --git $CROSS_GIT_URL --tag v$CROSS_VERSION"
    fi
    echo "  Nothing was changed."
    exit 0
fi

TARGETS=(
    x86_64-unknown-linux-musl
    aarch64-unknown-linux-musl
    armv7-unknown-linux-musleabihf
)

echo "=== Agent Cross-Compilation Setup ==="
echo ""

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
    installed="$(installed_cross_version)"
    echo "  cross is already installed: v${installed:-unknown} (pinned: v$CROSS_VERSION)"
    if [ "$installed" != "$CROSS_VERSION" ]; then
        echo "  WARNING: the installed cross differs from .github/cross-version, so local"
        echo "  agent builds may not match CI. Remove it (cargo uninstall cross) and re-run."
    fi
elif [ "$CROSS_INSTALL_METHOD" = tarball ]; then
    install_cross_tarball
else
    install_cross_cargo
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
    echo "  Images extend ghcr.io/cross-rs/<target>:main with the system LLD linker."
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
