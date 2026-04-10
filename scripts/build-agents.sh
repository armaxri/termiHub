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

# --- Container engine detection ---
# Auto-detect which engine to use, preferring the one that already has the
# required cross-compilation images.  If Podman is selected, disable cross-rs
# rootless handling — without CROSS_ROOTLESS_CONTAINER_ENGINE=false, cross-rs
# adds --user UID:GID to the `podman run` command which makes the injected
# cargo/rustc toolchain non-executable inside the container ("Permission denied").
if [ "${CROSS_CONTAINER_ENGINE:-}" = "podman" ]; then
    # Explicit override: use Podman
    export CROSS_ROOTLESS_CONTAINER_ENGINE=false
elif [ -z "${CROSS_CONTAINER_ENGINE:-}" ]; then
    docker_running=false
    podman_running=false
    docker info >/dev/null 2>&1 && docker_running=true || true
    command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1 && podman_running=true || true

    if ! $docker_running && ! $podman_running; then
        echo "ERROR: No running container runtime found (Docker or Podman)."
        echo "  cross-rs requires Docker or Podman. Start one and re-run."
        exit 1
    elif ! $docker_running && $podman_running; then
        export CROSS_CONTAINER_ENGINE=podman
        export CROSS_ROOTLESS_CONTAINER_ENGINE=false
    elif $docker_running && $podman_running; then
        # Both available — prefer the engine that already has the required images
        images_in_docker=0
        images_in_podman=0
        for _t in "${SELECTED_TARGETS[@]}"; do
            docker image inspect "localhost/termihub-cross:$_t" >/dev/null 2>&1 \
                && images_in_docker=$((images_in_docker + 1)) || true
            podman image inspect "localhost/termihub-cross:$_t" >/dev/null 2>&1 \
                && images_in_podman=$((images_in_podman + 1)) || true
        done
        if [ "$images_in_podman" -gt "$images_in_docker" ]; then
            export CROSS_CONTAINER_ENGINE=podman
            export CROSS_ROOTLESS_CONTAINER_ENGINE=false
        fi
        # else: Docker is running and has the images (or neither does — checked below)
    fi
    # else: only Docker is running — use it (default, no override needed)
fi

# --- Pre-flight: verify required images exist in the selected engine ---
_container_cmd="${CROSS_CONTAINER_ENGINE:-docker}"
_missing_images=()
for _t in "${SELECTED_TARGETS[@]}"; do
    if ! "$_container_cmd" image inspect "localhost/termihub-cross:$_t" >/dev/null 2>&1; then
        _missing_images+=("localhost/termihub-cross:$_t")
    fi
done
if [ "${#_missing_images[@]}" -gt 0 ]; then
    echo "ERROR: The following cross-compilation image(s) are missing from $_container_cmd:"
    for _img in "${_missing_images[@]}"; do
        echo "  $_img"
    done
    echo ""
    echo "Run ./scripts/setup-agent-cross.sh to build the required images, then retry."
    exit 1
fi
unset _container_cmd _missing_images _t _img

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
    # Pipe through grep to suppress the jemalloc/QEMU noise printed when running
    # amd64 containers under emulation (Apple Silicon, Raspberry Pi, etc.).
    # The { ... || true; } group always exits 0 so that pipefail only triggers
    # on a non-zero exit from cross itself, not from grep filtering all lines.
    if CROSS_CONFIG=agent/Cross.toml cross build --release --target "$target" -p termihub-agent 2>&1 \
        | { grep -v "^<jemalloc>" || true; }; then
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
