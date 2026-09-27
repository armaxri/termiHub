#!/usr/bin/env bash
# Unified whole-app coverage — frontend (vitest/v8) + Rust (cargo-llvm-cov).
#
# Produces ONE repo-wide coverage number spanning the React/TypeScript frontend
# and the Rust backend/agent/core crates, plus a merged lcov file and the
# per-language HTML reports as artifacts. This is the flagship tooling the
# maintainer asked for: a full-coverage (frontend + backend, unified) picture.
# Addresses audit findings TOOL-001 (unified number), TOOL-002 (the .tsx glob
# fix lives in vitest.config.ts), and TOOL-003 (Rust coverage via cargo-llvm-cov).
#
# Run from anywhere: ./scripts/coverage.sh
#
# BLOCKING RATCHET (#3740 — CI-011, TBE-007, TOOL-011): after reporting, the
# per-component UNIT line coverage (frontend, core, agent, src-tauri, unified)
# is compared with the committed per-platform baseline in
# scripts/coverage-baseline.json by scripts/internal/coverage-ratchet.mjs. A drop
# of more than the baseline's tolerance fails the script (exit 1). The nightly
# integration overlay below is reported but NOT gated (it varies run to run).
# When coverage improves, lock it in with: ./scripts/coverage.sh --update-baseline
#
# Nightly integration coverage (TOOL-005, #3656): when TERMIHUB_INTEGRATION_LCOV
# names an lcov file from the nightly integration-fixtures lane, it is merged
# into the unified report per source file (lcov-merge.mjs), so paths only the
# live-fixture suites reach count as covered. TERMIHUB_INTEGRATION_STALE names an
# optional list of files changed since that nightly commit; their integration
# records are skipped. CI's coverage.yml fetches both; locally they are unset
# and the report is unit-only, as before.
#
# Flags:
#   --dry-run   Resolve everything and run the merge/summary logic against any
#               existing lcov, but SKIP the heavy vitest/llvm-cov runs. Used to
#               smoke-test the script (this repo's CI does not run full coverage).
#   --update-baseline
#               Instead of gating, raise this platform's baseline in
#               scripts/coverage-baseline.json to the measured values (never
#               lowers a value). Commit the updated file.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

DRY_RUN=0
UPDATE_BASELINE=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --update-baseline) UPDATE_BASELINE=1 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

OUT_DIR="coverage-unified"
FRONTEND_LCOV="coverage/lcov.info"
RUST_LCOV="$OUT_DIR/rust.lcov"
UNIT_LCOV="$OUT_DIR/unit.lcov"
MERGED_LCOV="$OUT_DIR/merged.lcov"
SUMMARY_FILE="$OUT_DIR/summary.txt"
RATCHET_REPORT="$OUT_DIR/ratchet.md"
GAP_REPORT="$OUT_DIR/integration-gap.md"
INTEGRATION_LCOV="${TERMIHUB_INTEGRATION_LCOV:-}"
INTEGRATION_STALE="${TERMIHUB_INTEGRATION_STALE:-}"

mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------------------
# 1. Frontend coverage (vitest v8 → lcov). The include glob in vitest.config.ts
#    is src/**/*.{ts,tsx} so React components count toward the number (TOOL-002).
echo "=== Frontend coverage (vitest v8 → lcov) ==="
if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] skipping: pnpm test:coverage"
else
    pnpm test:coverage
fi

# ---------------------------------------------------------------------------
# 2. Rust coverage (cargo-llvm-cov → lcov) across the whole workspace with all
#    features (TOOL-003). cargo-llvm-cov is installed in CI via
#    taiki-e/install-action; locally: `cargo install cargo-llvm-cov` (needs the
#    llvm-tools-preview rustup component).
echo "=== Rust coverage (cargo llvm-cov → lcov) ==="
if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] skipping: cargo llvm-cov --workspace --all-features --no-report"
else
    # Tests and report are split so the report step can survive an intermittent
    # truncated .profraw (see scripts/internal/llvm-cov-report.mjs).
    cargo llvm-cov --workspace --all-features --no-report
    node scripts/internal/llvm-cov-report.mjs "$RUST_LCOV"
