---
id: WA-CI-010
title: Test-inventory / coverage-gap report is advisory (continue-on-error)
angle: workaround-ci-scripts
severity: info
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:268
  - .github/workflows/code-quality.yml:269
status: open
---

## What
The "Test inventory + coverage-gap report" step in `system-test-machinery`
(`code-quality.yml:268`) runs `build-test-inventory.py` with `continue-on-error: true` and
appends to the step summary. It lists feature areas with zero automated/manual coverage but
never fails the build.

## Why it matters
Intended-advisory (#1950): a coverage gap is surfaced, not gated. Harmless and appropriate —
noted only because a coverage-gap report that nobody reads is effectively inert. It is a signal
generator, not a gate.

## Evidence
`continue-on-error: true` (line 269) with the comment at 264-267.

## Recommendation
Keep advisory, but ensure the report is actually consumed pre-release (e.g. a release-check
step that surfaces zero-coverage feature areas for sign-off). No change required to the CI step
itself. Info.
