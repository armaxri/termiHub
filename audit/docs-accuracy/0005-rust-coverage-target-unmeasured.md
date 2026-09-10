---
id: DOC-005
title: docs/testing.md states a ">80% Rust coverage" target that no tooling measures or enforces
angle: docs-accuracy
severity: low
category: docs
is_workaround: false
subsystem: docs/testing
evidence:
  - docs/testing.md:393
  - docs/testing.md:397
status: open
---

## What

`docs/testing.md` "Coverage Goals" states targets of **">80% line coverage"** for the Rust backend
and ">70%" for React components. There is no Rust coverage tooling anywhere in the repo — no
tarpaulin, llvm-cov, grcov, cargo-llvm-cov, or codecov in `scripts/`, `.github/workflows/`, any
`Cargo.toml`, or `package.json`. Nothing measures Rust coverage, so the ">80%" number is
aspirational and unverifiable. (The frontend `pnpm test:coverage` → vitest exists but is not gated.)

## Why it matters

A stated numeric coverage target that nothing measures reads as a real gate and misleads
contributors/reviewers into thinking coverage is tracked. Minor, but it's a claim the codebase
cannot back up.

## Evidence

- `docs/testing.md:393-397` "Target coverage levels: … **Rust Backend**: >80% line coverage;
  **React Components**: >70% coverage".
- Repo-wide search for `tarpaulin|llvm-cov|grcov|cargo-llvm-cov|codecov` returns zero matches.
- Only frontend coverage tooling exists: `docs/testing.md:482` `"test:coverage": "vitest run
  --coverage"` — not enforced in CI.

## Recommendation

Either add Rust coverage tooling (e.g. `cargo-llvm-cov` in the nightly lane) and wire the number
to something real, or reword the section as an aspirational guideline and drop the specific
percentage — don't present an unmeasured target as a coverage goal the project holds itself to.
