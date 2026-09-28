#!/usr/bin/env bash
# Release readiness checklist — validates that the repo is ready for a release.
# Run from anywhere: ./scripts/release-check.sh
#
# Usage: ./scripts/release-check.sh [--versions-only] [--expect-version <ver>] [--help]
#
# The full run (no flags) gates on: versions, CHANGELOG, unit tests, the coverage
# ratchet, quality checks, a clean tree on main/release/*, green CI integration
# lanes for HEAD (needs gh, logged in), a blocking TODO/FIXME/HACK scan with an
# allowlist, and a real bundle build plus smoke test (needs a display). Slow.
#
#   --versions-only          Run only the version checks (5-file consistency, the
#                            optional expected version, Tauri npm/crate drift) and
#                            exit. No tests, no git/branch checks. This is the mode
#                            the tag-triggered release workflow runs as its
#                            verify-version gate (PKG-007).
#   --expect-version <ver>   Also require every version source to equal <ver>
#                            (e.g. the release tag without its leading "v").
#   --help                   Show this help and exit.
set -euo pipefail

usage() {
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

VERSIONS_ONLY=false
EXPECT_VERSION=""
while [ $# -gt 0 ]; do
    case "$1" in
        --versions-only)
            VERSIONS_ONLY=true
            shift
            ;;
        --expect-version)
            if [ $# -lt 2 ] || [ -z "$2" ]; then
                echo "error: --expect-version needs a value" >&2
                exit 2
            fi
            EXPECT_VERSION="${2#v}"
            shift 2
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument '$1'" >&2
            usage >&2
            exit 2
            ;;
    esac
done

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

if [ -z "$PKG_VER" ]; then
    fail "Could not read a version from package.json"
    ALL_MATCH=false
fi

if [ "$ALL_MATCH" = true ]; then
    pass "All 5 files agree on version $PKG_VER"
fi

if [ -n "$EXPECT_VERSION" ]; then
    if [ "$PKG_VER" = "$EXPECT_VERSION" ]; then
        pass "Repository version $PKG_VER matches the expected version $EXPECT_VERSION"
    else
        fail "Repository version '$PKG_VER' (package.json) does not match the expected version '$EXPECT_VERSION'"
    fi
fi

VERSION="$PKG_VER"

# ---------------------------------------------------------------------------
echo ""
echo "=== Tauri npm/crate Version Drift ==="

# `pnpm tauri build` refuses to build when an @tauri-apps/* npm package and its
# Rust crate drift apart on major/minor (issue #1014). Catch it here instead.
if DRIFT_OUTPUT=$(node scripts/internal/check-tauri-version-drift.mjs 2>&1); then
    echo "$DRIFT_OUTPUT" | sed 's/^/  /'
    pass "Tauri npm packages and Rust crates are aligned"
else
    echo "$DRIFT_OUTPUT" | sed 's/^/  /'
    fail "Tauri npm/crate version drift would block 'pnpm tauri build'"
fi

# ---------------------------------------------------------------------------
if [ "$VERSIONS_ONLY" = true ]; then
    echo ""
    if [ "$FAILED" -ne 0 ]; then
        echo "  RESULT: version checks FAILED"
        exit 1
    fi
    echo "  RESULT: version checks passed"
    exit 0
fi

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
echo "=== Unconsolidated Change Fragments ==="

# Per-branch change fragments live in docs/changes/ (see docs/changes/README.md).
# At release they must be consolidated into CHANGELOG.md and deleted; README.md stays.
FRAGMENTS=$(find docs/changes -type f -name '*.md' ! -name 'README.md' 2>/dev/null || true)

if [ -n "$FRAGMENTS" ]; then
    warn "Unconsolidated change fragments remain in docs/changes/ — consolidate into CHANGELOG.md and delete:"
    echo "$FRAGMENTS" | sed 's/^/    /'
else
    pass "No unconsolidated change fragments under docs/changes/"
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
echo "=== Coverage Ratchet ==="

# Whole-app coverage — frontend + Rust (TOOL-001) — graded against the committed
# per-platform baseline in scripts/coverage-baseline.json (TOOL-011, #3740): a
# per-component line-coverage drop beyond the tolerance FAILS the release gate,
# the same ratchet coverage.yml enforces on develop/main. cargo-llvm-cov is
# required: a release gate that silently skips its coverage check is not a gate.
if ! cargo llvm-cov --version >/dev/null 2>&1; then
    fail "cargo-llvm-cov not installed — cannot grade coverage (install: cargo install cargo-llvm-cov)"
elif ./scripts/coverage.sh 2>&1; then
    pass "Coverage at or above the committed baseline (see coverage-unified/ratchet.md)"
else
    fail "Coverage ratchet failed — coverage dropped below scripts/coverage-baseline.json (or the run failed)"
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
echo "=== Integration / System Tests (CI lanes on this commit) ==="

# The unit tests above never touch the Python bridge integration lane, the
# Docker fixture suites or the agent live tests (TOOL-011, #3750). Running them
# here is not reliable: they need Docker fixtures, a real display and a quiet
# machine, and on macOS the container VMs pin the CPU and stall the WKWebView.
# So the gate is the same one the Release workflow enforces: the newest run of
# 'Release Candidate: Full Integration' and the post-merge Code Quality and Dev
# Build push runs must be green on this exact commit. The check reuses
# scripts/internal/release-integration-gate.mjs, so the local gate and the tag
# gate cannot disagree. It needs the gh CLI, logged in.
HEAD_SHA=$(git rev-parse HEAD)
GATE_REF=$(git rev-parse --abbrev-ref HEAD)
if [ "$GATE_REF" = "HEAD" ]; then
    GATE_REF="RELEASE-BRANCH-OR-TAG"
fi
GATE_REPO="armaxri/termiHub"
if command -v gh >/dev/null 2>&1; then
    GATE_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "$GATE_REPO")
