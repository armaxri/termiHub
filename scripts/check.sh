#!/usr/bin/env bash
# Quick pre-push quality check script.
# Run from the repo root: ./scripts/check.sh
# Mirrors the CI Code Quality checks locally without modifying files.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -d node_modules ]; then
    echo "node_modules missing, running pnpm install..."
    pnpm install
    echo ""
fi

FAILED=0

echo "=== Frontend: Prettier ==="
if pnpm run format:check; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Frontend: ESLint ==="
if pnpm run lint; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Rust workspace: cargo fmt ==="
if cargo fmt --all -- --check; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Rust workspace: clippy ==="
if cargo clippy --workspace --all-targets --all-features -- -D warnings; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
if [ "$FAILED" -ne 0 ]; then
    echo "SOME CHECKS FAILED. Run ./scripts/format.sh to auto-fix formatting."
    exit 1
else
    echo "ALL CHECKS PASSED."
fi
