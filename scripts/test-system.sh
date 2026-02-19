#!/usr/bin/env bash
# Run system-level E2E tests with Docker infrastructure (SSH, Telnet)
# and virtual serial ports on macOS.
#
# This script:
#   1. Checks prerequisites (Docker, socat, tauri-driver, built app)
#   2. Starts Docker containers (SSH + Telnet servers)
#   3. Creates a virtual serial port pair via socat
#   4. Starts the serial echo server
#   5. Runs the infrastructure E2E test suite
#   6. Cleans up all background processes and containers
#
# Run from anywhere: ./scripts/test-system.sh
#
# Options:
#   --skip-build    Skip the app build step (use existing binary)
#   --skip-serial   Skip virtual serial port setup (test SSH/Telnet only)
#   --keep-infra    Keep Docker containers running after tests finish
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ─── Parse arguments ────────────────────────────────────────────────────────

SKIP_BUILD=0
SKIP_SERIAL=0
KEEP_INFRA=0

for arg in "$@"; do
    case "$arg" in
        --skip-build)  SKIP_BUILD=1 ;;
        --skip-serial) SKIP_SERIAL=1 ;;
        --keep-infra)  KEEP_INFRA=1 ;;
        --help|-h)
            echo "Usage: ./scripts/test-system.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --skip-build    Skip the app build step (use existing binary)"
            echo "  --skip-serial   Skip virtual serial port setup"
            echo "  --keep-infra    Keep Docker containers running after tests"
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

# ─── Cleanup trap ───────────────────────────────────────────────────────────

SOCAT_PID=""
ECHO_SERVER_PID=""
DOCKER_STARTED=0

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

    rm -f /tmp/termihub-serial-a /tmp/termihub-serial-b

    if [ "$DOCKER_STARTED" -eq 1 ] && [ "$KEEP_INFRA" -eq 0 ]; then
        echo "Stopping Docker containers..."
        docker compose -f examples/docker/docker-compose.yml down 2>/dev/null || true
    elif [ "$KEEP_INFRA" -eq 1 ]; then
        echo "Keeping Docker containers running (--keep-infra)."
    fi

    echo "Cleanup complete."
}

trap cleanup EXIT

# ─── Check prerequisites ────────────────────────────────────────────────────

echo "=== Checking prerequisites ==="

MISSING=0

if ! command -v docker &>/dev/null; then
    echo "  MISSING: docker — install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    MISSING=1
fi

if command -v docker &>/dev/null && ! docker info &>/dev/null 2>&1; then
    echo "  ERROR: Docker daemon is not running. Please start Docker Desktop."
    MISSING=1
fi

if ! command -v pnpm &>/dev/null; then
    echo "  MISSING: pnpm — install with: npm install -g pnpm"
    MISSING=1
fi

if ! command -v tauri-driver &>/dev/null; then
    echo "  MISSING: tauri-driver — install with: cargo install tauri-driver"
    MISSING=1
fi

if [ "$SKIP_SERIAL" -eq 0 ] && ! command -v socat &>/dev/null; then
    echo "  MISSING: socat — install with: brew install socat"
    MISSING=1
fi

if [ "$SKIP_SERIAL" -eq 0 ] && ! command -v python3 &>/dev/null; then
    echo "  MISSING: python3 — install with: brew install python3"
    MISSING=1
fi

if [ "$MISSING" -ne 0 ]; then
    echo ""
    echo "Install the missing prerequisites and try again."
    exit 1
fi

echo "  All prerequisites found."

# ─── Ensure node_modules ────────────────────────────────────────────────────

if [ ! -d node_modules ]; then
    echo ""
    echo "node_modules missing, running pnpm install..."
    pnpm install
fi

# ─── Build the app ──────────────────────────────────────────────────────────

APP_BINARY=""
if [ "$(uname)" = "Darwin" ]; then
    APP_BINARY="./src-tauri/target/release/bundle/macos/termiHub.app/Contents/MacOS/termiHub"
else
    APP_BINARY="./src-tauri/target/release/termihub"
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
    echo ""
    echo "=== Building TermiHub ==="
    pnpm tauri build
elif [ ! -f "$APP_BINARY" ]; then
    echo ""
    echo "ERROR: App binary not found at $APP_BINARY"
    echo "Run without --skip-build or build manually with: pnpm tauri build"
    exit 1
else
    echo ""
    echo "=== Skipping build (--skip-build), using existing binary ==="
fi

# ─── Start Docker containers ────────────────────────────────────────────────

echo ""
echo "=== Starting Docker test infrastructure ==="
docker compose -f examples/docker/docker-compose.yml up -d --build
DOCKER_STARTED=1

# Wait for SSH server
echo "Waiting for SSH server on port 2222..."
MAX_WAIT=30
WAITED=0
while ! nc -z 127.0.0.1 2222 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "ERROR: SSH server did not start within ${MAX_WAIT}s."
        exit 1
    fi
done
echo "  SSH server ready (127.0.0.1:2222)."

# Wait for Telnet server
echo "Waiting for Telnet server on port 2323..."
WAITED=0
while ! nc -z 127.0.0.1 2323 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "ERROR: Telnet server did not start within ${MAX_WAIT}s."
        exit 1
    fi
done
echo "  Telnet server ready (127.0.0.1:2323)."

# ─── Set up virtual serial ports ────────────────────────────────────────────

if [ "$SKIP_SERIAL" -eq 0 ]; then
    echo ""
    echo "=== Setting up virtual serial ports ==="

    PTY_A="/tmp/termihub-serial-a"
    PTY_B="/tmp/termihub-serial-b"

    # Clean up stale symlinks
    rm -f "$PTY_A" "$PTY_B"

    # Start socat in the background
    socat -d -d \
        "pty,raw,echo=0,link=$PTY_A" \
        "pty,raw,echo=0,link=$PTY_B" &>/dev/null &
    SOCAT_PID=$!

    # Wait for the virtual serial ports to appear
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

    # Start the serial echo server in the background
    echo "Starting serial echo server on $PTY_B..."
    python3 examples/serial/serial-echo-server.py "$PTY_B" &>/dev/null &
    ECHO_SERVER_PID=$!
    sleep 1

    if ! kill -0 "$ECHO_SERVER_PID" 2>/dev/null; then
        echo "ERROR: Serial echo server failed to start."
        exit 1
    fi
    echo "  Serial echo server running (PID $ECHO_SERVER_PID)."
else
    echo ""
    echo "=== Skipping virtual serial port setup (--skip-serial) ==="
fi

# ─── Print test environment summary ─────────────────────────────────────────

echo ""
echo "==========================================="
echo "  System Test Environment Ready"
echo "==========================================="
echo ""
echo "  SSH:      127.0.0.1:2222  (testuser / testpass)"
echo "  Telnet:   127.0.0.1:2323"
if [ "$SKIP_SERIAL" -eq 0 ]; then
echo "  Serial A: /tmp/termihub-serial-a"
echo "  Serial B: /tmp/termihub-serial-b (echo server)"
fi
echo ""
echo "==========================================="

# ─── Run system tests ───────────────────────────────────────────────────────

echo ""
echo "=== Running system tests (E2E infrastructure suite) ==="

TEST_EXIT=0
if pnpm test:e2e:infra; then
    echo ""
    echo "SYSTEM TESTS PASSED."
else
    TEST_EXIT=$?
    echo ""
    echo "SYSTEM TESTS FAILED."
fi

# Cleanup happens via the EXIT trap
exit "$TEST_EXIT"
