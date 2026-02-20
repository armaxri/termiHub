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

echo "Starting termiHub in dev mode..."
pnpm tauri dev
