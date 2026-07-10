#!/usr/bin/env bash
# Build the remote agent (termihub-agent) for Linux, macOS, and Windows targets.
# Linux targets use cross-rs (static musl). macOS and Windows targets use native
# cargo. Multiple targets are built in parallel by default, each in its own
# CARGO_TARGET_DIR to avoid cargo's workspace build lock.
#
# Build-host strategy
# -------------------
# - Linux musl targets: cross-rs (Docker/Podman) from any host.
# - macOS targets: native cargo, must run on a Mac (--native).
# - Windows MSVC targets (*-pc-windows-msvc): native cargo, must run on a Windows
#   host with the MSVC toolchain (Visual Studio Build Tools) installed. cross-rs
#   does NOT support the MSVC ABI, so these cannot be built via Docker/Podman.
#   Requesting a Windows target on a non-Windows host (or without --native) fails
#   fast with a clear message. Windows binaries are emitted as `termihub-agent.exe`
#   (CI renames artifacts to termihub-agent-windows-x64 / -windows-arm64).
#
# Usage: ./scripts/build-agents.sh [--targets <list>] [--sequential] [--native] [--dev] [--help]
#
# Run ./scripts/setup-agent-cross.sh first for Linux cross-compilation
# (not needed for --native, macOS, or Windows native builds).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# --- Helpers ---
# True if the target triple is a Windows MSVC target.
is_windows_target() {
    case "$1" in
    *-pc-windows-msvc) return 0 ;;
    *) return 1 ;;
    esac
}

# Binary file name cargo emits for a target (Windows appends .exe).
agent_binary_name() {
    if is_windows_target "$1"; then
        echo "termihub-agent.exe"
    else
        echo "termihub-agent"
    fi
}

# Write a "<binary>.sha256" sidecar next to a built binary, matching the format
# published by release.yml so the desktop can verify integrity before install
# (#1350). Uses sha256sum where available (Linux, Git Bash) and falls back to
# `shasum -a 256` (macOS). Runs in the binary's directory so the sidecar records
# a bare file name rather than a full path.
write_checksum() {
    local binary="$1"
    local dir base
    dir="$(dirname "$binary")"
    base="$(basename "$binary")"
    (
        cd "$dir" || exit 1
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum "$base" >"$base.sha256"
        elif command -v shasum >/dev/null 2>&1; then
            shasum -a 256 "$base" >"$base.sha256"
        else
            echo "  WARNING: no sha256sum/shasum found; skipping checksum for $base" >&2
            return 1
        fi
    )
}

# True if the current host is Windows (Git Bash / MSYS / Cygwin).
host_is_windows() {
    case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) return 0 ;;
    *) return 1 ;;
    esac
}

# --- Defaults ---
ALL_TARGETS=(
    x86_64-unknown-linux-musl
    aarch64-unknown-linux-musl
    armv7-unknown-linux-musleabihf
)
SELECTED_TARGETS=()
SEQUENTIAL=false
NATIVE=false
DEV=false

# --- Argument parsing ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --targets)
            shift
            IFS=',' read -ra SELECTED_TARGETS <<< "$1"
            shift
            ;;
        --sequential)
            SEQUENTIAL=true
            shift
            ;;
        --native)
            NATIVE=true
            shift
            ;;
        --dev)
            DEV=true
            shift
            ;;
        --help|-h)
            cat <<'USAGE'
Usage: build-agents.sh [OPTIONS]

Build the remote agent for Linux, macOS, and Windows targets.
Linux builds use cross-rs (static musl). macOS and Windows use native cargo.
Multiple targets are built in parallel by default.

Options:
  --targets <list>   Comma-separated list of targets to build (default: all Linux
                     targets in cross-rs mode; host triple in --native mode)
  --sequential       Build targets one at a time (useful for debugging)
  --native           Build using the local cargo toolchain instead of cross-rs/Docker.
                     Defaults to the host target triple. Faster for local development;
                     no container runtime required. Required for macOS and Windows targets.
  --dev              Build in debug profile (omits --release). Much faster to compile;
                     binary lands in target/<triple>/debug/ instead of release/.
  --help, -h         Show this help message

Linux targets (cross-rs mode, require setup-agent-cross.sh):
  x86_64-unknown-linux-musl       Static x64 binaries (musl)
  aarch64-unknown-linux-musl      Static ARM64 binaries (musl)
  armv7-unknown-linux-musleabihf  Static ARMv7 binaries (musl, older Raspberry Pi)

macOS targets (--native only, build on a Mac):
  aarch64-apple-darwin            Apple Silicon (M1/M2/M3/M4)
  x86_64-apple-darwin             Intel Mac

