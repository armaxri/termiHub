---
id: PROD-046
title: Workflows keep no persisted run history/logs
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/store/workflowRunBridge
evidence:
  - src/store/workflowRunBridge.ts:62
  - src/store/workflowRunBridge.ts:275
status: open
---

## What
Only the in-flight run and a bounded 1000-line local-process output buffer (cleared on
dismiss) are kept. There is no persisted history of past runs, their outcomes, or captured
output.

## Why it matters
Users want to review whether last night's workflow succeeded and see its output; nothing is
retained after the run ends.

## Evidence
- `src/store/workflowRunBridge.ts:62` — `WORKFLOW_RUN_OUTPUT_MAX_LINES = 1000`; `:275` clears output.
- Projection models only the current run/output (`:91`); no run-history store.

## Recommendation
Persist a run-history log (workflow, start/end, per-step status, truncated output) and surface
a "Runs" view.
