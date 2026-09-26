#!/usr/bin/env bash
# Reproduce the per-PR CI gate locally with ONE command (issue TOOL-006).
#
# Run from anywhere:
#   ./scripts/ci-local.sh            # full gate — everything the PR CI runs
#   ./scripts/ci-local.sh --quick    # quality-only subset (no tests/audits/builds)
#   ./scripts/ci-local.sh --help
#
# --quick runs scripts/check.sh (format/lint/clippy/fmt) + tsc + commitlint and
# skips the slow gates (cargo test, coverage, cargo audit/deny, machinery,
# plugin packaging). It mirrors the repo's long-standing "run check.sh before you
# push" guidance and is what the pre-push hook uses; run the full gate before a PR.
#
# This mirrors .github/workflows/code-quality.yml (the per-PR "Code Quality"
# workflow) so a clean run here means a green PR gate. It composes the existing
# scripts/check.sh (formatting/linting/clippy) and adds the steps that gate CI
# but check.sh does not cover: tsc, per-feature core builds, cargo audit/deny,
# the pnpm production-audit gate, the Python machinery suite, plugin packaging,
# and commitlint.
#
# Like CI (fail-fast: false) every gate runs to completion and its own verdict
# is recorded, so one red gate never hides another — the full list is printed at
# the end. Optional external tools (cargo-audit, cargo-deny, uv) are SKIPPED with
# a warning when absent rather than failing the run; a skipped gate means the run
# did not fully reproduce CI and the summary says so.
#
# NOTE: the integration/system E2E lanes and the per-platform test matrix are NOT
# reproduced here — they need Docker fixtures / other OSes and are release-cadence
# lanes, not the per-PR gate. See docs/testing.md.
set -uo pipefail

# Not `set -e`: gates run under `|| status=$?` so one failure never aborts the
# run (CI fail-fast: false), hence the explicit `|| exit` here.
cd "$(git rev-parse --show-toplevel)" || exit 1

MODE="full"
case "${1:-}" in
  --quick) MODE="quick" ;;
  --full | "") MODE="full" ;;
  -h | --help)
    cat <<'EOF'
Reproduce the per-PR CI gate locally (mirrors .github/workflows/code-quality.yml).

Usage:
  ./scripts/ci-local.sh            Full gate — everything the per-PR CI runs.
  ./scripts/ci-local.sh --quick    Quality-only subset (check.sh + tsc + commitlint);
                                   skips tests, coverage, audits, and plugin packaging.
                                   This is what the pre-push git hook runs.
  ./scripts/ci-local.sh --help     Show this help.

Every gate runs to completion (CI fail-fast: false); failures are listed at the end.
Optional tools absent (cargo-audit, cargo-deny, uv) are skipped with a warning.
EOF
    exit 0
    ;;
  *)
    echo "Unknown argument: $1 (use --quick, --full, or --help)" >&2
    exit 2
    ;;
esac

if [ ! -d node_modules ]; then
  echo "node_modules missing, running pnpm install..."
  pnpm install
  echo ""
fi

FAILED=0
FAILED_GATES=""
INCOMPLETE=0

# Run a gate (single command or function), record its verdict, and continue on
# failure so every gate reports its own true result (CI fail-fast: false).
run_gate() {
  local name="$1"
  shift
  echo ""
  echo "=== ${name} ==="
  local status=0
  "$@" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "PASS: ${name}"
  else
    echo "FAIL: ${name} (exit ${status})"
    FAILED=1
    FAILED_GATES="${FAILED_GATES}  - ${name} (exit ${status})"$'\n'
  fi
}

skip_gate() {
  local name="$1" reason="$2"
  echo ""
  echo "=== ${name} ==="
  echo "SKIPPED: ${reason}"
  INCOMPLETE=1
}

# --- gate bodies (compound steps wrapped so run_gate sees one exit code) ------

gate_tsc() { pnpm exec tsc --noEmit; }
gate_markdownlint() { pnpm run markdownlint; }

# rust-quality: clippy termihub-core with each opt-in feature in isolation
# (#3318). Mirrors the CI step, which reads the list from `cargo metadata`; keep
# this list in sync with core/Cargo.toml [features].
CORE_FEATURES="tracing embedded-servers plugin http-monitor serial local-shell telnet ssh
  docker wsl ftp mock-remote-desktop vnc rdp-sidecar"
gate_core_features() {
  cargo clippy -p termihub-core --no-default-features --all-targets -- -D warnings || return 1
  local feature
  for feature in $CORE_FEATURES; do
    cargo clippy -p termihub-core --no-default-features --features "$feature" \
      --all-targets -- -D warnings || return 1
  done
}

