---
id: CI-011
title: No Rust code-coverage gate
angle: ci-cd
severity: medium
category: test-gap
is_workaround: false
subsystem: .github/workflows/code-quality.yml
evidence:
  - .github/workflows/code-quality.yml:216
  - .github/workflows/code-quality.yml:223
status: open
---

## What
CI enforces a coverage floor only for the **frontend**: `pnpm test:coverage` runs on the ubuntu leg
and fails on a vitest coverage drop (`code-quality.yml:223-225`, #2066). The Rust workspace
(`src-tauri`, `core`, `agent`) runs `cargo test --workspace --all-features` (`:216`) with **no
coverage measurement or floor** at all. The advisory test-inventory/coverage-gap report
(`:268-271`) is a static harness introspection, `continue-on-error`, and covers the Python system
harness — not Rust line/branch coverage.

## Why it matters
The bulk of the safety-critical logic — connection/session management, the agent transport,
reconnect, credential handling, backends — is Rust, and it is the code with **no** coverage signal.
A PR can add an untested Rust module or delete tested paths and CI notices nothing. For a
ventilator-grade backend, the frontend-only coverage gate inverts where the enforcement is most
needed.

## Evidence
`:223` (`if: matrix.os == 'ubuntu-latest'` → `pnpm test:coverage`) is the only coverage gate; the
Rust `cargo test` step has no `cargo-llvm-cov`/`tarpaulin`/threshold.

## Recommendation
Add `cargo-llvm-cov` to one leg with a per-crate floor (start at the current measured level as a
ratchet, matching the vitest approach), at least for `core` and `agent`. Keep it advisory for one or
two cycles to establish the baseline, then make it blocking so Rust coverage cannot regress silently.