Windows targets (--native only, build on a Windows host with MSVC tools):
  x86_64-pc-windows-msvc          Windows x64 (emits termihub-agent.exe)
  aarch64-pc-windows-msvc         Windows ARM64 (best effort — requires the
                                  ARM64 MSVC build tools to be installed)

Examples:
  ./scripts/build-agents.sh                                   # all Linux targets
  ./scripts/build-agents.sh --targets aarch64-unknown-linux-musl
  ./scripts/build-agents.sh --sequential
  ./scripts/build-agents.sh --native --dev                    # current host (fast)
  ./scripts/build-agents.sh --native --targets aarch64-apple-darwin  # macOS ARM64
  ./scripts/build-agents.sh --native --targets x86_64-pc-windows-msvc  # Windows x64
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
    if [ "$NATIVE" = true ]; then
        host_triple=$(rustc -vV 2>/dev/null | awk '/^host:/{print $2}')
        if [ -z "$host_triple" ]; then
            echo "ERROR: Could not determine host target triple from rustc."
            exit 1
        fi
        SELECTED_TARGETS=("$host_triple")
    else
        SELECTED_TARGETS=("${ALL_TARGETS[@]}")
    fi
fi

# --- Windows target validation ---
# MSVC targets cannot be built via cross-rs (no MSVC ABI support) and require a
# Windows host with the MSVC toolchain. Fail fast with a clear message instead of
# letting cargo/cross emit a confusing linker error.
for target in "${SELECTED_TARGETS[@]}"; do
    if is_windows_target "$target"; then
        if [ "$NATIVE" = false ]; then
            echo "ERROR: Windows target '$target' requires --native."
            echo "  cross-rs cannot build MSVC targets. Re-run on a Windows host with --native."
            exit 1
        fi
        if ! host_is_windows; then
            echo "ERROR: Windows target '$target' can only be built on a Windows host."
            echo "  Current host: $(uname -s). Build Windows agents on a Windows runner."
            exit 1
        fi
    fi
done

# --- Profile setup ---
if [ "$DEV" = true ]; then
    PROFILE_FLAG=""
    PROFILE_DIR="debug"
else
    PROFILE_FLAG="--release"
    PROFILE_DIR="release"
fi

# --- Detect cross-rs (skipped for --native) ---
if [ "$NATIVE" = false ]; then
    if ! command -v cross >/dev/null 2>&1; then
        echo "ERROR: cross-rs not found. Run ./scripts/setup-agent-cross.sh first."
        exit 1
    fi
fi

# --- Container engine detection (skipped for --native) ---
# Auto-detect which engine to use, preferring the one that already has the
# required cross-compilation images.  If Podman is selected, disable cross-rs
# rootless handling — without CROSS_ROOTLESS_CONTAINER_ENGINE=false, cross-rs
# adds --user UID:GID to the `podman run` command which makes the injected
# cargo/rustc toolchain non-executable inside the container ("Permission denied").
if [ "$NATIVE" = true ]; then
    : # No container engine needed
elif [ "${CROSS_CONTAINER_ENGINE:-}" = "podman" ]; then
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

# --- Pre-flight: verify required images exist in the selected engine (skipped for --native) ---
if [ "$NATIVE" = false ]; then
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
fi

# --- Ensure the Rust std for each requested target is installed ---
# Needed in both modes: cross-rs Linux targets and native macOS/Windows targets
# (e.g. cross-compiling aarch64-pc-windows-msvc from an x64 Windows host).
_installed_targets=$(rustup target list --installed)
for target in "${SELECTED_TARGETS[@]}"; do
    if ! grep -q "^${target}$" <<<"$_installed_targets"; then
        echo "  Adding Rust target $target..."
        rustup target add "$target"
    fi
done
unset _installed_targets

# --- Build ---
built=0
failed=0
results=()

if [ "$SEQUENTIAL" = true ] || [ "${#SELECTED_TARGETS[@]}" -le 1 ]; then
    # ------------------------------------------------------------------ #
    # Sequential build                                                     #
    # ------------------------------------------------------------------ #
    echo "=== Building agent for ${#SELECTED_TARGETS[@]} target(s) ==="
    echo ""

    for target in "${SELECTED_TARGETS[@]}"; do
        echo "--- $target ---"

        build_exit=0
        if [ "$NATIVE" = true ]; then
            echo "  Building with cargo (native)..."
            # shellcheck disable=SC2086
            cargo build $PROFILE_FLAG --target "$target" -p termihub-agent 2>&1 \
                | { grep -v "<jemalloc>:" || true; } \
                || build_exit=$?
        else
            echo "  Building with cross-rs..."
            # shellcheck disable=SC2086
            CROSS_CONFIG=agent/Cross.toml cross build $PROFILE_FLAG --target "$target" -p termihub-agent 2>&1 \
                | { grep -v "<jemalloc>:" || true; } \
                || build_exit=$?
        fi

        if [ "$build_exit" -eq 0 ]; then
            binary="target/$target/$PROFILE_DIR/$(agent_binary_name "$target")"
            if [ -f "$binary" ]; then
                size=$(du -h "$binary" | cut -f1)
                write_checksum "$binary" || true
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

