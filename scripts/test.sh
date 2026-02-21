#!/usr/bin/env bash
# Run all unit tests (frontend + backend + agent).
# Run from anywhere: ./scripts/test.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -d node_modules ]; then
    echo "node_modules missing, running pnpm install..."
    pnpm install
    echo ""
fi

FAILED=0

echo "=== Frontend: Vitest ==="
if pnpm test; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Rust workspace: cargo test ==="
if cargo test --workspace --all-features; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
if [ "$FAILED" -ne 0 ]; then
    echo "SOME TESTS FAILED."
    exit 1
else
    echo "ALL TESTS PASSED."
fi
