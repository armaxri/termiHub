---
id: A11Y2-008
title: "Some mouse-only click targets: workspace group chips and network-monitor rows"
angle: accessibility
severity: medium
category: keyboard
is_workaround: false
subsystem: "src/components/WorkspaceEditor, src/components/NetworkTools"
evidence:
  - src/components/WorkspaceEditor/WorkspaceEditor.tsx:238-243
  - src/components/WorkspaceEditor/WorkspaceEditor.tsx:261-270
  - src/components/NetworkTools/NetworkToolsSidebar.tsx:84
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

In the workspace editor, switching the active tab group (which decides which layout the LayoutDesigner edits) is an onClick on a plain <div className="workspace-group-chip">. Renaming it is an onDoubleClick on a <span>. Neither has a tabIndex, role or key handler, so keyboard users can only edit group 0's layout. In the Network Tools sidebar, opening a monitor's detail view is an onClick on <div className="network-sidebar__monitor-info">, and the row's other controls (pause/resume/stop) do not open it.

## Why it matters

WCAG 2.1.1 Keyboard (A). Keyboard users cannot configure multi-group workspaces or open an HTTP monitor's history.

## Recommendation

Turn the group chip into a role="tablist" of role="tab" buttons (aria-selected = active), reusing the TabBar roving pattern. Expose rename through F2/Enter and a 'Rename group' button or context-menu item. Make the monitor info area a <button> (aria-label=`Open monitor ${config.url}`).

## Verification

Confirmed. The workspace-group-chip div is onClick-only and rename is onDoubleClick on a span. NetworkToolsSidebar's monitor-info div is onClick-only, with no tabIndex or role.
