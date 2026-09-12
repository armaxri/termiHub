---
id: UISF-002
title: No shared EmptyState / empty-and-loading primitive — every list/panel reinvents its own
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/ui
evidence:
  - src/components/Sidebar/ConnectionList.tsx:1498
  - src/components/Sidebar/ConnectionList.tsx:1682
  - src/components/Sidebar/FileBrowser.tsx:1634
  - src/components/Settings/FileTypeSettings.tsx:200
  - src/components/Settings/ExternalFilesSettings.tsx:178
  - src/components/Settings/LanguagePackagesSettings.tsx:132
  - src/components/Settings/CustomGrammarsSettings.tsx:263
  - src/components/Settings/SshTrustSettings.tsx:83
  - src/components/Settings/RdpTrustSettings.tsx:84
  - src/components/Settings/TrustedPublishersSettings.tsx:67
  - src/components/OpenConnections/OpenConnectionsModal.tsx:599
  - src/components/SplitView/EmptyWindowState.tsx:42
  - src/components/NetworkTools/NetworkToolsSidebar.tsx:337
  - src/components/Terminal/BroadcastScopeDialog.tsx:201
  - src/components/Terminal/MacroPlaybackDialog.tsx:91
  - src/components/WorkflowSidebar/WorkflowTriggersEditor.tsx:102
  - src/components/ConnectionEditor/IconPickerDialog.tsx:93
status: fixed
resolution: "#2748"
---

## What

There is no shared "empty state" / "no results" / "loading" display primitive in
`src/components/ui/`. Every list and panel that can be empty hand-rolls its own markup + a
per-component BEM class: `connection-list__empty`, `file-browser__empty`, `settings-panel__empty`,
`open-connections__empty`, `network-sidebar__empty`, `broadcast-scope-dialog__empty`,
`macro-playback-dialog__empty`, `workflow-triggers__empty`, `icon-picker__empty`,
`lang-menu__empty`, `split-view__empty`, plus the richer `EmptyWindowState` card in SplitView.

The Settings subtree alone repeats `settings-panel__empty` in **8 panels** — several with the
literal string `"Loading…"` (`SshTrustSettings.tsx:83`, `RdpTrustSettings.tsx:84`,
`TrustedPublishersSettings.tsx:67`) and others with "No … configured." messages
(`FileTypeSettings.tsx:200`, `ExternalFilesSettings.tsx:178`, `LanguagePackagesSettings.tsx:132`,
`CustomGrammarsSettings.tsx:263`).

## Why it matters

Empty-list and loading placeholders are one of the most-repeated UI patterns in the app, yet there
is no single component for them. `SplitView/EmptyWindowState.tsx` is a proper composed empty-state
(icon + title + subtitle + actions) that could have been the shared base, but it lives in a feature
folder and nothing else reuses it. The result is inconsistent copy ("Loading…" vs "No results" vs
"No … configured"), inconsistent structure (some `<p role="status">`, some bare `<div>`), and
double maintenance of near-identical CSS.

## Evidence

- 8× `settings-panel__empty` in `src/components/Settings/` (see evidence list) — three of them are
  a plain `<p className="settings-panel__empty">Loading…</p>` loading placeholder.
- List empties: `Sidebar/ConnectionList.tsx:1498,1682`, `Sidebar/FileBrowser.tsx:1634`,
  `OpenConnections/OpenConnectionsModal.tsx:599,601`, `NetworkTools/NetworkToolsSidebar.tsx:337`.
- Dialog empties: `Terminal/BroadcastScopeDialog.tsx:201`, `Terminal/MacroPlaybackDialog.tsx:91`,
  `ConnectionEditor/IconPickerDialog.tsx:93`, `WorkflowSidebar/WorkflowTriggersEditor.tsx:102`.
- Richer card `SplitView/EmptyWindowState.tsx:42-55` (icon/title/sub/actions) — a good pattern used
  by nobody else.

## Recommendation

Add an `EmptyState` primitive to `src/components/ui/` (optional icon, title, description, optional
action slot, and a `loading` variant that renders the shared Spinner + label). Generalise
`EmptyWindowState` on top of it. Migrate the list/panel/dialog empties above to it and delete the
per-component `__empty` classes. This gives consistent empty/loading copy and one styling home.
