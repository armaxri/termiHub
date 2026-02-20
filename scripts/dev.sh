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
node scripts/kill-port.cjs 1420

echo "Starting termiHub in dev mode..."
pnpm tauri dev
