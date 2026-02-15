#!/usr/bin/env bash
# Start the app in development mode with hot-reload.
# Run from anywhere: ./scripts/dev.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "Starting TermiHub in dev mode..."
pnpm tauri dev
