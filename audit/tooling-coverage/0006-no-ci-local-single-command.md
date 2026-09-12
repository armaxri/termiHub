---
id: TOOL-006
title: No single command reproduces the CI gate locally
angle: tooling-coverage
severity: medium
category: tooling
is_workaround: false
subsystem: scripts / dev-loop
evidence:
  - scripts/check.sh:1
  - scripts/test.sh:1
  - .github/workflows/code-quality.yml:1
status: open
---

## What

Reproducing what CI (`code-quality.yml`) gates on requires running several separate
entry points by hand: `scripts/check.sh` (fmt/lint/clippy/markdown/tauri-drift),
`scripts/test.sh` (frontend + Rust unit), `pnpm test:coverage` (the coverage gate),
`pnpm exec tsc --noEmit` (types), the `cargo audit`/`cargo deny` supply-chain gates,
per-feature isolation builds, and the Python machinery suite. No one script runs the
whole CI-equivalent set, so "did I pass what CI will run?" has no single-command
answer.

## Why it matters

The gap invites local/CI drift: a developer runs `check.sh` + `test.sh`, sees green,
and is still surprised by CI because `tsc --noEmit`, the coverage gate, the per-
feature isolation builds, or `cargo deny` were never run locally. Notably
`scripts/check.sh` does **not** run `tsc --noEmit` even though the CI frontend job
does — so a type error passes local `check.sh` and fails CI. Every such round is a
wasted CI cycle under the "reproduce CI locally" expectation.

## Evidence

- `scripts/check.sh` runs prettier, markdownlint, eslint, cargo fmt, clippy, tauri
  drift — but **not** `tsc --noEmit`, not the coverage gate, not `cargo deny`, not the
  per-feature isolation builds.
- `.github/workflows/code-quality.yml` frontend-quality job additionally runs
  `pnpm exec tsc --noEmit`; the tests job runs `pnpm test:coverage`; security-audit
  runs `cargo deny check`.
- These live in three-plus scripts with no aggregator.

## Recommendation

Add `scripts/ci-local.sh` (+`.cmd`) that runs the full CI-equivalent set in CI order
and stops-or-summarizes like `test.sh` does: `check.sh` → `tsc --noEmit` →
`test.sh` → `pnpm test:coverage` → `cargo deny check` → per-feature isolation builds
→ Python machinery suite. At minimum, **add `tsc --noEmit` to `check.sh`** to close
the most common drift. Document it as the one command to run before a PR, so "green
locally" means "green in CI".
