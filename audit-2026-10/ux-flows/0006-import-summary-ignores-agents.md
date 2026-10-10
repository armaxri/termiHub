---
id: UX2-006
title: 'Import reports "Nothing imported" when the file''s agents were imported; agents never appear in the summary'
angle: ux-flows
severity: low
category: misleading-feedback
is_workaround: false
subsystem: "src/components/ExportImport"
evidence:
  - src/components/ExportImport/ImportDialog.tsx:22-52
  - src/components/ExportImport/ImportDialog.tsx:199-206
  - src-tauri/src/connection/manager.rs:1216-1221
  - src/types/generated/ConnectionImportResult.ts:7-25
status: fixed
resolution: "#4380 — import result counts agentsImported/agentsSkipped and the summary reports them"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The preview tells the user "Found 0 connections, 3 agents", and the backend import does push every agent not already present into `store.agents`. However, `ConnectionImportResult` has no agent counts, so `importSummary` cannot mention them. For a file with only agents (or only already-existing connections plus new agents), the dialog shows "Nothing imported — the file contains no connections" even though the agents were added. Agents skipped as duplicates are also never reported, unlike connections (#4210).

## Why it matters

This is the misleading-feedback class the previous audit ranked highest: the UI says nothing happened when state changed. A user may import again, or conclude that the agent export is broken.

## Evidence

- `src/components/ExportImport/ImportDialog.tsx:22-52`
- `src/components/ExportImport/ImportDialog.tsx:199-206`
- `src-tauri/src/connection/manager.rs:1216-1221`
- `src/types/generated/ConnectionImportResult.ts:7-25`

## Recommendation

Add `agentsImported` / `agentsSkipped` to `ConnectionImportResult` (count them in the manager.rs:1216 loop) and include them in `importSummary`, e.g. "Imported 3 agents" or "…, skipped 1 agent that already exists". Only show "contains no connections" when the agent counts are zero too. Extend the importSummary unit tests.

## Verification

Confirmed. In manager.rs, the agents loop pushes new agents without counting them, and ConnectionImportResult has no agent fields. When no connections are imported or skipped and no shared credentials come in, importSummary returns "Nothing imported — the file contains no connections", even though agents were added. The preview does show agentCount. The message is wrong, but it only happens for agent-only or agent-plus-duplicates files and nothing is lost, so I rate it low.
