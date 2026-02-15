#!/usr/bin/env bash
# Run all unit tests (frontend + backend + agent).
# Run from anywhere: ./scripts/test.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

FAILED=0

echo "=== Frontend: Vitest ==="
if pnpm test; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Backend: cargo test ==="
if (cd src-tauri && cargo test --all-features); then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Agent: cargo test ==="
if (cd agent && cargo test --all-features); then
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
