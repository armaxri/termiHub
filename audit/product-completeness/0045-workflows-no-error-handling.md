---
id: PROD-045
title: Workflows have no per-step error handling, continue-on-error, or retry
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/services/workflowRunner
evidence:
  - src/services/workflowRunner.ts:353
status: open
---

## What
The first failing step aborts the whole run. There is no way to mark a step optional, retry
it, or catch/continue on failure.

## Why it matters
Real automations need to tolerate expected failures (a cleanup step that may no-op) or retry
flaky steps; an all-or-nothing runner is fragile.

## Evidence
- `src/services/workflowRunner.ts:353` — returns `failed` immediately on the first non-ok step; no per-step `onError`/`continueOnError`/retry in the model.

## Recommendation
Add per-step `continueOnError` and `retry` options to the workflow step model and runner.
