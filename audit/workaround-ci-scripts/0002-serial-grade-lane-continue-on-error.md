---
id: WA-CI-002
title: Windows serial-grade lane is non-blocking (continue-on-error) and only observes
angle: workaround-ci-scripts
severity: medium
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/agent-integration-windows-serial-grade.yml:72
  - .github/workflows/agent-integration-windows-serial-grade.yml:29
status: open
---

## What
`agent-integration-windows-serial-grade.yml` runs the quarantined subset (WA-CI-001) on
`windows-latest`, serially and isolated, on every agent-touching PR — but the job is
`continue-on-error: true` (line 72), so a red iteration cannot fail the run or red any PR.
It runs the tests via `-- --ignored` **without** removing the source `#[ignore]` attributes,
so it purely observes; it never gates.

## Why it matters
This is a deliberate, documented evidence-collector for the #2495 un-quarantine decision, so
it is a *justified* stopgap — but it is still a non-gating lane standing in for real coverage.
Until #2495 lands, Windows agent-integration coverage remains advisory only.

## Evidence
`continue-on-error: true` (line 72); header block lines 28-43 document the intent and the
exact flip-to-blocking steps.

## Recommendation
Tied to WA-CI-001 / #2495. When the grade is green across many consecutive runs:
(1) remove `continue-on-error: true`, (2) delete the `#[cfg_attr(windows, ignore …)]`
attributes so the tests run inside this serial+isolated job per-PR, (3) close #2495. This
lane and WA-CI-003 (manual grade) are both temporary and should be deleted or folded once
the quarantine is lifted.
