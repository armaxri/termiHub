#!/usr/bin/env bash
# Remove all build artifacts and caches for a fresh start.
# Run from anywhere: ./scripts/clean.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "=== Cleaning frontend ==="
rm -rf node_modules dist

echo "=== Cleaning Rust workspace ==="
cargo clean

echo ""
echo "All build artifacts removed. Run ./scripts/setup.sh to reinstall."
