---
id: TOOL-013
title: No bundle/binary-size budget check
angle: tooling-coverage
severity: low
category: tooling
is_workaround: false
subsystem: ci / release
evidence:
  - package.json:7
  - .github/workflows/release.yml:1
status: open
---

## What

Nothing tracks or budgets the size of the shipped artifacts — neither the Vite
frontend bundle (`dist/`) nor the Tauri binary/installer sizes. There is no
`size-limit`, `bundlesize`, no `du`-based budget assertion, and no size delta
reported on PRs.

## Why it matters

The project's stated dependency philosophy explicitly favors libraries over custom
code and treats bundle/dep size as "secondary" — a reasonable stance, but it makes a
size *ratchet* more important, not less, because size will trend up by design. Without
a budget, a dependency that adds tens of MB (a heavy Monaco/Shiki/xterm addon, an
accidental non-tree-shaken import) lands invisibly, and the installer users download
grows silently. A size report is cheap insight for a desktop app where download size
is user-facing.

## Evidence

- `package.json` has no `size-limit`/`bundlesize` config or devDependency.
- `.github/workflows/release.yml` builds bundles but asserts nothing about their size.
- No size check in `scripts/build.sh` or `release-check.sh`.

## Recommendation

- Add a lightweight **frontend bundle budget** with `size-limit` (or a `du -sh dist`
  assertion) run in CI on PRs, reporting the delta and failing on a large jump.
- In the release lane, **record installer/binary sizes** per platform as artifacts or
  a step-summary table so size trends are visible release-over-release. Keep it
  advisory initially; a budget can be set once a baseline exists.
