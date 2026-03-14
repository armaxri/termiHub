#!/usr/bin/env bash
# Per-machine system test orchestration for Windows (via WSL or Git Bash).
#
# This script:
#   1. Detects the execution environment (WSL, Git Bash, MSYS2)
#   2. Checks prerequisites (Docker/Podman, cargo, pnpm, tauri-driver)
#   3. Starts container test infrastructure (Docker Desktop or Podman)
#   4. Runs unit tests (frontend + backend + agent)
#   5. Runs Rust integration tests against containers
#   6. Runs E2E tests via tauri-driver (if available)
#   7. Tears down containers (unless --keep-infra)
#
# Note: Virtual serial ports (socat) are NOT available on Windows/WSL.
#
# Podman on Windows — known limitations:
#   Building test images requires Docker BuildKit's 'additional_contexts'
#   feature. With Docker Desktop this works out of the box. With Podman on
#   Windows, 'docker-compose.exe' requires 'docker buildx' (only available
#   with Docker Desktop) for BuildKit; without it the image build fails.
#   Workaround: use --skip-integration and run unit tests only, or use Docker
#   Desktop, or pre-build images on Linux and import them into Podman.
#   Integration test coverage for these scenarios is provided by the Linux CI.
#
# Usage:
#   ./scripts/test-system-windows.sh [OPTIONS]
#
# Options:
#   --skip-build         Skip cargo/pnpm build steps
#   --skip-unit          Skip unit tests (run integration tests only)
#   --skip-serial        No-op on Windows (serial ports not available; accepted
#                        for compatibility with cross-platform invocations)
#   --skip-e2e           Skip E2E tests
#   --skip-integration   Skip Rust integration tests (no containers needed);
#                        use when container image build is unavailable (Podman)
#   --with-fault         Include network fault injection tests (profile: fault)
#   --with-stress        Include SFTP stress tests (profile: stress)
#   --with-all           Include all profiles (fault + stress)
#   --keep-infra         Keep Docker/Podman containers running after tests
#   --help, -h           Show this help message
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ─── Parse arguments ────────────────────────────────────────────────────────

SKIP_BUILD=0
SKIP_UNIT=0
SKIP_INTEGRATION=0
SKIP_E2E=0
WITH_FAULT=0
WITH_STRESS=0
KEEP_INFRA=0

for arg in "$@"; do
    case "$arg" in
        --skip-build)        SKIP_BUILD=1 ;;
        --skip-unit)         SKIP_UNIT=1 ;;
        --skip-serial)       ;;  # No-op on Windows — serial ports are always unavailable
        --skip-integration)  SKIP_INTEGRATION=1 ;;
        --skip-e2e)          SKIP_E2E=1 ;;
        --with-fault)        WITH_FAULT=1 ;;
        --with-stress)       WITH_STRESS=1 ;;
        --with-all)          WITH_FAULT=1; WITH_STRESS=1 ;;
        --keep-infra)        KEEP_INFRA=1 ;;
        --help|-h)
            echo "Usage: ./scripts/test-system-windows.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --skip-build         Skip cargo/pnpm build steps"
            echo "  --skip-unit          Skip unit tests (integration only)"
            echo "  --skip-serial        No-op on Windows (serial ports not available)"
            echo "  --skip-integration   Skip Rust integration tests (no containers needed)"
            echo "  --skip-e2e           Skip E2E tests"
            echo "  --with-fault         Include network fault injection tests"
            echo "  --with-stress        Include SFTP stress tests"
            echo "  --with-all           Include all test profiles"
            echo "  --keep-infra         Keep Docker/Podman containers after tests"
            echo "  --help, -h           Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Run with --help for usage information."
            exit 1
            ;;
    esac
done

# ─── Detect environment ─────────────────────────────────────────────────────

IS_WSL=0

if grep -qEi "(Microsoft|WSL)" /proc/version 2>/dev/null; then
    IS_WSL=1
fi

# ─── Detect container runtime ───────────────────────────────────────────────
# Allow override via env: CONTAINER_CMD=podman ./scripts/test-system-windows.sh
#
# Detection order:
#   1. docker (Docker Desktop running)
#   2. docker.exe (WSL only — Docker Desktop socket bridged into WSL)
#   3. podman / podman.exe (Podman Desktop running)
#   4. fallback to "docker" — will produce a clear error below

