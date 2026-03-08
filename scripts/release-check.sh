#!/usr/bin/env bash
# Release readiness checklist — validates that the repo is ready for a release.
# Run from anywhere: ./scripts/release-check.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

FAILED=0
WARNINGS=0

pass() { echo "  ✓ PASS: $1"; }
fail() { echo "  ✗ FAIL: $1"; FAILED=1; }
warn() { echo "  ⚠ WARN: $1"; WARNINGS=$((WARNINGS + 1)); }

# ---------------------------------------------------------------------------
echo "=== Version Consistency ==="

PKG_VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
TAURI_VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -1)
TAURI_CARGO_VER=$(sed -n '3s/^version = "\([^"]*\)".*/\1/p' src-tauri/Cargo.toml)
AGENT_VER=$(sed -n '3s/^version = "\([^"]*\)".*/\1/p' agent/Cargo.toml)
CORE_VER=$(sed -n '3s/^version = "\([^"]*\)".*/\1/p' core/Cargo.toml)

ALL_MATCH=true
for name_ver in "src-tauri/tauri.conf.json:$TAURI_VER" \
                "src-tauri/Cargo.toml:$TAURI_CARGO_VER" \
                "agent/Cargo.toml:$AGENT_VER" \
                "core/Cargo.toml:$CORE_VER"; do
    file="${name_ver%%:*}"
    ver="${name_ver#*:}"
    if [ "$ver" != "$PKG_VER" ]; then
        fail "$file has version '$ver', expected '$PKG_VER' (from package.json)"
        ALL_MATCH=false
    fi
done

if [ "$ALL_MATCH" = true ]; then
    pass "All 5 files agree on version $PKG_VER"
fi

VERSION="$PKG_VER"

# ---------------------------------------------------------------------------
echo ""
echo "=== CHANGELOG Dated Section ==="

if grep -qE "^## \[$VERSION\] - [0-9]{4}-[0-9]{2}-[0-9]{2}" CHANGELOG.md; then
    pass "Found dated section for version $VERSION"
else
    fail "No dated section '## [$VERSION] - YYYY-MM-DD' found in CHANGELOG.md"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Stale [Unreleased] Items ==="

# Extract lines between ## [Unreleased] and the next ## [ section
UNRELEASED_CONTENT=$(sed -n '/^## \[Unreleased\]/,/^## \[/{/^## \[/d;p;}' CHANGELOG.md \
    | grep -v '^$' \
    | grep -v '^###' || true)

if [ -n "$UNRELEASED_CONTENT" ]; then
    warn "There are items under [Unreleased] that may need to be moved to the release section"
else
    pass "No stale items under [Unreleased]"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Tests ==="

if pnpm test 2>&1; then
    pass "Frontend tests passed"
else
    fail "Frontend tests failed"
fi

echo ""
if cargo test --workspace --all-features 2>&1; then
    pass "Rust tests passed"
else
    fail "Rust tests failed"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Quality Checks ==="

if ./scripts/check.sh 2>&1; then
    pass "Quality checks passed"
else
    fail "Quality checks failed"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Git Clean Working Tree ==="

if [ -z "$(git status --porcelain)" ]; then
    pass "Working tree is clean"
else
    fail "Working tree has uncommitted changes"
    git status --short
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Branch Check ==="

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" = "main" ] || [[ "$BRANCH" == release/* ]]; then
    pass "On branch '$BRANCH'"
else
    fail "Expected branch 'main' or 'release/*', but on '$BRANCH'"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== TODO/FIXME/HACK Scan ==="

MARKERS=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.rs' \
    -E '\bTODO\b|\bFIXME\b|\bHACK\b' src/ src-tauri/src/ core/src/ agent/src/ 2>/dev/null || true)

if [ -n "$MARKERS" ]; then
    MARKER_COUNT=$(echo "$MARKERS" | wc -l | tr -d ' ')
    warn "Found $MARKER_COUNT TODO/FIXME/HACK markers in source code"
    echo "$MARKERS" | head -20
    if [ "$MARKER_COUNT" -gt 20 ]; then
        echo "  ... and $((MARKER_COUNT - 20)) more"
    fi
else
    pass "No TODO/FIXME/HACK markers found"
fi

# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "  Release Readiness Summary"
echo "==========================================="

if [ "$FAILED" -ne 0 ]; then
    echo "  RESULT: NOT READY — one or more blocking checks failed"
    echo "  Warnings: $WARNINGS"
    exit 1
else
    echo "  RESULT: READY for release"
    if [ "$WARNINGS" -gt 0 ]; then
        echo "  Warnings: $WARNINGS (review recommended)"
    fi
fi