fi

# ---------------------------------------------------------------------------
# 3. Merge both lcov files into one and compute a single repo-wide number.
#    Both tools emit standard lcov, so a plain concatenation is a valid merged
#    tracefile — each record keeps its own SF: path. We summarize with awk (no
#    dependency on the `lcov`/`genhtml` binaries, which are not installed on all
#    dev machines or CI runners).
echo "=== Merging lcov + computing unified number ==="
: > "$UNIT_LCOV"
FRONTEND_PRESENT=0
RUST_PRESENT=0
INTEGRATION_PRESENT=0
if [ -f "$FRONTEND_LCOV" ]; then
    cat "$FRONTEND_LCOV" >> "$UNIT_LCOV"
    FRONTEND_PRESENT=1
else
    echo "  note: no frontend lcov at $FRONTEND_LCOV"
fi
if [ -f "$RUST_LCOV" ]; then
    cat "$RUST_LCOV" >> "$UNIT_LCOV"
    RUST_PRESENT=1
else
    echo "  note: no Rust lcov at $RUST_LCOV"
fi

if [ ! -s "$UNIT_LCOV" ]; then
    echo "  no coverage data to summarize (both lcov files missing)." >&2
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "  [dry-run] nothing to summarize — that is expected without a prior run."
        exit 0
    fi
    exit 1
fi

# The frontend and Rust unit reports never share a source file, so a plain
# concatenation is already a valid merged tracefile. The integration lcov DOES
# share files with the Rust report, so it is merged per file instead (hits
# summed, the unit report owning the denominator, stale files skipped).
rm -f "$GAP_REPORT" "$RATCHET_REPORT"
if [ -n "$INTEGRATION_LCOV" ] && [ -s "$INTEGRATION_LCOV" ]; then
    echo "--- unit tests only ---"
    node scripts/internal/lcov-summary.mjs "$UNIT_LCOV"
    echo "--- + nightly integration lane ($INTEGRATION_LCOV) ---"
    node scripts/internal/lcov-merge.mjs --base "$UNIT_LCOV" --overlay "$INTEGRATION_LCOV" \
        --skip-list "$INTEGRATION_STALE" --root "$PWD" \
        --out "$MERGED_LCOV" --report "$GAP_REPORT"
    INTEGRATION_PRESENT=1
else
    if [ -n "$INTEGRATION_LCOV" ]; then
        echo "  note: no integration lcov at $INTEGRATION_LCOV"
    fi
    cp "$UNIT_LCOV" "$MERGED_LCOV"
fi

# Sum lines/functions/branches (LF/LH, FNF/FNH, BRF/BRH) across every record in
# the merged tracefile and print percentages. A shared Node summarizer (Node is
# already a repo dependency) keeps this identical to coverage.cmd.
node scripts/internal/lcov-summary.mjs "$MERGED_LCOV" | tee "$SUMMARY_FILE"

echo ""
echo "Sources merged: frontend=$FRONTEND_PRESENT rust=$RUST_PRESENT integration=$INTEGRATION_PRESENT"
echo "Merged lcov:    $MERGED_LCOV"
echo "Summary:        $SUMMARY_FILE"
if [ "$INTEGRATION_PRESENT" -eq 1 ]; then
    echo "Gap report:     $GAP_REPORT"
fi
echo "HTML reports:   coverage/ (frontend) — run 'cargo llvm-cov --html' for Rust HTML"

# ---------------------------------------------------------------------------
# 4. Ratchet: fail on a coverage decrease against the committed baseline, or
#    (with --update-baseline) raise the baseline to the measured values.
echo ""
echo "=== Coverage ratchet (scripts/coverage-baseline.json) ==="
if [ "$UPDATE_BASELINE" -eq 1 ]; then
    node scripts/internal/coverage-ratchet.mjs --update
else
    node scripts/internal/coverage-ratchet.mjs --check --report "$RATCHET_REPORT"
fi
