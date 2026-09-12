---
id: TOOL-008
title: No unused-dependency detection (cargo-machete / knip / depcheck)
angle: tooling-coverage
severity: medium
category: supply-chain
is_workaround: false
subsystem: ci / dependencies
evidence:
  - .github/workflows/code-quality.yml:290
  - Cargo.toml:1
  - package.json:22
status: open
---

## What

Nothing detects unused dependencies in either ecosystem. The supply-chain tooling
that exists — `cargo-audit`, `cargo-deny`, `pnpm audit` — checks for
vulnerabilities, yanks, licenses, and sources, but **not** for dependencies that are
declared and never used. There is no `cargo-machete`/`cargo-udeps` for Rust and no
`knip`/`depcheck` for the frontend.

## Why it matters

Unused dependencies are dead supply-chain surface: they enlarge the audited tree,
carry advisories the project must triage for no benefit, bloat the binary/bundle, and
slow builds. For a security-conscious pre-release the smallest honest dependency tree
is the goal, and today nothing flags a dep that could simply be removed. The project
already curates `pnpm.overrides` heavily — an unused-dep check is the natural
complement that keeps that surface minimal.

## Evidence

- `.github/workflows/code-quality.yml` security-audit job runs `cargo audit`,
  `cargo deny check advisories bans licenses sources`, and `pnpm audit` — none of
  which report unused deps.
- No `cargo-machete`/`cargo-udeps`/`knip`/`depcheck` reference in `scripts/`,
  `package.json`, `Cargo.toml`, or `.github/workflows/`.

## Recommendation

- **Rust**: add `cargo-machete` (fast, stable-toolchain, no build) as a CI step via
  `taiki-e/install-action`; run `cargo machete` across the workspace. (`cargo-udeps`
  is more thorough but needs nightly — machete is the pragmatic default.)
- **Frontend**: add `knip` (covers unused deps *and* unused exports/files — see
  TOOL-009) or `depcheck` for deps only. Start advisory, then make blocking once the
  tree is clean.
- Wire both into `scripts/check.sh`/`ci-local.sh` so they run locally too.
