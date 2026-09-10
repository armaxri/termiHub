# termiHub full-stack audit — 2026-09

A comprehensive, multi-angle pre-release audit of termiHub. The goal is to surface
**every gap, defect, and — especially — every workaround**, so the app can be fixed and
released *without workarounds*.

The audit is run by a team of expert agents, each covering one angle. Every distinct
finding is captured as **one markdown file** so findings can be triaged, assigned, and
closed independently.

## Layout

```
audit/
  README.md            <- this file
  AUDIT-PLAN.md        <- the expert roster + live status of each angle
  <angle-slug>/
    _summary.md        <- the expert's overview + finding index for that angle
    NNNN-<slug>.md     <- one file per finding
```

## Finding file schema

Every finding file starts with YAML frontmatter, then prose:

```markdown
---
id: <ANGLE>-<NNN>          # e.g. SEC-014
title: <short imperative title>
angle: <angle name>
severity: critical | high | medium | low | info
category: bug | missing-feature | workaround | ux | ui | a11y | arch | perf | security | test-gap | tooling | docs | reliability | i18n | packaging | supply-chain
is_workaround: true | false   # true if this is a temporary hack / stopgap / disabled check to remove before release
subsystem: <path or area, e.g. core/backends/ssh>
evidence:
  - path/to/file.ext:LINE
status: open
---

## What
Concise statement of the finding.

## Why it matters
Impact — user-facing, correctness, security, release-blocking, etc.

## Evidence
Concrete pointers (file:line), quoted snippets, reproduction where relevant.

## Recommendation
How to fix it properly. For workarounds: what the workaround is, why it exists, and
what the real fix that lets us delete it looks like.
```

## Severity guide

- **critical** — release blocker: data loss, security hole, crash on common path, or a
  workaround masking a real defect on a safety-critical path.
- **high** — significant defect / missing core feature / workaround that will bite users.
- **medium** — real problem, has a workaround or limited blast radius.
- **low** — polish, minor inconsistency.
- **info** — observation / suggestion, not a defect.

## The workaround mandate

`is_workaround: true` is reserved for anything shipped as a stopgap: `TODO/FIXME/HACK`,
hardcoded values that should be dynamic, disabled/quarantined/ignored tests, suppressed
lints, `continue-on-error` in CI, platform skips, feature flags left off that hide
finished work, dead fallback code kept "just in case", `@ts-ignore`/`unwrap()` on real
paths, etc. These are collected so they can be removed before release.
