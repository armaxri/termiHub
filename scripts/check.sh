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
echo "=== Markdown: markdownlint ==="
if pnpm run markdownlint; then
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
echo "=== Tauri npm/crate version drift ==="
# Drift here aborts 'pnpm tauri build' before it starts (issue #1014).
if node scripts/internal/check-tauri-version-drift.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Rust toolchain pin / rust-version consistency ==="
# .github/rust-version vs workspace + rdp-sidecar rust-version (CI-005, SUP-011).
if node scripts/internal/check-rust-version.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== First-party crate policy (release profile + no-panic lints) ==="
# rdp-sidecar release overflow-checks/strip mirror the root; every crate root
# denies unwrap/expect/panic (ERR-010, TOOL-010, #4343).
if node scripts/internal/check-crate-policy.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== pnpm overrides documented and live ==="
# Every pnpm.overrides entry has a row in docs/supply-chain.md; none dead (WA-CI-020).
if node scripts/internal/check-pnpm-overrides.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== IPC invoke argument contract ==="
# invoke() arg keys vs #[tauri::command] param names (#3488), and no orphan
# registered commands without a production caller (#4344).
if node scripts/internal/check-invoke-contract.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== uv version pin consistency ==="
# .github/uv-version is the only uv pin; no direct astral-sh/setup-uv (WA-CI-017).
if node scripts/internal/check-uv-version.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== cross-rs pin consistency ==="
# .github/cross-version is the only cross-rs pin; CI installs via setup-cross (#4360).
if node scripts/internal/check-cross-version.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== cargo tool pin consistency ==="
# Every taiki-e/install-action tool pinned to its version in .github/cargo-tools.json (#4406).
if node scripts/internal/check-cargo-tool-pins.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== GitHub Actions pin consistency ==="
# Every third-party action pinned to ONE full commit SHA with a version comment (#4360).
if node scripts/internal/check-action-pins.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== GitHub Actions cache save gates ==="
# Every cache save in CI is gated to develop/main (#5328, #3328 reader/writer split).
if node scripts/internal/check-cache-save-gates.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== apt download retries ==="
# Every apt-get update/install in CI, Dockerfiles and scripts retries downloads (#5152).
if node scripts/internal/check-apt-retries.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Doc code-reference drift ==="
# Symbol-based `file` -> `Symbol` references in reference docs resolve (#4369).
if node scripts/internal/check-doc-symbols.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Concept index ==="
# Every docs/concepts/<status>/*.html is linked from docs/concepts/README.md (#4924).
if node scripts/internal/check-concept-index.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== README / app parity ==="
# README.md's Activity Bar views, SSH auth methods and shortcut table match the code (#4924).
if node scripts/internal/check-readme-parity.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Marketing draft stamps ==="
# Every docs/marketing draft carries one "Last verified" stamp (#4924).
if node scripts/internal/check-marketing-drafts.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== ADR-14 projection region list ==="
# Every registered projection region is named in ADR-14's status paragraph (#4586).
if node scripts/internal/check-adr14-regions.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== No cfg!(test) in non-test Rust code ==="
# The tested binary must be the shipped one: inject a flag/trait instead (#5163).
if node scripts/internal/check-no-cfg-test.mjs; then
    echo "PASS"
else
    FAILED=1
fi

echo ""
echo "=== Every #[ignore] is bound to a lane, manual id or issue ==="
# An ignored test must name what runs it; see docs/testing.md (#5177).
if node scripts/internal/check-ignored-tests.mjs; then
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
