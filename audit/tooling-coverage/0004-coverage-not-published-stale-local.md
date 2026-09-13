---
id: TOOL-004
title: Coverage is never published from CI; stale local coverage/ dir misleads
angle: tooling-coverage
severity: medium
category: tooling
is_workaround: false
subsystem: ci / coverage
evidence:
  - .github/workflows/code-quality.yml:223
  - .gitignore:16
  - coverage/index.html:1
status: open
---

## What

The frontend coverage report generated in CI (`pnpm test:coverage`) is used only to
enforce the vitest thresholds and is then **discarded** — it is never uploaded as a
workflow artifact, posted as a PR comment, or sent to a coverage service. So no
reviewer or release manager can see the coverage HTML, the per-file breakdown, or a
per-PR delta without running it locally.

Separately, the checked-out working tree carries a `coverage/` directory dated
**2026-07-30 (~6 weeks stale)**. It is correctly **gitignored** (not committed), so
this is a local dev artifact rather than a repo problem — but it is stale enough to
mislead anyone who opens it expecting current numbers.

## Why it matters

Coverage that cannot be seen cannot inform review or release decisions. The gate is
pass/fail only; the actual number and its trend are invisible in the PR. When the
unified number lands (TOOL-001), it must be visible to be useful — otherwise it is
just another opaque green check. The stale local `coverage/` is a lesser nuisance
but reinforces the need for CI to be the single source of truth for coverage.

## Evidence

- `.github/workflows/code-quality.yml:223` — `pnpm test:coverage` runs, but there is
  no subsequent `actions/upload-artifact`, Codecov, or PR-comment step.
- `.gitignore:16` — `coverage` is ignored; the `.gitignore` comment (line ~76) notes
  CI "regenerates and verifies coverage instead of diffing it" (#1528) — the right
  call, but CI never *surfaces* it.
- `coverage/index.html` on disk is dated 2026-07-30 in this checkout.

## Recommendation

- Upload the (merged, whole-app) coverage HTML + lcov as a CI **artifact** on every
  run, and either post a PR summary comment or adopt **Codecov** (which also unifies
  the frontend+Rust lcov flags into one number and renders per-PR deltas — a clean
  fit for TOOL-001's merge step).
- Document that the local `coverage/` dir is a disposable, regenerated artifact
  (already gitignored); optionally have `scripts/clean.sh` remove it.
