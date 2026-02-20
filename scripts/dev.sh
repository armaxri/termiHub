#!/usr/bin/env bash
# Start the app in development mode with hot-reload.
# Run from anywhere: ./scripts/dev.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -d node_modules ]; then
    echo "node_modules missing, running pnpm install..."
    pnpm install
    echo ""
fi

# Kill any process occupying the Vite dev server port (leftover from a previous run)
DEV_PORT=1420
if command -v lsof &>/dev/null; then
    PID=$(lsof -ti :"$DEV_PORT" 2>/dev/null || true)
    if [ -n "$PID" ]; then
        echo "Port $DEV_PORT in use (PID $PID), killing..."
        kill "$PID" 2>/dev/null || true
        sleep 1
    fi
elif command -v ss &>/dev/null; then
    PID=$(ss -tlnp "sport = :$DEV_PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    if [ -n "$PID" ]; then
        echo "Port $DEV_PORT in use (PID $PID), killing..."
        kill "$PID" 2>/dev/null || true
        sleep 1
    fi
fi

echo "Starting TermiHub in dev mode..."
pnpm tauri dev
