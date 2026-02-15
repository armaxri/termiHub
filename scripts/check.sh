#!/usr/bin/env bash
# Quick pre-push quality check script.
# Run from the repo root: ./scripts/check.sh
# Mirrors the CI Code Quality checks locally without modifying files.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

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
echo "=== Backend: cargo fmt ==="
if (cd src-tauri && cargo fmt --check); then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Backend: clippy ==="
if (cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings); then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Agent: cargo fmt ==="
if (cd agent && cargo fmt --check); then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Agent: clippy ==="
if (cd agent && cargo clippy --all-targets --all-features -- -D warnings); then
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
