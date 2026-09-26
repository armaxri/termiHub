---
id: PROD-047
title: Manual workflow runs target only the active terminal (no run-on-many/broadcast)
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/store/appStore
evidence:
  - src/store/appStore.ts:7266
  - src/store/appStore.ts:3943
status: partial
resolution: "#3421 — manual run on selected sessions / broadcast group (sequential); concurrent fan-out #3418"
---

## What
Manual/hotkey workflow runs use a single active tab. Only the on-connect trigger binds
connections; there is no run-against-a-set-of-hosts or broadcast run.

## Why it matters
Running a workflow across a selected group of hosts is a primary fleet-automation use case.

## Evidence
- `src/store/appStore.ts:7266` — single `targetTabId`.
- `:3943` — `runWorkflow(workflowId, { targetTabId })`.

## Recommendation
Allow a manual run to target a broadcast scope / selected set of sessions.
