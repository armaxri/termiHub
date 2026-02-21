#!/usr/bin/env bash
# Quick pre-push formatting script.
# Run from the repo root: ./scripts/format.sh
# Fixes all auto-fixable formatting issues across the entire codebase.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -d node_modules ]; then
    echo "node_modules missing, running pnpm install..."
    pnpm install
    echo ""
fi

echo "=== Frontend: Prettier ==="
pnpm exec prettier --write "src/**/*.{ts,tsx,css}"

echo ""
echo "=== Rust workspace: cargo fmt ==="
cargo fmt --all

echo ""
echo "All formatting applied."
