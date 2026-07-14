#!/usr/bin/env bash
# Per-machine system test orchestration for Linux.
#
# This script:
#   1. Checks prerequisites (Docker, socat, cargo, pnpm)
#   2. Starts Docker containers from tests/docker/
#   3. Sets up virtual serial ports (socat)
#   4. Runs unit tests (frontend + backend + agent)
#   5. Runs Rust integration tests against Docker containers
#   6. Optionally runs fault/stress profile tests
#   7. Detects USB-to-serial hardware
#   8. Detects ARM architecture and adjusts tests
#   9. Tears down containers (unless --keep-infra)
#
# UI/infrastructure E2E coverage now lives in the Python bridge harness
# (tests/system/, run via scripts/test-system-py.sh) — see epic #799.
#
# Usage:
#   ./scripts/test-system-linux.sh [OPTIONS]
#
# Options:
#   --skip-serial     Skip virtual serial port setup
#   --skip-unit       Skip unit tests (run integration tests only)
#   --with-fault      Include network fault injection tests (profile: fault)
#   --with-stress     Include SFTP stress tests (profile: stress)
#   --with-ftp        Include FTP file-browser tests (profile: ftp)
#   --with-all        Include all profiles (fault + stress + ftp)
#   --keep-infra      Keep Docker containers running after tests
#   --help, -h        Show this help message
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Resolve this checkout's test environment (Compose project, offset ports,
# serial device paths, driver port) from dev.local.json, so several checkouts
# can run all test environments at once. See docs/testing.md.
source scripts/internal/dev-local-env.sh

# ─── Parse arguments ────────────────────────────────────────────────────────

SKIP_SERIAL=0
SKIP_UNIT=0
WITH_FAULT=0
WITH_STRESS=0
WITH_FTP=0
KEEP_INFRA=0

for arg in "$@"; do
    case "$arg" in
        --skip-serial) SKIP_SERIAL=1 ;;
        --skip-unit)   SKIP_UNIT=1 ;;
        --with-fault)  WITH_FAULT=1 ;;
        --with-stress) WITH_STRESS=1 ;;
        --with-ftp)    WITH_FTP=1 ;;
        --with-all)    WITH_FAULT=1; WITH_STRESS=1; WITH_FTP=1 ;;
        --keep-infra)  KEEP_INFRA=1 ;;
        --help|-h)
            echo "Usage: ./scripts/test-system-linux.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --skip-serial   Skip virtual serial port setup"
            echo "  --skip-unit     Skip unit tests (integration only)"
            echo "  --with-fault    Include network fault injection tests"
            echo "  --with-stress   Include SFTP stress tests"
            echo "  --with-ftp      Include FTP file-browser tests (profile: ftp)"
            echo "  --with-all      Include all test profiles"
            echo "  --keep-infra    Keep Docker containers after tests"
            echo "  --help, -h      Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Run with --help for usage information."
            exit 1
            ;;
    esac
done

# ─── Detect container runtime ───────────────────────────────────────────────
# Allow override via env: CONTAINER_CMD=podman ./scripts/test-system-linux.sh

if [ -z "${CONTAINER_CMD:-}" ]; then
    if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
        CONTAINER_CMD="docker"
    elif command -v podman &>/dev/null && podman info &>/dev/null 2>&1; then
        CONTAINER_CMD="podman"
    else
        CONTAINER_CMD="docker"  # will fail below with a clear error
    fi
fi

# ─── Cleanup trap ───────────────────────────────────────────────────────────

SOCAT_PID=""
ECHO_SERVER_PID=""
DOCKER_STARTED=0
COMPOSE_ARGS=""

