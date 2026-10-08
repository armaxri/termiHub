---
id: UX2-004
title: "Editor dialogs close on scrim click or Escape and discard work with no dirty check; Tunnel and Workspace editors' Cancel/Esc too"
angle: ux-flows
severity: medium
category: data-loss-guard
is_workaround: false
subsystem: "src/components/ui/Modal"
evidence:
  - src/components/ui/Modal.tsx:90-120
  - src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:232-245
  - src/components/MacroSidebar/MacroEditorDialog.tsx:321-338
  - src/components/Schedules/ScheduleEditorDialog.tsx:130-145
  - src/components/ThemeEditor/ThemeEditor.tsx:161-166
  - src/components/TunnelEditor/TunnelEditor.tsx:330-336
  - src/components/TunnelEditor/TunnelEditor.tsx:446-450
  - src/components/WorkspaceEditor/WorkspaceEditor.tsx:170-176
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The shared Modal forwards Radix's onOpenChange(false) for Escape, the X button and a click on the scrim. It has no dirty or prevent-dismiss option. The multi-step authoring dialogs pass `onOpenChange` straight through and keep their state in local react-hook-form state: WorkflowEditorDialog (multi-step workflows), MacroEditorDialog (step lists), ScheduleEditorDialog, and ThemeEditor (about 20 color picks). One stray click outside the dialog or one Escape throws the work away with no warning. The tab-based TunnelEditor and WorkspaceEditor have the same gap. Their `handleCancel` closes the tab directly, TunnelEditor binds Escape from any field to that cancel (`useEditorKeyboard({ onCancel })`), and neither calls `setEditorDirty`, so the TabBar close guard doesn't cover them. ConnectionEditor got a dirty-guard for exactly this case (UX-006), but its sibling editors did not.

## Why it matters

Building a workflow, macro list, theme, tunnel chain or workspace layout takes minutes. Dismissing with a mis-click or Escape is the most common way to lose that work, and the behaviour differs from the ConnectionEditor, which does warn.

## Evidence

- `src/components/ui/Modal.tsx:90-120`
- `src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:232-245`
- `src/components/MacroSidebar/MacroEditorDialog.tsx:321-338`
- `src/components/Schedules/ScheduleEditorDialog.tsx:130-145`
- `src/components/ThemeEditor/ThemeEditor.tsx:161-166`
- `src/components/TunnelEditor/TunnelEditor.tsx:330-336`
- `src/components/TunnelEditor/TunnelEditor.tsx:446-450`
- `src/components/WorkspaceEditor/WorkspaceEditor.tsx:170-176`

## Recommendation

Give Modal a `confirmDismiss?: () => boolean | Promise<boolean>` (or `dirty?: boolean`) prop. When it is set, intercept `onPointerDownOutside` and `onEscapeKeyDown` and the X, and show the shared UnsavedChangesDialog. Pass `formState.isDirty` from the four editor dialogs. In TunnelEditor and WorkspaceEditor, call `setEditorDirty(tabId, isDirty)` like ConnectionEditor does and route Cancel/Escape through the same guard. Add one test per editor: dirty form + Escape → prompt.

## Verification

Confirmed. Modal passes onOpenChange straight to Radix, and its onEscapeKeyDown blocks Escape only during IME composition. There is no dirty or confirm-dismiss prop. Workflow, Macro, Schedule and Theme editor dialogs contain no isDirty or Unsaved handling, and ThemeEditor maps a dismiss straight to onCancel. TunnelEditor's and WorkspaceEditor's handleCancel call closeTab directly; TunnelEditor wires it to onCancel via useEditorKeyboard. Neither calls setEditorDirty, which only ConnectionEditor, FileEditor and SettingsPanel use. ConnectionEditor alone checks editorDirtyTabs before closing.
