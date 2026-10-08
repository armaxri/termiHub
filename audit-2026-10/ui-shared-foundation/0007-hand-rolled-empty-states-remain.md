---
id: UISF2-007
title: "About 35 hand-rolled empty/no-results placeholders remain beside ui/EmptyState, including in the consolidated management sidebars"
angle: ui-shared-foundation
severity: low
category: ui
is_workaround: false
subsystem: "src/components"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: previous-incomplete
previous_id: UISF-002
evidence:
  - src/components/MacroSidebar/MacroSidebar.tsx:264
  - src/components/MacroSidebar/MacroSidebar.tsx:284
  - src/components/WorkflowSidebar/WorkflowSidebar.tsx:353
  - src/components/WorkflowSidebar/WorkflowSidebar.tsx:364
  - src/components/TunnelSidebar/TunnelSidebar.tsx:173
  - src/components/WorkspaceSidebar/WorkspaceSidebar.tsx:273
  - src/components/RecentSessionsSidebar/RecentSessionsSidebar.tsx:179
  - src/components/WorkspaceEditor/ConnectionPicker.tsx:200
  - src/components/LogViewer/LogViewer.tsx:205
  - src/components/Schedules/SchedulesSection.tsx:126
  - src/components/NetworkTools/WolPanel.tsx:210
  - src/components/NetworkTools/OpenPortsPanel.tsx:173
  - src/components/ConnectionEditor/SshConfigImportDialog.tsx:89
  - src/components/Sidebar/FileBookmarksDialog.tsx:85
  - src/components/Spawn/SpawnPicker.tsx:274
---

## What

ui/EmptyState (inline/panel/card, loading, action slot, role=status by default) exists and 32 files use it. About 35 sites still render bespoke `<div|p className="x__empty|x__placeholder">` markup with per-file CSS. These include the empty and no-results states of all six management sidebars that UISF-017/019/020 otherwise consolidated, the network-tool panels, the SSH import dialogs, LogViewer, and SpawnPicker's loading line. `role="status"` is inconsistent across them; for example LogViewer:205 and WolPanel:210 have none.

## Why it matters

The empty-state look and its announcement behaviour still vary by feature. The sidebars use toolbar, search and list from shared parts but not the empty state, and every new list keeps copying a `__empty` class. The UISF-002 fix migrated the cited sites only; the pattern has persisted and grown elsewhere.

## Evidence

- `src/components/MacroSidebar/MacroSidebar.tsx:264`
- `src/components/MacroSidebar/MacroSidebar.tsx:284`
- `src/components/WorkflowSidebar/WorkflowSidebar.tsx:353`
- `src/components/WorkflowSidebar/WorkflowSidebar.tsx:364`
- `src/components/TunnelSidebar/TunnelSidebar.tsx:173`
- `src/components/WorkspaceSidebar/WorkspaceSidebar.tsx:273`
- `src/components/RecentSessionsSidebar/RecentSessionsSidebar.tsx:179`
- `src/components/WorkspaceEditor/ConnectionPicker.tsx:200`
- `src/components/LogViewer/LogViewer.tsx:205`
- `src/components/Schedules/SchedulesSection.tsx:126`
- `src/components/NetworkTools/WolPanel.tsx:210`
- `src/components/NetworkTools/OpenPortsPanel.tsx:173`
- `src/components/ConnectionEditor/SshConfigImportDialog.tsx:89`
- `src/components/Sidebar/FileBookmarksDialog.tsx:85`
- `src/components/Spawn/SpawnPicker.tsx:274`

## Recommendation

Do a mechanical sweep replacing `x__empty`/`x__placeholder` with `<EmptyState title=… action=… data-testid=…/>` (the `inline` variant for lists, `panel` for network/settings panels, `loading` for SpawnPicker). Keep the existing data-testids. Delete the orphaned CSS. Add a tokenDiscipline-style test that flags new `__empty"` class literals in TSX.

## Verification

Confirmed in spot checks. MacroSidebar:264, LogViewer:205 and WolPanel:210 use bespoke **empty/**placeholder divs, and LogViewer and WolPanel have no role=status. I did not verify the exact count of about 35, but the pattern clearly persists beside ui/EmptyState.
