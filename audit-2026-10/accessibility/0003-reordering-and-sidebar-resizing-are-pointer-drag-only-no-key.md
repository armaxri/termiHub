---
id: A11Y2-003
title: "Reordering and sidebar resizing are pointer-drag-only (no KeyboardSensor, no single-pointer alternative)"
angle: accessibility
severity: medium
category: keyboard
is_workaround: false
subsystem: "src/components/Settings, src/components/SplitView, src/components/Terminal, src/hooks/useSidebarResize"
evidence:
  - src/components/Settings/ShellIntegrationSettings.tsx:68
  - src/components/Settings/ShellIntegrationSettings.tsx:252
  - src/components/Settings/ShellIntegrationSettings.tsx:364-372
  - src/components/SplitView/SplitView.tsx:311
  - src/components/Terminal/TabGroupChips.tsx:31
  - src/hooks/useSidebarResize.ts:92
  - src/App.tsx:331-335
  - src/components/Sidebar/ConnectionList.tsx:1404-1408
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Every dnd-kit context registers only PointerSensor; there is no KeyboardSensor anywhere in src. Shell-integration quick-access entries can only be reordered by drag, even though order is functional: the UI says 'The first “Always” entry is the default.' Their focusable grip <button aria-label="Drag to reorder"> does nothing from the keyboard. Terminal tab order and tab-group order are drag-only too; only the workflow editor offers move buttons. The sidebar resize handle and the experimental outer separator are bare <div>s with only onMouseDown. They have no role="separator", no tabIndex, no arrow-key handling and no setting to change sidebar width. The split-pane separators use react-resizable-panels and are keyboard-operable, so they are fine.

## Why it matters

WCAG 2.1.1 Keyboard (A) and the new WCAG 2.2 2.5.7 Dragging Movements (AA). Keyboard and switch users cannot choose the default shell-integration entry. Users with tremors who cannot drag cannot reorder tabs or widen a 260px sidebar, which matters at large zoom. The grip button announces an affordance it does not provide.

## Recommendation

Add useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }) to the sortable contexts (ShellIntegrationSettings, TabGroupChips, SplitView tab strip, WorkflowEditorDialog), and/or add Move up/Move down buttons or context-menu items (as WorkflowEditorDialog already does) that call reorderEntries/reorderTabs/reorderTabGroups. Give the sidebar handle role="separator" aria-orientation="vertical" aria-valuenow/min/max and tabIndex=0, with ArrowLeft/Right handling in useSidebarResize (step about 16px, clamped to 170-600).

## Verification

Confirmed. src has no KeyboardSensor. useSidebarResize returns only onMouseDown handleProps, and App.tsx renders the handle as a bare div with no role or tabIndex. Shell-integration reordering is drag-only.