if [ -z "${CONTAINER_CMD:-}" ]; then
    if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
        CONTAINER_CMD="docker"
    elif [ "$IS_WSL" -eq 1 ] && command -v docker.exe &>/dev/null; then
        CONTAINER_CMD="docker.exe"
    elif command -v podman &>/dev/null && podman info &>/dev/null 2>&1; then
        CONTAINER_CMD="podman"
    elif command -v podman.exe &>/dev/null && podman.exe info &>/dev/null 2>&1; then
        # podman.exe reachable from Git Bash when Podman Desktop is installed and
        # the Podman Machine is running, but 'podman' (without .exe) is not in PATH
        CONTAINER_CMD="podman.exe"
    elif command -v podman &>/dev/null || command -v podman.exe &>/dev/null; then
        # Podman is installed but its machine is not running
        echo "ERROR: Podman is installed but the Podman Machine is not running."
        echo ""
        echo "Start it with:"
        echo "  podman machine start"
        echo ""
        echo "Then re-run this script."
        exit 1
    elif command -v docker &>/dev/null; then
        # Docker is installed but the daemon is not running
        echo "ERROR: Docker is installed but the daemon is not running."
        echo "Please start Docker Desktop: https://www.docker.com/products/docker-desktop/"
        exit 1
    else
        echo "ERROR: No container runtime found."
        echo "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
        echo "  or Podman Desktop: https://podman-desktop.io/"
        exit 1
    fi
fi

# ─── Detect Podman + BuildKit capability ────────────────────────────────────
# The docker-compose.yml uses 'additional_contexts', which requires BuildKit.
# Docker Compose (docker-compose.exe) v2 needs 'docker buildx' for BuildKit.
# With Podman on Windows (no Docker Desktop), 'docker buildx' is unavailable,
# so image builds will fail.  We detect this upfront and auto-skip integration
# tests with a clear explanation, rather than letting compose fail mid-run.
#
# Detection logic:
#   IS_PODMAN=1  when CONTAINER_CMD is podman or podman.exe
#   HAS_BUILDX=1 when 'docker buildx version' succeeds (Docker Desktop present)
#   PODMAN_NO_BUILDKIT=1 when Podman is in use AND docker buildx is absent

IS_PODMAN=0
if [[ "$CONTAINER_CMD" == podman* ]]; then
    IS_PODMAN=1
fi

HAS_BUILDX=0
if command -v docker &>/dev/null && docker buildx version &>/dev/null 2>&1; then
    HAS_BUILDX=1
elif command -v docker.exe &>/dev/null && docker.exe buildx version &>/dev/null 2>&1; then
    HAS_BUILDX=1
fi

PODMAN_NO_BUILDKIT=0
if [ "$IS_PODMAN" -eq 1 ] && [ "$HAS_BUILDX" -eq 0 ]; then
    PODMAN_NO_BUILDKIT=1
fi

# ─── Detect compose sub-command ─────────────────────────────────────────────
# Docker Compose v2 uses "docker compose" (space, not hyphen).
# Podman uses the same pattern: "podman compose".
# Verify compose is available before attempting to start containers.

if ! $CONTAINER_CMD compose version &>/dev/null 2>&1; then
    echo "ERROR: '$CONTAINER_CMD compose' is not available."
    echo ""
    if [[ "$CONTAINER_CMD" == podman* ]]; then
        echo "Podman requires Docker Compose CLI to be installed for 'podman compose'."
        echo "  Install Docker Compose: https://docs.docker.com/compose/install/"
        echo "  Or upgrade Podman Desktop, which bundles Docker Compose."
    else
        echo "Docker Compose v2 plugin is missing."
        echo "Install Docker Desktop (includes Compose v2): https://www.docker.com/products/docker-desktop/"
    fi
    exit 1
fi

# ─── Cleanup trap ───────────────────────────────────────────────────────────

DOCKER_STARTED=0
COMPOSE_ARGS=""

cleanup() {
    echo ""
    echo "=== Cleanup ==="

    if [ "$DOCKER_STARTED" -eq 1 ] && [ "$KEEP_INFRA" -eq 0 ]; then
        echo "Stopping containers..."
        $CONTAINER_CMD compose -f tests/docker/docker-compose.yml $COMPOSE_ARGS down 2>/dev/null || true
    elif [ "$KEEP_INFRA" -eq 1 ]; then
        echo "Keeping containers running (--keep-infra)."
        echo "Stop manually with: $CONTAINER_CMD compose -f tests/docker/docker-compose.yml $COMPOSE_ARGS down"
    fi

    echo "Cleanup complete."
}