gate_rust_tests() { cargo test --workspace --all-features; }
gate_frontend_coverage() { pnpm test:coverage; }
gate_cargo_audit() { cargo audit; }
gate_cargo_deny() { cargo deny check advisories bans licenses sources; }
gate_pnpm_audit_prod() { ./scripts/internal/pnpm-audit-prod-gate.sh; }
gate_machinery() { ./tests/system/pytest.sh -m "not integration" -q; }

gate_package_plugins() {
  ./scripts/package-plugin.sh examples/plugins/solarized-night-theme --out target/plugin-dist --no-build &&
    ./scripts/package-plugin.sh examples/plugins/echo-backend --out target/plugin-dist &&
    ./scripts/package-plugin.sh examples/plugins/log-highlighter --out target/plugin-dist --no-build &&
    ./scripts/package-plugin.sh examples/plugins/clock-widget --out target/plugin-dist --no-build &&
    test -f target/plugin-dist/log-highlighter-1.0.0.termihub-plugin &&
    test -f target/plugin-dist/clock-widget-1.0.0.termihub-plugin &&
    test -f target/plugin-dist/solarized-night-1.0.0.termihub-plugin &&
    test -f target/plugin-dist/echo-backend-1.0.0.termihub-plugin
}

# commit-lint job: lint every commit on this branch since it forked develop.
gate_commitlint() {
  local base=""
  if git rev-parse --verify --quiet origin/develop >/dev/null; then
    base="$(git merge-base HEAD origin/develop 2>/dev/null || true)"
  fi
  if [ -z "$base" ] && git rev-parse --verify --quiet develop >/dev/null; then
    base="$(git merge-base HEAD develop 2>/dev/null || true)"
  fi
  if [ -z "$base" ]; then
    echo "no develop base found to lint against; linting HEAD only"
    pnpm exec commitlint --from "HEAD~1" --to HEAD --verbose
    return
  fi
  if [ "$base" = "$(git rev-parse HEAD)" ]; then
    echo "no commits ahead of develop; nothing to lint"
    return 0
  fi
  pnpm exec commitlint --from "$base" --to HEAD --verbose
}

# --- the gate itself ----------------------------------------------------------

echo "Reproducing the per-PR CI gate locally (mode: ${MODE})"

# check.sh covers: Prettier, markdownlint, ESLint, cargo fmt, clippy, tauri drift.
# Reused wholesale in both modes so those checks are defined in exactly one place.
run_gate "Quality checks (scripts/check.sh)" ./scripts/check.sh

# The one frontend-quality step check.sh omits.
run_gate "Frontend: TypeScript (tsc --noEmit)" gate_tsc

# commitlint (both modes): cheap and catches the header-length/case failures the
# team repeatedly hits.
run_gate "Commit messages (commitlint)" gate_commitlint

if [ "$MODE" = "full" ]; then
  run_gate "Rust: core opt-in features in isolation" gate_core_features
  run_gate "Rust workspace: cargo test" gate_rust_tests
  run_gate "Frontend: vitest + coverage floors" gate_frontend_coverage

  if command -v cargo-audit >/dev/null 2>&1 || cargo audit --version >/dev/null 2>&1; then
    run_gate "Security: cargo audit" gate_cargo_audit
  else
    skip_gate "Security: cargo audit" "cargo-audit not installed (cargo install cargo-audit)"
  fi

  if command -v cargo-deny >/dev/null 2>&1 || cargo deny --version >/dev/null 2>&1; then
    run_gate "Security: cargo deny (supply-chain)" gate_cargo_deny
  else
    skip_gate "Security: cargo deny (supply-chain)" "cargo-deny not installed (cargo install cargo-deny)"
  fi

  run_gate "Security: pnpm audit (production deps)" gate_pnpm_audit_prod

  if command -v uv >/dev/null 2>&1; then
    run_gate "System-test harness (machinery)" gate_machinery
  else
    skip_gate "System-test harness (machinery)" "uv not installed (https://docs.astral.sh/uv/)"
  fi

  run_gate "Package example plugins" gate_package_plugins
fi

echo ""
echo "======================================================================"
if [ "$FAILED" -ne 0 ]; then
  echo "SOME GATES FAILED:"
  printf "%s" "$FAILED_GATES"
  echo "Run ./scripts/format.sh to auto-fix formatting issues."
  exit 1
fi

if [ "$INCOMPLETE" -ne 0 ]; then
  echo "ALL RUN GATES PASSED — but some were SKIPPED (see above), so this run did"
  echo "not fully reproduce CI. Install the missing tools for a complete gate."
  exit 0
fi

if [ "$MODE" = "quick" ]; then
  echo "QUICK GATE PASSED. Run ./scripts/ci-local.sh (no --quick) for the full CI gate."
else
  echo "ALL CI GATES PASSED."
fi
