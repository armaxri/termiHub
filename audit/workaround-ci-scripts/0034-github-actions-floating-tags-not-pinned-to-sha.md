---
id: WA-CI-034
title: All GitHub Actions are pinned to floating tags (@v6/@v2/@v0/@stable), not SHAs
angle: workaround-ci-scripts
severity: medium
category: supply-chain
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/build.yml:194
  - .github/workflows/auto-close-issues.yml:25
  - .github/workflows/release.yml
status: open
---

## What
Every third-party action is referenced by a mutable tag rather than a pinned commit SHA:
`actions/checkout@v6`, `actions/setup-node@v6`, `Swatinem/rust-cache@v2`,
`taiki-e/install-action@v2`, `astral-sh/setup-uv@v6`, `pnpm/action-setup@v6`,
`dtolnay/rust-toolchain@stable`, and notably `tauri-apps/tauri-action@v0` — a `@v0` tag that
moves across an entire pre-1.0 major line. There is also version drift: `auto-close-issues.yml`
and `agent-cleanup.yml` use `actions/checkout@v4` while the rest use `@v6`.

## Why it matters
Floating tags are the standard supply-chain hazard for CI: the owner (or an attacker who
compromises the action repo) can move a tag to malicious code, and it executes with the
workflow's token on the machine that **builds and signs release artifacts** (`build.yml`,
`release.yml`). `@stable` and `@v0` are the loosest — `tauri-action@v0` can change build/bundle
behavior with no repo change. GitHub's own hardening guidance is to pin actions to full-length
commit SHAs.

## Evidence
`uses:` inventory across `.github/` shows only floating tags; `tauri-apps/tauri-action@v0`
(build.yml:194, release.yml); `actions/checkout@v4` vs `@v6` drift between workflows.

## Recommendation
Pin all third-party actions to full commit SHAs (with a comment naming the tag), at minimum for
the release/build workflows that touch signing and artifacts. Use Dependabot's
`github-actions` ecosystem (or the existing cargo-update-style chore) to bump the SHAs
deliberately. Unify the `checkout@v4`→`@v6` drift. Medium — this is the release build/sign path.
