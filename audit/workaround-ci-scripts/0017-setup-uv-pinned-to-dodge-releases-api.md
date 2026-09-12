---
id: WA-CI-017
title: setup-uv pinned to 0.11.29 to dodge flaky GitHub Releases API "latest" lookup
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:253
  - .github/workflows/system-integration.yml:175
status: open
---

## What
`astral-sh/setup-uv@v6` is pinned to `version: '0.11.29'` in multiple workflows because,
without an explicit version, the action resolves "latest" through the GitHub Releases API,
which "flakes and fast-fails the whole job on transient API errors — unrelated to the PR"
(#1552).

## Why it matters
Reasonable reproducibility pin, but the same frozen-pin maintenance residue as WA-CI-016: uv
never updates unless someone bumps the string, and it is duplicated across at least two
workflows (`code-quality.yml:253`, `system-integration.yml:175`), so a bump must touch all of
them or they diverge.

## Evidence
`version: '0.11.29'` at `code-quality.yml:253` and `system-integration.yml:175` (both with the
#1552 rationale).

## Recommendation
Keep the pin (correct fix for the flaky "latest" lookup), but centralize the version (a single
env/var or composite action) so it is bumped once, and add it to the periodic toolchain-bump
chore. Low.
