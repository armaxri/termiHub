---
id: LIBFE2-006
title: "Remaining ad-hoc id generators bypass the shared ulid newId()"
angle: lib-usage-frontend
severity: info
category: arch
is_workaround: false
subsystem: "src (ids)"
status: fixed
resolution: "#4372 — group, panel, ws-group, wf-lp, network-run and probe ids now come from newId(); module counters deleted"
audit: 2026-10
commit: "663465d52"
relation: new
evidence:
  - src/services/transport/ids.ts:37
  - src/store/layoutHelpers.ts:345
  - src/utils/panelTree.ts:41
  - src/utils/workspaceLayout.ts:662
  - src/store/slices/workflowRunOnTarget.ts:327
  - src/components/NetworkTools/runHistory.ts:57
  - src/components/Sidebar/ConnectionPathDialog.tsx:85
---

## What

LIBFE-001 holds: no bare-`Date.now()` entity ids remain. Six generators the first pass did not list still hand-roll ids: counter + `Math.random().toString(36).slice(2,6)` for tab groups, panels and workspace groups; `Date.now()`+random for local-process run ids; `crypto.randomUUID()` for network-run history; `probe-${id}-${Date.now()}` for path probes. `ws-group-${counter}-${4 base36 chars}` has no time component, and its counter resets on every reload.

## Why it matters

None of these is a demonstrated collision today, since they are either in-memory or have random suffixes. They do continue the drift that LIBFE-001 consolidated, and they leave several id formats and entropy levels for future readers to reason about.

## Recommendation

Replace each with `newId("group")`, `newId("panel")`, `newId("ws-group")`, `newId("wf-lp")`, `newId()` and `newId("probe")`, then delete the module-level counters. These are one-line swaps.

## Verification

Confirmed. generateGroupId, generatePanelId and generateWorkspaceGroupId use a counter plus 4 random base36 characters, and the workspace one has no time component. No collision has been demonstrated, and LIBFE-006 only exempts ids.ts itself. Purely a consistency cleanup.
