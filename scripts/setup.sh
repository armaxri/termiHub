#!/usr/bin/env bash
# First-time project setup — installs all dependencies.
# Run from anywhere: ./scripts/setup.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "=== Installing frontend dependencies ==="
pnpm install

echo ""
echo "=== Building Rust backend (first compile takes a while) ==="
(cd src-tauri && cargo build)

echo ""
echo "=== Building Agent ==="
(cd agent && cargo build)

echo ""
echo "Setup complete. Run ./scripts/dev.sh to start the app."
