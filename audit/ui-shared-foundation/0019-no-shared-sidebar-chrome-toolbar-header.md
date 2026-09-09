---
id: UISF-019
title: No shared sidebar chrome — every sidebar reinvents its toolbar/actions bar, header, and export/import buttons
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/Sidebar
evidence:
  - src/components/TunnelSidebar/TunnelSidebar.tsx:135
  - src/components/MacroSidebar/MacroSidebar.tsx:226
  - src/components/WorkflowSidebar/WorkflowSidebar.tsx:285
  - src/components/WorkspaceSidebar/WorkspaceSidebar.tsx:161
  - src/components/EmbeddedServerSidebar/EmbeddedServerSidebar.tsx:145
  - src/components/RecentSessionsSidebar/RecentSessionsSidebar.tsx:147
  - src/components/Sidebar/ConnectionList.tsx:1271
status: open
---

## What

Beyond the row primitive (`SidebarListItem`), sidebars have no shared "chrome" primitives, so each
reinvents its top toolbar/actions bar and its group headers:

- **Toolbar / actions bar** — every management sidebar opens with its own `X-sidebar__actions` div of
  ghost Buttons, each with a per-directory `__actions` CSS rule: TunnelSidebar.tsx:135-146,
  MacroSidebar.tsx:226-262, WorkflowSidebar.tsx:285-354, WorkspaceSidebar.tsx:161-208,
  EmbeddedServerSidebar.tsx:145-155, RecentSessionsSidebar.tsx:147-160.
- **Export/Import button pair** — the `Download`/`Upload` iconOnly ghost-button pair is repeated
  verbatim in Macro (`:239-261`), Workflow (`:331-353`), and Workspace (`:186-207`).
- **Group headers** inside ConnectionList are duplicated: the Connections group header
  (`ConnectionList.tsx:1271-1333`) and the Remote Agents group header (`:1410-1436`) are near-identical
  (`connection-list__group-header` > raw `connection-list__group-toggle` button + chevron +
  `connection-list__group-actions` ghost Buttons).

(Empty-state and search-box reinvention across these same sidebars are covered by UISF-002 and
UISF-004 respectively; this finding is the toolbar/header/actions chrome.)

## Why it matters

The toolbar, group header, and export/import affordances look and behave slightly differently per
sidebar and each carries its own CSS, so adding a new management sidebar means re-copying the chrome
again. A small `SidebarChrome` set would make new sidebars consistent by construction and remove the
duplicated export/import pair and group-header markup.

## Evidence

See frontmatter. Seven `__actions` toolbars, the triplicated Download/Upload pair, and the two
near-identical ConnectionList group headers.

## Recommendation

Extract `SidebarToolbar` (actions bar), `SidebarGroupHeader` (collapsible header + actions slot), and
a reusable `ExportImportButtons` control. Compose all sidebars from them. Combined with UISF-002
(EmptyState) and UISF-004 (SearchInput), this makes a sidebar = toolbar + search + list of
`SidebarListItem` + empty-state, all from shared parts.