trap cleanup EXIT

# ─── Check prerequisites ────────────────────────────────────────────────────

echo "=== Windows System Test Orchestration ==="
echo ""

if [ "$IS_WSL" -eq 1 ]; then
    echo "Running inside WSL."
else
    echo "Running in Git Bash / MSYS2."
fi

echo ""
echo "Checking prerequisites..."

MISSING=0
HAS_TAURI_DRIVER=0

# Container runtime: validate the detected/provided runtime
if ! command -v "$CONTAINER_CMD" &>/dev/null; then
    echo "  MISSING: $CONTAINER_CMD — install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    echo "           or Podman Desktop: https://podman-desktop.io/"
    MISSING=1
fi

if [ "$MISSING" -eq 0 ] && ! $CONTAINER_CMD info &>/dev/null 2>&1; then
    echo "  ERROR: $CONTAINER_CMD daemon is not running. Please start Docker Desktop or Podman Desktop."
    MISSING=1
fi

if ! command -v cargo &>/dev/null; then
    echo "  MISSING: cargo — install Rust: https://rustup.rs/"
    MISSING=1
fi

if ! command -v pnpm &>/dev/null; then
    echo "  MISSING: pnpm — install with: npm install -g pnpm"
    MISSING=1
fi

if command -v tauri-driver &>/dev/null; then
    HAS_TAURI_DRIVER=1
    echo "  tauri-driver: found"
else
    echo "  tauri-driver: not found (E2E tests will be skipped)"
fi

if [ "$MISSING" -ne 0 ]; then
    echo ""
    echo "Install the missing prerequisites and try again."
    exit 1
fi

echo "  All required prerequisites found."

# ─── Detect WSL distributions ───────────────────────────────────────────────

echo ""
echo "=== Environment Detection ==="

if [ "$IS_WSL" -eq 1 ]; then
    echo "  WSL environment detected."
    # List installed distributions
    if command -v wsl.exe &>/dev/null; then
        echo "  WSL distributions:"
        wsl.exe --list --quiet 2>/dev/null | while IFS= read -r line; do
            # Filter out empty lines
            cleaned=$(echo "$line" | tr -d '\r' | xargs)
            if [ -n "$cleaned" ]; then
                echo "    - $cleaned"
            fi
        done
    fi
else
    echo "  Not running in WSL."
fi

echo "  Serial ports: NOT AVAILABLE (socat not supported on Windows)"

# ─── Ensure node_modules ────────────────────────────────────────────────────

if [ ! -d node_modules ]; then
    echo ""
    echo "node_modules missing, running pnpm install..."
    pnpm install
fi

# ─── Build the app (for E2E) ────────────────────────────────────────────────

APP_BINARY="./target/release/termihub.exe"

if [ "$HAS_TAURI_DRIVER" -eq 1 ] && [ "$SKIP_E2E" -eq 0 ]; then
    if [ "$SKIP_BUILD" -eq 0 ]; then
        echo ""
        echo "=== Building termiHub (needed for E2E) ==="
        pnpm tauri build
    elif [ ! -f "$APP_BINARY" ]; then
        echo ""
        echo "WARNING: App binary not found at $APP_BINARY"
        echo "E2E tests will be skipped. Build with: pnpm tauri build"
        HAS_TAURI_DRIVER=0
    else
        echo ""
        echo "=== Skipping build (--skip-build), using existing binary ==="
    fi
fi

# ─── Start Docker containers (skipped with --skip-integration) ──────────────

# Auto-skip integration when Podman is in use but docker buildx is unavailable.
# The docker-compose.yml images use 'additional_contexts' which requires BuildKit;
# docker-compose.exe v2 (the Podman compose provider on Windows) needs 'docker
# buildx' for BuildKit, which is only present with Docker Desktop.
if [ "$SKIP_INTEGRATION" -eq 0 ] && [ "$PODMAN_NO_BUILDKIT" -eq 1 ]; then
    echo ""
    echo "=== Podman on Windows: integration tests auto-skipped ==="
    echo ""
    echo "  Reason: The test container images require BuildKit's 'additional_contexts'"
    echo "          feature. Docker Compose (docker-compose.exe) v2 delegates builds"
    echo "          to 'docker buildx', which is only available with Docker Desktop."
    echo "          Podman Desktop alone does not provide 'docker buildx'."
    echo ""
    echo "  Impact: SSH / telnet / monitoring integration tests will not run."
    echo "          Unit tests (frontend + backend + agent) will still run."
    echo ""
    echo "  Full integration test coverage is provided by Linux CI (GitHub Actions)."
    echo "  To suppress this message, pass --skip-integration explicitly."
    echo ""
    SKIP_INTEGRATION=1
