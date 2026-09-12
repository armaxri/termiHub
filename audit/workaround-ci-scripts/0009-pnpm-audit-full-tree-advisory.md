---
id: WA-CI-009
title: Full-tree pnpm audit (incl. devDependencies) is advisory (continue-on-error)
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:309
  - .github/workflows/code-quality.yml:311
status: open
---

## What
The Security Audit job runs `pnpm audit --audit-level=moderate` over the full dependency tree
(including devDependencies) with `continue-on-error: true` (line 311). Only the `--prod`-scoped
gate (WA-CI-008) is blocking. Dev/build-time advisories (eslint→minimatch→brace-expansion,
commitlint→ajv→fast-uri, vite→postcss) are surfaced in the log but never fail CI.

## Why it matters
Justified: dev/build-time deps do not ship to users, so gating on them would red PRs for
vulnerabilities that never reach the binary. This is a reasonable scope decision, catalogued
here because it is an intentionally non-gating security step.

## Evidence
`continue-on-error: true  # Dev-only advisories: warn, do not fail` (line 311).

## Recommendation
Keep. The `pnpm.overrides` block (WA-CI-020) already patches several of these transitively.
No release action required beyond periodically promoting a fix to the blocking step once the
upstream dev tool patches land (as the comment already notes). Info/low.
