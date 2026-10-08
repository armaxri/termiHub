---
id: TOOL2-004
title: "ci-local.sh claims to reproduce 'everything the per-PR CI runs' but has drifted well behind code-quality.yml"
angle: tooling-coverage
severity: low
category: tooling-parity
is_workaround: false
subsystem: "scripts / local CI"
evidence:
  - "scripts/ci-local.sh:42-49"
  - "scripts/ci-local.sh:101-112"
  - "scripts/ci-local.cmd:133-139"
  - ".github/workflows/code-quality.yml:165-182"
  - ".github/workflows/code-quality.yml:191-247"
  - ".github/workflows/code-quality.yml:325-395"
  - ".github/workflows/code-quality.yml:490-540"
  - ".github/workflows/code-quality.yml:542-600"
  - ".github/workflows/code-quality.yml:601-640"
  - ".github/workflows/code-quality.yml:664-760"
  - ".github/workflows/code-quality.yml:1418-1437"
  - "core/Cargo.toml:[features]"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: TOOL-006
---

## What

In both ci-local.sh and ci-local.cmd, the core feature-isolation gate uses a hard-coded list ('keep this list in sync'). The list is missing six features that core/Cargo.toml now defines and that CI derives with `cargo metadata`: agent-update-signing, agent-update-signing-test-support, plugin-index-signing-test-support, ssh-test-support, local-transfer and ftp-test-support.

The 'full' mode also leaves out these per-PR gates: the ts-rs binding and IPC wire-fixture staleness checks, cargo-machete, rdp-sidecar fmt/clippy/test/deny, bundle-size, rustdoc `-D warnings`, the plugin-fuzz-check crate clippy, shellcheck, script parity and headless checks, actionlint, and the testid-drift guard. Even so, it prints 'ALL CI GATES PASSED.'

## Why it matters

TOOL-006's purpose was one honest local reproduction of CI. A green local run now gives false confidence, and contributors and agents still burn CI rounds on gates the script skips. The coordinator's own notes record format and lint slips costing CI rounds. The hard-coded feature list is the same drift the CI step was rewritten to avoid.

## Evidence

- `scripts/ci-local.sh:42-49`
- `scripts/ci-local.sh:101-112`
- `scripts/ci-local.cmd:133-139`
- `.github/workflows/code-quality.yml:165-182`
- `.github/workflows/code-quality.yml:191-247`
- `.github/workflows/code-quality.yml:325-395`
- `.github/workflows/code-quality.yml:490-540`
- `.github/workflows/code-quality.yml:542-600`
- `.github/workflows/code-quality.yml:601-640`
- `.github/workflows/code-quality.yml:664-760`
- `.github/workflows/code-quality.yml:1418-1437`
- `core/Cargo.toml:[features]`

## Recommendation

Derive the feature list the way CI does (`cargo metadata --no-deps --format-version 1 | jq ...`, or a tiny node helper that both .sh and .cmd call). Add the missing cheap, deterministic gates to full mode: the ts-rs/fixture staleness diff, cargo-machete (skip_gate if absent), the rdp-sidecar fmt/clippy/test, shellcheck plus check-script-parity/headless, actionlint (skip_gate if absent) and check-testid-drift.py. Reword the success line to list what was deliberately not reproduced. A drift test that compares the job names in code-quality.yml against a mapping in ci-local would keep the two in sync.

## Verification

Confirmed. ci-local.sh hard-codes CORE_FEATURES as 15 features. core/Cargo.toml also defines agent-update-signing, agent-update-signing-test-support, plugin-index-signing-test-support and ssh-test-support (local-transfer and ftp-test-support also appear in the feature section). CI derives its list with `cargo metadata` (code-quality.yml:167-182). The help text still says 'Full gate — everything the per-PR CI runs', and the script prints 'ALL CI GATES PASSED.' (line 217). Neither ci-local.sh nor check.sh runs shellcheck, actionlint, cargo-machete, the testid-drift check, ts-rs or fixture staleness, rustdoc or rdp-sidecar fmt/clippy/test. The only rdp-sidecar reference in check.sh is the rust-version check. This is a developer-tooling parity gap, so low.