fi

if [ "$SKIP_INTEGRATION" -eq 0 ]; then
    echo ""
    echo "=== Starting container test infrastructure ==="

    # Ensure BuildKit is enabled.  The docker-compose.exe that Podman delegates to
    # may use the legacy builder by default; DOCKER_BUILDKIT=1 activates BuildKit
    # which is required for 'additional_contexts' in docker-compose.yml.
    export DOCKER_BUILDKIT=1

    # Build compose args for profiles
    if [ "$WITH_FAULT" -eq 1 ] && [ "$WITH_STRESS" -eq 1 ]; then
        COMPOSE_ARGS="--profile all"
    elif [ "$WITH_FAULT" -eq 1 ]; then
        COMPOSE_ARGS="--profile fault"
    elif [ "$WITH_STRESS" -eq 1 ]; then
        COMPOSE_ARGS="--profile stress"
    fi

    $CONTAINER_CMD compose -f tests/docker/docker-compose.yml $COMPOSE_ARGS up -d --build
    DOCKER_STARTED=1

    # Wait for core SSH container
    echo "Waiting for SSH containers to be ready..."
    MAX_WAIT=60
    WAITED=0
    # Use different connectivity check depending on available tools
    CHECK_CMD="nc -z 127.0.0.1 2201"
    if ! command -v nc &>/dev/null; then
        CHECK_CMD="bash -c 'echo > /dev/tcp/127.0.0.1/2201'"
    fi

    while ! eval "$CHECK_CMD" 2>/dev/null; do
        sleep 1
        WAITED=$((WAITED + 1))
        if [ "$WAITED" -ge "$MAX_WAIT" ]; then
            echo "ERROR: SSH containers did not start within ${MAX_WAIT}s."
            exit 1
        fi
    done
    echo "  SSH containers ready."

    # Wait for telnet
    WAITED=0
    CHECK_CMD_TELNET="nc -z 127.0.0.1 2301"
    if ! command -v nc &>/dev/null; then
        CHECK_CMD_TELNET="bash -c 'echo > /dev/tcp/127.0.0.1/2301'"
    fi

    while ! eval "$CHECK_CMD_TELNET" 2>/dev/null; do
        sleep 1
        WAITED=$((WAITED + 1))
        if [ "$WAITED" -ge "$MAX_WAIT" ]; then
            echo "ERROR: Telnet container did not start within ${MAX_WAIT}s."
            exit 1
        fi
    done
    echo "  Telnet container ready."
else
    echo ""
    echo "=== Skipping container startup (--skip-integration) ==="
fi

# ─── Print environment summary ──────────────────────────────────────────────

echo ""
echo "==========================================="
echo "  Windows System Test Environment"
echo "==========================================="
echo ""
if [ "$IS_WSL" -eq 1 ]; then
echo "  Platform:   Windows (WSL)"
else
echo "  Platform:   Windows (Git Bash / MSYS2)"
fi
if [ "$SKIP_INTEGRATION" -eq 0 ]; then
echo "  SSH:        127.0.0.1:2201-2208"
echo "  Telnet:     127.0.0.1:2301"
elif [ "$PODMAN_NO_BUILDKIT" -eq 1 ]; then
echo "  Containers: skipped (Podman on Windows — no docker buildx)"
else
echo "  Containers: skipped (--skip-integration)"
fi
echo "  Serial:     NOT AVAILABLE"
if [ "$WITH_FAULT" -eq 1 ]; then
echo "  Fault:      127.0.0.1:2209 (network fault proxy)"
fi
if [ "$WITH_STRESS" -eq 1 ]; then
echo "  SFTP:       127.0.0.1:2210 (stress test container)"
fi
if [ "$HAS_TAURI_DRIVER" -eq 1 ] && [ "$SKIP_E2E" -eq 0 ]; then
echo "  E2E:        enabled (tauri-driver found)"
else
echo "  E2E:        skipped"
fi
echo ""
echo "==========================================="

