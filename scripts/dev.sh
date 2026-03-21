#!/usr/bin/env bash
# Start the app in development mode with hot-reload.
# Run from anywhere: ./scripts/dev.sh [PORT]
#
# Port resolution order (first match wins):
#   1. CLI argument:      ./scripts/dev.sh 1422
#   2. dev.local file:    echo 1422 > dev.local   (gitignored — per-checkout setting)
#   3. Default:           1420
#
# Multiple instances can run in parallel by using different ports.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Resolve dev port
DEV_PORT=1420
if [ -n "${1:-}" ] && [[ "$1" =~ ^[0-9]+$ ]]; then
    DEV_PORT="$1"
elif [ -f "dev.local" ]; then
    _CONF_PORT="$(tr -d '[:space:]' < dev.local)"
    if [[ "$_CONF_PORT" =~ ^[0-9]+$ ]]; then
        DEV_PORT="$_CONF_PORT"
    fi
fi

if [ ! -d node_modules ]; then
    echo "node_modules missing, running pnpm install..."
    pnpm install
    echo ""
fi

# Kill any process occupying the Vite dev server port (leftover from a previous run)
node scripts/internal/kill-port.cjs "$DEV_PORT"

echo "Starting termiHub in dev mode (port $DEV_PORT)..."
TERMIHUB_DEV_PORT="$DEV_PORT" pnpm tauri dev --config "{\"build\":{\"devUrl\":\"http://localhost:$DEV_PORT\"}}"
