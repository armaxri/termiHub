---
id: UISF-017
title: Connection/agent tree rows bypass SidebarListItem and duplicate folder/item row markup between ConnectionList and AgentNode
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/Sidebar
evidence:
  - src/components/Sidebar/ConnectionList.tsx:177
  - src/components/Sidebar/ConnectionList.tsx:410
  - src/components/Sidebar/AgentNode.tsx:499
  - src/components/Sidebar/AgentNode.tsx:217
  - src/components/Sidebar/AgentNode.tsx:1476
  - src/components/SidebarListItem/SidebarListItem.tsx
status: open
---

## What

The six management sidebars (Tunnel, Macro, Workflow, Workspace, RecentSessions, EmbeddedServer)
adopt the shared `SidebarListItem` row shell cleanly. The **tree sidebars do not** — they hand-roll
`connection-tree__*` / `file-browser__*` row markup, and the connection tree and the agent tree
duplicate that markup between two files:

- **Folder row** is near-identical in `ConnectionList.tsx:177-193` and `AgentNode.tsx:499-514` —
  same `<button className="connection-tree__folder…">` + `Folder` icon + `connection-tree__label` +
  chevron, same `paddingLeft: depth*16+8`, same `role="treeitem"`/`aria-expanded`/roving `tabIndex`
  wiring (only `aria-level` differs).
- **Connection/session row**: `ConnectionList.tsx:410-415` and `AgentNode.tsx:217` (agent connection)
  and `AgentNode.tsx:1476-1486` (agent session) each build a raw `<button className="connection-tree__item…">`
  with the className assembled inline (`ConnectionList.tsx:390-394`, `AgentNode.tsx:197-200`) — the
  same `--dragging/--selected/--persistent` modifier scheme, duplicated across files.

## Why it matters

The connection tree is the app's primary and most-used list, yet it shares no row primitive with the
management sidebars, and its own folder/item rows are duplicated between ConnectionList and AgentNode.
The trees have real extra needs (depth indentation, drag-drop, tree ARIA) so they can't use the flat
`SidebarListItem` verbatim — but the row's status/badge/name/actions structure and the
folder-row/item-row markup should be shared, not copy-pasted between two 1000+-line files.

## Evidence

- Duplicated folder row: `ConnectionList.tsx:177-193` ≈ `AgentNode.tsx:499-514`.
- Duplicated item row + className assembly: `ConnectionList.tsx:390-394,410-415` ≈
  `AgentNode.tsx:197-200,217` (+ session row `:1476-1486`).
- Shared shell they don't use: `SidebarListItem/SidebarListItem.tsx`.

## Recommendation

Extract shared `TreeFolderRow` and `TreeItemRow` components (depth + drag-drop + tree ARIA aware)
used by both ConnectionList and AgentNode, and factor their status/badge/name/actions content on top
of `SidebarListItem`'s sub-parts (or generalise `SidebarListItem` with a `depth`/tree mode). This
removes the ConnectionList↔AgentNode duplication and brings the trees under the shared row
foundation.
