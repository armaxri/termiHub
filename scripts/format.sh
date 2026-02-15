#!/usr/bin/env bash
# Quick pre-push formatting script.
# Run from the repo root: ./scripts/format.sh
# Fixes all auto-fixable formatting issues across the entire codebase.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "=== Frontend: Prettier ==="
pnpm exec prettier --write "src/**/*.{ts,tsx,css}"

echo ""
echo "=== Backend: cargo fmt ==="
(cd src-tauri && cargo fmt)

echo ""
echo "=== Agent: cargo fmt ==="
(cd agent && cargo fmt)

echo ""
echo "All formatting applied."