fi
DISPATCH_CMD="gh workflow run release-candidate.yml --repo $GATE_REPO --ref $GATE_REF"
if ! command -v gh >/dev/null 2>&1; then
    fail "gh CLI not installed — cannot verify the integration lanes (https://cli.github.com)"
elif ! GATE_TOKEN=$(gh auth token 2>/dev/null) || [ -z "$GATE_TOKEN" ]; then
    fail "gh CLI not logged in — cannot verify the integration lanes (run: gh auth login)"
elif [ -z "$(git branch -r --contains "$HEAD_SHA" 2>/dev/null)" ]; then
    fail "HEAD $HEAD_SHA is on no remote branch, so no CI run can exist for it"
    echo "    Push it first (git push), then run the full integration lanes on it:"
    echo "      $DISPATCH_CMD"
    echo "    If you pushed it from elsewhere, run 'git fetch' and re-run this script."
elif GATE_OUTPUT=$(RELEASE_GATE_LOCAL=1 RELEASE_SHA="$HEAD_SHA" RELEASE_REF_NAME="$GATE_REF" \
    GITHUB_REPOSITORY="$GATE_REPO" GITHUB_TOKEN="$GATE_TOKEN" \
    node scripts/internal/release-integration-gate.mjs 2>&1); then
    echo "$GATE_OUTPUT" | sed 's/^/    /'
    pass "Integration lanes green on $HEAD_SHA"
else
    echo "$GATE_OUTPUT" | sed 's/^/    /'
    echo "    The dispatched run grades the ref's tip, so dispatch it on a ref whose tip is"
    echo "    $HEAD_SHA (the release branch you are on, or the release tag)."
    fail "Integration lanes not green on $HEAD_SHA — run: $DISPATCH_CMD"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== TODO/FIXME/HACK Scan ==="

# A TODO/FIXME/HACK comment in shipped source BLOCKS the release unless it is
# listed, with a reason, in scripts/release-marker-allowlist.json (TOOL-011,
# #3750; WA-CI-030). Only markers that open a comment count, so string literals
# and test fixtures that mention the words do not trip it. The scan is one Node
# script so this and release-check.cmd run the identical check.
if MARKER_OUTPUT=$(node scripts/internal/release-marker-scan.mjs 2>&1); then
    echo "$MARKER_OUTPUT" | sed 's/^/    /'
    pass "No un-allowlisted TODO/FIXME/HACK markers"
else
    echo "$MARKER_OUTPUT" | sed 's/^/    /'
    fail "TODO/FIXME/HACK markers block the release (allowlist: scripts/release-marker-allowlist.json)"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Release Bundle Build + Smoke Test ==="

# Build the real installable bundle with the same recipe as the installers
# (scripts/build.sh: RDP sidecar + notices + 'pnpm tauri build'), then launch it
# with scripts/smoke-test.sh (TOOL-011, #3750). Without this, release-check could
# report READY for a commit that does not produce a working app. It runs last
# because it is the slowest step and needs a desktop session (a display) to launch
# the app. On headless Linux it uses xvfb-run when available.
case "$(uname -s)" in
    Darwin*)
        SMOKE_APP="target/release/bundle/macos/termiHub.app"
        INSTALLER_GLOB="target/release/bundle/dmg/*.dmg"
        ;;
    MINGW* | MSYS* | CYGWIN*)
        SMOKE_APP="target/release/termihub.exe"
        INSTALLER_GLOB="target/release/bundle/msi/*.msi target/release/bundle/nsis/*.exe"
        ;;
    *)
        SMOKE_APP="target/release/termihub"
        INSTALLER_GLOB="target/release/bundle/deb/*.deb target/release/bundle/appimage/*.AppImage"
        ;;
esac

if ! ./scripts/build.sh 2>&1; then
    fail "Release bundle build failed (scripts/build.sh)"
else
    INSTALLERS=""
    for pattern in $INSTALLER_GLOB; do
        [ -e "$pattern" ] && INSTALLERS="$INSTALLERS $pattern"
    done
    if [ -z "$INSTALLERS" ]; then
        fail "Bundle build produced no installer (expected: $INSTALLER_GLOB)"
    else
        pass "Bundle build produced:$INSTALLERS"
    fi

    SMOKE_CMD=(./scripts/smoke-test.sh "$SMOKE_APP")
    if [ "$(uname -s)" = "Linux" ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] \
        && command -v xvfb-run >/dev/null 2>&1; then
        SMOKE_CMD=(xvfb-run -a "${SMOKE_CMD[@]}")
    fi
    if [ ! -e "$SMOKE_APP" ]; then
        fail "Built app not found at $SMOKE_APP — cannot smoke-test it"
    elif "${SMOKE_CMD[@]}" 2>&1; then
        pass "Smoke test passed against $SMOKE_APP"
    else
        fail "Smoke test failed against $SMOKE_APP"
    fi
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