cleanup() {
    echo ""
    echo "=== Cleanup ==="

    if [ -n "$ECHO_SERVER_PID" ] && kill -0 "$ECHO_SERVER_PID" 2>/dev/null; then
        echo "Stopping serial echo server (PID $ECHO_SERVER_PID)..."
        kill "$ECHO_SERVER_PID" 2>/dev/null || true
        wait "$ECHO_SERVER_PID" 2>/dev/null || true
    fi

    if [ -n "$SOCAT_PID" ] && kill -0 "$SOCAT_PID" 2>/dev/null; then
        echo "Stopping socat virtual serial ports (PID $SOCAT_PID)..."
        kill "$SOCAT_PID" 2>/dev/null || true
        wait "$SOCAT_PID" 2>/dev/null || true
    fi

    rm -f ${TERMIHUB_SERIAL_A:-/tmp/termihub-serial-a} ${TERMIHUB_SERIAL_B:-/tmp/termihub-serial-b}

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

# ─── Detect architecture ────────────────────────────────────────────────────

ARCH=$(uname -m)
IS_ARM=0
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    IS_ARM=1
fi

# ─── Check prerequisites ────────────────────────────────────────────────────

echo "=== Linux System Test Orchestration ==="
echo ""
echo "Checking prerequisites..."

MISSING=0

if ! command -v "$CONTAINER_CMD" &>/dev/null; then
    echo "  MISSING: $CONTAINER_CMD — install Docker: https://docs.docker.com/engine/install/"
    echo "           or Podman: https://podman.io/docs/installation"
    MISSING=1
fi

if command -v "$CONTAINER_CMD" &>/dev/null && ! "$CONTAINER_CMD" info &>/dev/null 2>&1; then
    echo "  ERROR: $CONTAINER_CMD daemon is not running. Start with: sudo systemctl start $CONTAINER_CMD"
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

if [ "$SKIP_SERIAL" -eq 0 ] && ! command -v socat &>/dev/null; then
    echo "  MISSING: socat — install with: sudo apt install socat"
    MISSING=1
fi

if [ "$MISSING" -ne 0 ]; then
    echo ""
    echo "Install the missing prerequisites and try again."
    exit 1
fi

echo "  All required prerequisites found."

# ─── Detect hardware ────────────────────────────────────────────────────────

echo ""
echo "=== Hardware Detection ==="
echo "  Architecture: $ARCH"

if [ "$IS_ARM" -eq 1 ]; then
    echo "  ARM detected — heavy performance tests will be skipped."
fi

# Check for USB-to-serial adapters
SERIAL_DEVICES=$(ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true)
if [ -n "$SERIAL_DEVICES" ]; then
    echo "  USB-to-serial devices found:"
    echo "$SERIAL_DEVICES" | while read -r dev; do echo "    $dev"; done
    echo "  (Hardware serial tests can be run manually against these devices)"
else
    echo "  No USB-to-serial devices detected."
fi

# ─── Ensure node_modules ────────────────────────────────────────────────────

if [ ! -d node_modules ]; then
    echo ""
    echo "node_modules missing, running pnpm install..."
    pnpm install
fi

# ─── Start Docker containers ────────────────────────────────────────────────

echo ""
echo "=== Starting container test infrastructure ==="

# Build compose args for optional profiles (additive, so several can combine and
# teardown targets the same set). Default services (SSH/telnet) have no profile
# and always start.
if [ "$WITH_FAULT" -eq 1 ]; then
    COMPOSE_ARGS="$COMPOSE_ARGS --profile fault"
fi
if [ "$WITH_STRESS" -eq 1 ]; then
    COMPOSE_ARGS="$COMPOSE_ARGS --profile stress"
fi
if [ "$WITH_FTP" -eq 1 ]; then
    COMPOSE_ARGS="$COMPOSE_ARGS --profile ftp"
fi

$CONTAINER_CMD compose -f tests/docker/docker-compose.yml $COMPOSE_ARGS up -d --build
DOCKER_STARTED=1

# Wait for core SSH container
echo "Waiting for SSH containers to be ready..."
MAX_WAIT=60
WAITED=0
while ! nc -z 127.0.0.1 2201 2>/dev/null; do
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
while ! nc -z 127.0.0.1 2301 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "ERROR: Telnet container did not start within ${MAX_WAIT}s."
        exit 1
    fi
done
echo "  Telnet container ready."

# Wait for the FTP control port (offset-aware) when the ftp profile is enabled.
if [ "$WITH_FTP" -eq 1 ]; then
    FTP_PORT="${TERMIHUB_TEST_FTP_PORT:-2401}"
    WAITED=0
    while ! nc -z 127.0.0.1 "$FTP_PORT" 2>/dev/null; do
        sleep 1
        WAITED=$((WAITED + 1))
        if [ "$WAITED" -ge "$MAX_WAIT" ]; then
            echo "ERROR: FTP container did not start within ${MAX_WAIT}s."
            exit 1
        fi
    done
    echo "  FTP container ready (127.0.0.1:$FTP_PORT)."
fi

# ─── Set up virtual serial ports ────────────────────────────────────────────

if [ "$SKIP_SERIAL" -eq 0 ]; then
    echo ""
    echo "=== Setting up virtual serial ports ==="

    PTY_A="${TERMIHUB_SERIAL_A:-/tmp/termihub-serial-a}"
    PTY_B="${TERMIHUB_SERIAL_B:-/tmp/termihub-serial-b}"

    rm -f "$PTY_A" "$PTY_B"

    socat -d -d \
        "pty,raw,echo=0,link=$PTY_A" \
        "pty,raw,echo=0,link=$PTY_B" &>/dev/null &
    SOCAT_PID=$!

    WAITED=0
    while [ ! -e "$PTY_A" ] || [ ! -e "$PTY_B" ]; do
        sleep 0.5
        WAITED=$((WAITED + 1))
        if [ "$WAITED" -ge 20 ]; then
            echo "ERROR: Virtual serial ports did not appear within 10s."
            exit 1
        fi
    done
    echo "  Virtual serial pair: $PTY_A <--> $PTY_B"

    if [ -f examples/serial/serial-echo-server.py ]; then
        python3 examples/serial/serial-echo-server.py "$PTY_B" &>/dev/null &
        ECHO_SERVER_PID=$!
        sleep 1
        if kill -0 "$ECHO_SERVER_PID" 2>/dev/null; then
            echo "  Serial echo server running (PID $ECHO_SERVER_PID)."
        else
            echo "  WARNING: Serial echo server failed to start."
        fi
    fi
else
    echo ""
    echo "=== Skipping virtual serial port setup (--skip-serial) ==="
fi

# ─── Print environment summary ──────────────────────────────────────────────

echo ""
echo "==========================================="
echo "  Linux System Test Environment"
echo "==========================================="
echo ""
echo "  Platform:   Linux ($ARCH)"
echo "  SSH:        127.0.0.1:2201-2208"
echo "  Telnet:     127.0.0.1:2301"
if [ "$SKIP_SERIAL" -eq 0 ]; then
echo "  Serial A:   ${TERMIHUB_SERIAL_A:-/tmp/termihub-serial-a}"
echo "  Serial B:   ${TERMIHUB_SERIAL_B:-/tmp/termihub-serial-b} (echo server)"
fi
if [ "$WITH_FAULT" -eq 1 ]; then
echo "  Fault:      127.0.0.1:2209 (network fault proxy)"
fi
if [ "$WITH_STRESS" -eq 1 ]; then
echo "  SFTP:       127.0.0.1:2210 (stress test container)"
fi
if [ "$WITH_FTP" -eq 1 ]; then
echo "  FTP:        127.0.0.1:${TERMIHUB_TEST_FTP_PORT:-2401} (ftp-server container)"
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

    if [ "$IS_ARM" -eq 1 ]; then
        echo "  ARM detected — running subset (skipping heavy file transfer tests)."
        # On ARM, skip the 100MB download test which is slow
        if ! cargo test -p termihub-core --all-features --test sftp_stress -- --nocapture --skip "sftp_stress_03"; then
            echo "SFTP STRESS TESTS FAILED."
            TEST_EXIT=1
        fi
    else
        if ! cargo test -p termihub-core --all-features --test sftp_stress -- --nocapture; then
            echo "SFTP STRESS TESTS FAILED."
            TEST_EXIT=1
        fi
    fi
fi

if [ "$WITH_FTP" -eq 1 ]; then
    echo ""
    echo "--- FTP file-browser tests (ftp profile) ---"
    if ! cargo test -p termihub-core --all-features --test ftp_file_browser -- --nocapture; then
        echo "FTP FILE-BROWSER TESTS FAILED."
        TEST_EXIT=1
    fi

    echo ""
    echo "--- FTP transfer tests (ftp profile) ---"
    if ! cargo test -p termihub-core --all-features --test ftp_transfer -- --nocapture; then
        echo "FTP TRANSFER TESTS FAILED."
        TEST_EXIT=1
    fi
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
