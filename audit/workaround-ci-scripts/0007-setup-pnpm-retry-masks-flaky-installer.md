---
id: WA-CI-007
title: setup-pnpm composite action retries the installer 3× to mask flakiness
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: .github/actions/setup-pnpm
evidence:
  - .github/actions/setup-pnpm/action.yml:11
  - .github/actions/setup-pnpm/action.yml:15
  - .github/actions/setup-pnpm/action.yml:21
status: open
---

## What
`.github/actions/setup-pnpm/action.yml` runs `pnpm/action-setup@v6` up to three times, with
the first two attempts `continue-on-error: true`, because "the installer (run via npm)
intermittently exits non-zero on GitHub runners — Windows especially." Every workflow uses
this wrapper instead of the upstream action directly.

## Why it matters
This is a retry-around-a-flaky-dependency workaround. It is low-risk (install is idempotent and
deterministic once it succeeds) but it papers over an upstream `pnpm/action-setup` reliability
issue rather than fixing/pinning it. If the installer's failure mode ever changes to a
deterministic error, the 3× retry just triples the wasted minutes before the real failure.

## Evidence
Three `uses: pnpm/action-setup@v6` steps (lines 12, 18, 23); first two `continue-on-error: true`.

## Recommendation
Keep for now (cheap, genuinely reduces flake), but revisit when upstream stabilizes: pin
`pnpm/action-setup` to a SHA and track whether the retry is still needed. If the flake is
network-registry-related, a corepack/`npm_config_registry` mirror or cache may remove the need
for retries entirely. Low priority; not release-blocking.
