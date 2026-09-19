---
id: WA-CI-016
title: Clippy/rustfmt toolchain pinned to 1.98.0 to avoid new-lint breakage under -D warnings
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:36
status: open
---

## What
The `rust-quality` lint job pins `dtolnay/rust-toolchain@1.98.0` (line 36) instead of `@stable`
because a floating `@stable` lets any new Rust release introduce clippy lints that fire under
`-D warnings`, reddening every PR with no code change (this blocked all PRs on 2026-08-24,
#2547/#2549). Only the lint job is pinned; the build/test jobs stay `@stable`.

## Why it matters
Pinning is a reasonable, targeted fix — but a *frozen* pin is itself a small workaround: the
toolchain silently ages, new clippy lints (some catching real bugs) are never adopted, and the
pin must be bumped as a deliberate chore or it drifts arbitrarily far from stable.

## Evidence
`uses: dtolnay/rust-toolchain@1.98.0` (line 36) with the #2549 rationale (lines 25-34).

## Recommendation
Correct approach; the only "workaround" residue is the maintenance burden. Add a recurring
"bump clippy toolchain" chore (or a scheduled job that opens a PR bumping the pin, like the
cargo-update chore) so new lints are adopted on purpose. Track the pin version in one place so
it does not go stale. Low.
