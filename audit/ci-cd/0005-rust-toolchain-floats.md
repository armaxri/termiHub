---
id: CI-005
title: rust-toolchain@stable floats across all build/test/release jobs
angle: ci-cd
severity: medium
category: reliability
is_workaround: false
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:36
  - .github/workflows/code-quality.yml:178
  - .github/workflows/build.yml:53
  - .github/workflows/release.yml:155
status: open
---

## What
Only the clippy/rustfmt lint job pins the toolchain (`dtolnay/rust-toolchain@1.98.0`,
`code-quality.yml:36`, added by #2549). Every other Rust job — the `tests` matrix (`:178`), `build`
(`build.yml:53`), `agent`, `dev-build`, `integration-fixtures`, and the entire `release` build —
uses `dtolnay/rust-toolchain@stable`, a moving reference that resolves to whatever the newest stable
release is on the day the job runs.

## Why it matters
The binaries shipped to users are compiled by an unpinned compiler, so the release is not
reproducible: two builds of the same tag on different days can use different rustc versions with
different codegen/soundness behaviour. A new stable can also introduce a build regression that reds
CI (or worse, changes runtime behaviour) with no repo change — the same class of surprise that
motivated pinning the lint job. The pin comment argues non-lint jobs "build/test rather than lint
with `-D warnings`, so a new stable cannot red them the same way" — true for the *lint* failure
mode, but it does not address reproducibility of the shipped artifact.

## Evidence
`code-quality.yml:35-38` pins `@1.98.0` for lint only; all other `dtolnay/rust-toolchain@stable`
occurrences float.

## Recommendation
Pin the release (and ideally all CI) builds to an explicit toolchain — a repo-root
`rust-toolchain.toml` is the standard mechanism and would cover local + CI + release consistently;
bump it as a deliberate chore. If a single repo-wide pin is undesirable, at minimum pin the
`release.yml` and `dev-build.yml` build jobs so the shipped binary is built by a known compiler.
