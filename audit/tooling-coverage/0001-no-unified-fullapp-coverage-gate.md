---
id: TOOL-001
title: No unified whole-app coverage number or release gate (frontend + Rust)
angle: tooling-coverage
severity: high
category: tooling
is_workaround: false
subsystem: ci / coverage
evidence:
  - vitest.config.ts:26
  - .github/workflows/code-quality.yml:218
  - docs/testing.md:393
status: open
---

## What

There is no single command, report, or CI gate that produces one **whole-app**
coverage figure spanning the React/TypeScript frontend and the Rust
backend/agent/core crates. Coverage is measured for the frontend only (vitest v8,
`pnpm test:coverage`), gated on one CI leg. The Rust side is unmeasured entirely
(see TOOL-003). Nothing merges the two into a repo-wide number, and nothing gates
the release on it.

This is the maintainer's explicit flagship ask: *"what tooling would give us a
full-coverage (frontend + backend, unified) picture and gate on it before
release?"* — and the repo currently cannot answer it.

## Why it matters

For a ventilator-grade, pre-release app the coverage claim that matters is
whole-application, and today it is unknowable. The frontend gate can be green while
the safety-critical Rust hot path has arbitrary, unmeasured coverage. Release
readiness (`release-check.sh`) never consults coverage at all. Reviewers cannot see
a trend or a per-PR delta because nothing is published (TOOL-004). The result is a
false sense of safety: a green pipeline says nothing about backend coverage.

## Evidence

- `vitest.config.ts:26` — coverage is frontend-only (v8), thresholds ~75%.
- `.github/workflows/code-quality.yml:218` — `pnpm test:coverage` runs on the Ubuntu
  leg only; there is no Rust coverage step anywhere in `.github/workflows/`.
- `docs/testing.md:393` — "Coverage Goals: Rust Backend >80% line coverage" is
  stated as a target with no tool measuring or enforcing it.
- `scripts/release-check.sh` — the readiness gate never runs or checks coverage.

## Recommendation

Build the unified capability as a script + one CI job:

1. **Frontend**: `vitest run --coverage`, include glob fixed to `src/**/*.{ts,tsx}`
   (TOOL-002), emit `lcov`.
2. **Rust**: add `cargo-llvm-cov` (TOOL-003):
   `cargo llvm-cov --workspace --all-features --lcov --output-path rust.lcov`.
3. **Merge**: both emit lcov — merge with `lcov`/`grcov` (or upload both as flags to
   Codecov) into one repo-wide line/branch number; emit an HTML artifact.
4. **Gate**: enforce a **fail-on-decrease ratchet** on the unified number in one CI
   job. Land it `continue-on-error` for exactly one cycle to establish the baseline,
   then remove `continue-on-error` (that starter flag is the only acceptable
   stopgap). Add a `coverage` step to `release-check.sh`.
5. **Integration**: run the nightly integration lane under `cargo-llvm-cov` and feed
   it into the same merge so the dark lane finally contributes (TOOL-005).

Wrap steps 1–3 in `scripts/coverage.sh` (+`.cmd`) so a developer gets the same
whole-app number locally that CI gates on.
