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
# ADVISORY, NOT A HARD GATE (yet): this script reports the unified number; it
# does not fail on a low value. The intended follow-up is to capture a baseline
# from the first CI run, then add a fail-on-decrease ratchet (see coverage.yml).
#
# Flags:
#   --dry-run   Resolve everything and run the merge/summary logic against any
#               existing lcov, but SKIP the heavy vitest/llvm-cov runs. Used to
#               smoke-test the script (this repo's CI does not run full coverage).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

OUT_DIR="coverage-unified"
FRONTEND_LCOV="coverage/lcov.info"
RUST_LCOV="$OUT_DIR/rust.lcov"
MERGED_LCOV="$OUT_DIR/merged.lcov"
SUMMARY_FILE="$OUT_DIR/summary.txt"

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
    echo "  [dry-run] skipping: cargo llvm-cov --workspace --all-features --lcov"
else
    cargo llvm-cov --workspace --all-features --lcov --output-path "$RUST_LCOV"
fi

# ---------------------------------------------------------------------------
# 3. Merge both lcov files into one and compute a single repo-wide number.
#    Both tools emit standard lcov, so a plain concatenation is a valid merged
#    tracefile — each record keeps its own SF: path. We summarize with awk (no
#    dependency on the `lcov`/`genhtml` binaries, which are not installed on all
#    dev machines or CI runners).
echo "=== Merging lcov + computing unified number ==="
: > "$MERGED_LCOV"
FRONTEND_PRESENT=0
RUST_PRESENT=0
if [ -f "$FRONTEND_LCOV" ]; then
    cat "$FRONTEND_LCOV" >> "$MERGED_LCOV"
    FRONTEND_PRESENT=1
else
    echo "  note: no frontend lcov at $FRONTEND_LCOV"
fi
if [ -f "$RUST_LCOV" ]; then
    cat "$RUST_LCOV" >> "$MERGED_LCOV"
    RUST_PRESENT=1
else
    echo "  note: no Rust lcov at $RUST_LCOV"
fi

if [ ! -s "$MERGED_LCOV" ]; then
    echo "  no coverage data to summarize (both lcov files missing)." >&2
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "  [dry-run] nothing to summarize — that is expected without a prior run."
        exit 0
    fi
    exit 1
fi

# Sum lines/functions/branches (LF/LH, FNF/FNH, BRF/BRH) across every record in
# the merged tracefile and print percentages. A shared Node summarizer (Node is
# already a repo dependency) keeps this identical to coverage.cmd.
node scripts/internal/lcov-summary.mjs "$MERGED_LCOV" | tee "$SUMMARY_FILE"

echo ""
echo "Sources merged: frontend=$FRONTEND_PRESENT rust=$RUST_PRESENT"
echo "Merged lcov:    $MERGED_LCOV"
echo "Summary:        $SUMMARY_FILE"
echo "HTML reports:   coverage/ (frontend) — run 'cargo llvm-cov --html' for Rust HTML"
