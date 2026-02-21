#!/usr/bin/env bash
# First-time project setup — installs all dependencies.
# Run from anywhere: ./scripts/setup.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "=== Installing frontend dependencies ==="
pnpm install

echo ""
echo "=== Building Rust workspace (first compile takes a while) ==="
cargo build --workspace

echo ""
echo "Setup complete. Run ./scripts/dev.sh to start the app."
