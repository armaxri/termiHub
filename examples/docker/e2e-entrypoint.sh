#!/bin/bash
# e2e-entrypoint.sh — Entrypoint for the E2E runner container.
#
# Builds TermiHub (Linux), starts Xvfb, sets up port-forwards and virtual
# serial ports, then runs the infrastructure E2E test suite.
#
# Environment variables (set by docker-compose or host script):
#   E2E_SKIP_BUILD=1    Skip pnpm install + pnpm tauri build
#   E2E_SKIP_SERIAL=1   Skip virtual serial port setup
#   E2E_SUITE=infra     Test suite to run (default: infra)
#
set -euo pipefail

echo "=== TermiHub E2E Runner ==="
echo "  Platform: $(uname -m)"
echo "  Node:     $(node --version)"
echo "  Rust:     $(rustc --version)"
echo "  pnpm:     $(pnpm --version)"
echo ""

SKIP_BUILD="${E2E_SKIP_BUILD:-0}"
SKIP_SERIAL="${E2E_SKIP_SERIAL:-0}"
SUITE="${E2E_SUITE:-infra}"

# ─── Cleanup trap ─────────────────────────────────────────────────────────────

SOCAT_SSH_PID=""
SOCAT_TELNET_PID=""
SOCAT_SERIAL_PID=""
ECHO_SERVER_PID=""
XVFB_PID=""

cleanup() {
    echo ""
    echo "=== Cleanup ==="

    for pid_var in ECHO_SERVER_PID SOCAT_SERIAL_PID SOCAT_TELNET_PID SOCAT_SSH_PID XVFB_PID; do
        pid="${!pid_var}"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "  Stopping $pid_var (PID $pid)..."
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done

    rm -f /tmp/termihub-serial-a /tmp/termihub-serial-b

    echo "Cleanup complete."
}

trap cleanup EXIT

# ─── Wait for test-target service ─────────────────────────────────────────────

echo "=== Waiting for test-target services ==="

MAX_WAIT=60
WAITED=0
echo -n "  Waiting for test-target:22 (SSH)..."
while ! nc -z test-target 22 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo " TIMEOUT"
        echo "ERROR: test-target SSH server did not start within ${MAX_WAIT}s."
        exit 1
    fi
done
echo " ready."

WAITED=0
echo -n "  Waiting for test-target:23 (Telnet)..."
while ! nc -z test-target 23 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo " TIMEOUT"
        echo "ERROR: test-target Telnet server did not start within ${MAX_WAIT}s."
        exit 1
    fi
done
echo " ready."

# ─── socat port-forwards ─────────────────────────────────────────────────────
# Forward localhost ports to test-target so test code works unchanged
# (tests hardcode host='127.0.0.1', port='2222'/'2323').

echo ""
echo "=== Setting up port forwards ==="

socat TCP-LISTEN:2222,fork,reuseaddr TCP:test-target:22 &
SOCAT_SSH_PID=$!
echo "  127.0.0.1:2222 -> test-target:22 (SSH)    [PID $SOCAT_SSH_PID]"

socat TCP-LISTEN:2323,fork,reuseaddr TCP:test-target:23 &
SOCAT_TELNET_PID=$!
echo "  127.0.0.1:2323 -> test-target:23 (Telnet)  [PID $SOCAT_TELNET_PID]"

sleep 1

if ! nc -z 127.0.0.1 2222 2>/dev/null; then
    echo "ERROR: SSH port forward failed to bind on 127.0.0.1:2222"
    exit 1
fi
if ! nc -z 127.0.0.1 2323 2>/dev/null; then
    echo "ERROR: Telnet port forward failed to bind on 127.0.0.1:2323"
    exit 1
fi

# ─── Virtual serial ports ────────────────────────────────────────────────────

if [ "$SKIP_SERIAL" -eq 0 ]; then
    echo ""
    echo "=== Setting up virtual serial ports ==="

    PTY_A="/tmp/termihub-serial-a"
    PTY_B="/tmp/termihub-serial-b"

    rm -f "$PTY_A" "$PTY_B"

    socat -d -d \
        "pty,raw,echo=0,link=$PTY_A" \
        "pty,raw,echo=0,link=$PTY_B" &>/dev/null &
    SOCAT_SERIAL_PID=$!

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
    echo "=== Skipping virtual serial port setup (E2E_SKIP_SERIAL=1) ==="
fi

# ─── Start Xvfb ──────────────────────────────────────────────────────────────

echo ""
echo "=== Starting Xvfb ==="

Xvfb :99 -screen 0 1280x800x24 &>/dev/null &
XVFB_PID=$!
export DISPLAY=:99

sleep 1
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "ERROR: Xvfb failed to start."
    exit 1
fi
echo "  Xvfb running on display :99 (PID $XVFB_PID)."

# ─── Install dependencies + build ────────────────────────────────────────────

if [ "$SKIP_BUILD" -eq 0 ]; then
    echo ""
    echo "=== Installing dependencies ==="
    pnpm install --frozen-lockfile

    echo ""
    echo "=== Building TermiHub (Linux release) ==="
    pnpm tauri build
else
    echo ""
    echo "=== Skipping build (E2E_SKIP_BUILD=1) ==="

    APP_BINARY="./src-tauri/target/release/termihub"
    if [ ! -f "$APP_BINARY" ]; then
        echo "ERROR: App binary not found at $APP_BINARY"
        echo "Run without E2E_SKIP_BUILD=1 or ensure a cached build exists."
        exit 1
    fi
    echo "  Using existing binary: $APP_BINARY"

    # Still need node_modules for WebdriverIO
    if [ ! -d node_modules ]; then
        echo "  Installing Node dependencies..."
        pnpm install --frozen-lockfile
    fi
fi

# ─── Ensure test-results directory exists ─────────────────────────────────────

mkdir -p ./test-results/screenshots

# ─── Print environment summary ────────────────────────────────────────────────

echo ""
echo "==========================================="
echo "  E2E Test Environment Ready (Docker)"
echo "==========================================="
echo ""
echo "  SSH:      127.0.0.1:2222 -> test-target:22"
echo "  Telnet:   127.0.0.1:2323 -> test-target:23"
if [ "$SKIP_SERIAL" -eq 0 ]; then
echo "  Serial A: /tmp/termihub-serial-a"
echo "  Serial B: /tmp/termihub-serial-b (echo server)"
fi
echo "  Display:  $DISPLAY (Xvfb 1280x800)"
echo "  Suite:    $SUITE"
echo ""
echo "==========================================="

# ─── Run tests ────────────────────────────────────────────────────────────────

echo ""
echo "=== Running E2E tests (suite: $SUITE) ==="

TEST_EXIT=0
if pnpm "test:e2e:$SUITE"; then
    echo ""
    echo "E2E TESTS PASSED."
else
    TEST_EXIT=$?
    echo ""
    echo "E2E TESTS FAILED (exit code: $TEST_EXIT)."
fi

exit "$TEST_EXIT"
