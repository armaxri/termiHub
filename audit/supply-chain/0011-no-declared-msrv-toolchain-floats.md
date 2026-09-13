---
id: SUP-011
title: No declared MSRV / pinned build toolchain — build & test lanes float on @stable
angle: supply-chain
severity: low
category: tooling
is_workaround: false
subsystem: workspace
evidence:
  - .github/workflows/code-quality.yml:36
  - .github/workflows/code-quality.yml:178
status: open
---

## What

There is no `rust-toolchain.toml` at the repo root and no `rust-version` (MSRV)
field in any crate's `Cargo.toml`. Only the clippy/rustfmt lint job pins a
toolchain (`dtolnay/rust-toolchain@1.98.0`, added in #2549 to stop new lints
reddening PRs). The **build and test** matrix, the `Security Audit` job, and the
`cargo-update-lockfile` chore all use `dtolnay/rust-toolchain@stable` — i.e. they
compile, test, and audit the shipping binary against whatever `stable` happens to
be on each runner on each run.

## Why it matters

For a safety-critical release, "which compiler built the shipped artifact" is a
reproducibility and supply-chain-provenance question. A floating `@stable` means:
(1) two builds of the same commit can be produced by different rustc versions; a
codegen or std-behavior change between releases lands with no signal; (2) there is
no declared minimum supported toolchain, so a contributor's build passing locally
is not evidence the release toolchain accepts it; (3) release builds have no
recorded toolchain provenance to reference if a compiler-level advisory (or a
miscompilation) is later attributed to a specific rustc version. The lint job's
own comment acknowledges the floating-stable hazard for its narrow case; the same
hazard applies, more consequentially, to the build itself.

## Evidence

- `.github/workflows/code-quality.yml:35-38` — lint toolchain pinned to `1.98.0`,
  with a comment on why floating stable is a problem for lints.
- `.github/workflows/code-quality.yml:177-178, 313-314` — build/test and Security
  Audit jobs use `@stable`.
- No `rust-toolchain.toml` at repo root; no `rust-version` in the crate manifests.

## Recommendation

Declare a minimum supported Rust version (`rust-version` in the workspace
manifests) and pin the **release** build to a specific toolchain (either a
release-lane `rust-toolchain.toml` or an explicit `dtolnay/rust-toolchain@<ver>`
in `release.yml`/`build.yml`), bumped deliberately as a chore — the same pattern
already applied to the lint job. Leaving local dev and non-release CI on `@stable`
is fine; the goal is a recorded, reproducible toolchain for the artifact that
actually ships.
