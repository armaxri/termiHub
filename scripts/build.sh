#!/usr/bin/env bash
# Build the app for production (creates platform installer).
# Run from anywhere: ./scripts/build.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -d node_modules ]; then
    echo "node_modules missing, running pnpm install..."
    pnpm install
    echo ""
fi

echo "Building TermiHub for production..."
pnpm tauri build