# ─── Run tests ──────────────────────────────────────────────────────────────

TEST_EXIT=0

# 1. Unit tests
if [ "$SKIP_UNIT" -eq 0 ]; then
    echo ""
    echo "=== Running unit tests ==="

    echo ""
    echo "--- Frontend unit tests (pnpm test) ---"
    if ! pnpm test; then
        echo "FRONTEND UNIT TESTS FAILED."
        TEST_EXIT=1
    fi

    echo ""
    echo "--- Backend unit tests (cargo test) ---"
    if ! cargo test --workspace --all-features; then
        echo "BACKEND UNIT TESTS FAILED."
        TEST_EXIT=1
    fi
else
    echo ""
    echo "=== Skipping unit tests (--skip-unit) ==="
fi

# 2. Rust integration tests against Docker containers
if [ "$SKIP_INTEGRATION" -eq 0 ]; then
    echo ""
    echo "=== Running integration tests against Docker containers ==="

    echo ""
    echo "--- SSH authentication tests ---"
    if ! cargo test -p termihub-core --all-features --test ssh_auth -- --nocapture; then
        echo "SSH AUTH TESTS FAILED."
        TEST_EXIT=1
    fi

    echo ""
    echo "--- SSH compatibility tests ---"
    if ! cargo test -p termihub-core --all-features --test ssh_compat -- --nocapture; then
        echo "SSH COMPAT TESTS FAILED."
        TEST_EXIT=1
    fi

    echo ""
    echo "--- SSH advanced tests ---"
    if ! cargo test -p termihub-core --all-features --test ssh_advanced -- --nocapture; then
        echo "SSH ADVANCED TESTS FAILED."
        TEST_EXIT=1
    fi

    echo ""
    echo "--- Telnet tests ---"
    if ! cargo test -p termihub-core --all-features --test telnet -- --nocapture; then
        echo "TELNET TESTS FAILED."
        TEST_EXIT=1
    fi

    echo ""
    echo "--- Monitoring tests ---"
    if ! cargo test -p termihub-core --all-features --test monitoring -- --nocapture; then
        echo "MONITORING TESTS FAILED."
        TEST_EXIT=1
    fi

    # 3. Optional profile tests
    if [ "$WITH_FAULT" -eq 1 ]; then
        echo ""
        echo "--- Network resilience tests (fault profile) ---"
        if ! cargo test -p termihub-core --all-features --test network_resilience -- --nocapture --test-threads=1; then
            echo "NETWORK RESILIENCE TESTS FAILED."
            TEST_EXIT=1
        fi
    fi

    if [ "$WITH_STRESS" -eq 1 ]; then
        echo ""
        echo "--- SFTP stress tests (stress profile) ---"
        if ! cargo test -p termihub-core --all-features --test sftp_stress -- --nocapture; then
            echo "SFTP STRESS TESTS FAILED."
            TEST_EXIT=1
        fi
    fi
else
    echo ""
    if [ "$PODMAN_NO_BUILDKIT" -eq 1 ]; then
        echo "=== Integration tests skipped (Podman on Windows — no docker buildx) ==="
    else
        echo "=== Integration tests skipped (--skip-integration) ==="
    fi
    echo "    NOTE: Integration tests require Docker Desktop for image builds"
    echo "    with 'additional_contexts'. With Podman on Windows, 'docker buildx'"
    echo "    (bundled with Docker Desktop) is required. Linux CI covers this coverage."
fi

# 4. E2E tests (requires tauri-driver)
if [ "$HAS_TAURI_DRIVER" -eq 1 ] && [ "$SKIP_E2E" -eq 0 ]; then
    echo ""
    echo "=== Running E2E infrastructure tests ==="
    if ! pnpm test:e2e:infra; then
        echo "E2E INFRASTRUCTURE TESTS FAILED."
        TEST_EXIT=1
    fi

    # Windows-specific shell E2E tests
    echo ""
    echo "--- Windows shell E2E tests ---"
    echo "(Included in the E2E infra suite — gated by process.platform check)"
else
    echo ""
    echo "=== E2E tests skipped ==="
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "==========================================="
if [ "$TEST_EXIT" -eq 0 ]; then
    echo "  ALL SYSTEM TESTS PASSED"
else
    echo "  SOME TESTS FAILED (exit code: $TEST_EXIT)"
fi
echo "==========================================="

exit "$TEST_EXIT"