else
    # ------------------------------------------------------------------ #
    # Parallel build                                                       #
    #                                                                      #
    # Each target gets its own CARGO_TARGET_DIR so the builds don't       #
    # contend on the workspace-level cargo build lock (target/.cargo-lock) #
    # and can run in truly separate Docker containers simultaneously.      #
    # Binaries are copied to target/<target>/release/ when done.          #
    # ------------------------------------------------------------------ #
    echo "=== Building agent for ${#SELECTED_TARGETS[@]} target(s) in parallel ==="
    echo ""

    # Parallel indexed arrays (bash 3.2 compatible — no declare -A needed).
    # Index i matches SELECTED_TARGETS[i] throughout.
    _pids=()
    _cross_dirs=()
    _exit_codes=()

    for i in "${!SELECTED_TARGETS[@]}"; do
        target="${SELECTED_TARGETS[$i]}"
        cross_dir="target/cross/$target"
        _cross_dirs[$i]=$cross_dir

        # Stream output live with a [target] prefix so interleaved lines from
        # concurrent builds are identifiable. A single awk replaces the former
        # grep|sed two-stage pipe: when grep's stdout is a pipe (not a terminal)
        # it switches to full block buffering, silencing output until the buffer
        # fills. awk with fflush() flushes after every line regardless of whether
        # stdout is a terminal or a pipe, keeping output immediate.
        # The subshell inherits pipefail so cross's/cargo's exit code propagates
        # through the awk stage to the background job's exit status.
        {
            if [ "$NATIVE" = true ]; then
                # shellcheck disable=SC2086
                CARGO_TARGET_DIR="$cross_dir" \
                    cargo build $PROFILE_FLAG --target "$target" -p termihub-agent 2>&1
            else
                # shellcheck disable=SC2086
                CARGO_TARGET_DIR="$cross_dir" CROSS_CONFIG=agent/Cross.toml \
                    cross build $PROFILE_FLAG --target "$target" -p termihub-agent 2>&1
            fi \
                | awk -v prefix="[$target] " '
                    {
                        # \r in the stream is cargo'\''s in-place progress marker.
                        # Replace with \n to split the record into visual segments,
                        # then restore the in-place behaviour per segment type.
                        gsub(/\r/, "\n")
                        n = split($0, segs, "\n")
                        for (i = 1; i <= n; i++) {
                            seg = segs[i]
                            if (seg == "") continue
                            # Strip jemalloc text fused with cargo progress
                            p = index(seg, "<jemalloc>:")
                            if (p > 0) seg = substr(seg, 1, p - 1)
                            sub(/[[:space:]]+$/, "", seg)
                            if (seg == "") continue
                            # Progress lines (NNN: or NNN/NNN: crates…) overwrite
                            # in place; everything else is a permanent new line.
                            if (seg ~ /^[[:space:]]*[0-9]+(\/[0-9]+)?: /) {
                                printf "\r%s%s", prefix, seg
                            } else {
                                printf "\r%s%s\n", prefix, seg
                            }
                            fflush()
                        }
                    }
                '
        } &

        _pids[$i]=$!
        echo "  $target: building... (PID ${_pids[$i]})"
    done
    echo ""

    # Wait for every build to finish and collect its exit code.
    # By waiting in order we don't suppress streaming output from still-running
    # targets — their output continues flowing while we block on an earlier wait.
    for i in "${!SELECTED_TARGETS[@]}"; do
        _exit_codes[$i]=0
        wait "${_pids[$i]}" || _exit_codes[$i]=$?
    done
    echo ""

    # All builds finished — print clean per-target results with no streaming mix.
    for i in "${!SELECTED_TARGETS[@]}"; do
        target="${SELECTED_TARGETS[$i]}"
        echo "--- $target ---"

        if [ "${_exit_codes[$i]}" -eq 0 ]; then
            cross_dir="${_cross_dirs[$i]}"
            binary_name="$(agent_binary_name "$target")"
            src_binary="$cross_dir/$target/$PROFILE_DIR/$binary_name"
            dst_dir="target/$target/$PROFILE_DIR"
            dst_binary="$dst_dir/$binary_name"

            if [ -f "$src_binary" ]; then
                mkdir -p "$dst_dir"
                cp "$src_binary" "$dst_binary"
                size=$(du -h "$dst_binary" | cut -f1)
                write_checksum "$dst_binary" || true
                results+=("  OK    $target  ($size)")
                echo "  -> $dst_binary ($size)"
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
fi

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
