#!/usr/bin/env bash
# Run all unit tests (frontend + backend + agent).
# Run from anywhere: ./scripts/test.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Resolve this checkout's test environment (Compose project, offset ports,
# serial device paths, driver port) from dev.local.json, so several checkouts
# can run all test environments at once. See docs/testing.md.
source scripts/internal/dev-local-env.sh

if [ ! -d node_modules ]; then
    echo "node_modules missing, running pnpm install..."
    pnpm install
    echo ""
fi

FAILED=0
FAILED_SUITES=""

# Print the verdict for a suite that has just run, and remember any failure.
#
# A runner's own summary is not the verdict. vitest exits non-zero when the run
# hit an unhandled error even though every test passed, so its summary can read
# "3223 passed" on a run that failed (#1572): the count describes the tests, the
# exit code describes the run. Only the exit code decides here, and the verdict
# is printed right after it so the two can't be read apart -- otherwise a failed
# suite's last word is a pass count, minutes of later output scroll it away, and
# the reader scrolling back finds only the reassuring number.
verdict() {
    local name="$1" status="$2"
    if [ "$status" -eq 0 ]; then
        echo "PASS: $name"
    else
        echo "FAIL: $name (exit $status)"
        FAILED=1
        FAILED_SUITES="${FAILED_SUITES}  - ${name} (exit ${status})"$'\n'
    fi
}

# Each suite runs under `|| status=$?` so a failure records a verdict instead of
# aborting the script under `set -e`: one red suite must not hide the other's result.
echo "=== Frontend: Vitest ==="
status=0
pnpm test || status=$?
verdict "Frontend: Vitest" "$status"

echo ""
echo "=== Rust workspace: cargo test ==="
status=0
cargo test --workspace --all-features || status=$?
verdict "Rust workspace: cargo test" "$status"

echo ""
if [ "$FAILED" -ne 0 ]; then
    echo "SOME TESTS FAILED:"
    printf "%s" "$FAILED_SUITES"
    exit 1
else
    echo "ALL TESTS PASSED."
fi
