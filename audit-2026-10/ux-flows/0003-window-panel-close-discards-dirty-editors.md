---
id: UX2-003
title: "Closing a window or split panel silently discards unsaved editor tabs"
angle: ux-flows
severity: medium
category: data-loss-guard
is_workaround: false
subsystem: "src/store/slices/windowManagementSlice"
evidence:
  - src/App.tsx:274-288
  - src/store/slices/windowManagementSlice.ts:303-322
  - src/utils/windowClose.ts:31-52
  - src/store/slices/tabOpenersSlice.ts:417
  - src/components/Terminal/TerminalView.tsx:401-422
  - src/components/Terminal/TabBar.tsx:170-190
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`prepareWindowClose` builds its decision only from `classifyWindowCloseSessions`, which keeps only tabs with a `sessionId`. FileEditor tabs are created with `sessionId = null` (createTab(..., "editor")), and ConnectionEditor and Settings tabs have none either. A window whose only content is a dirty remote-file editor or connection editor therefore takes the "proceed" branch and is destroyed at once. The edits are lost with no prompt, and FileEditor keeps no draft or recovery buffer. Split-panel close has the same gap: `handleClosePanel` checks only `countLiveSessions` and ignores `editorDirtyTabs`, so `removePanel` drops a dirty editor. Single-tab close (TabBar) does honour `editorDirtyTabs`, so the guard exists but is skipped by every bulk close.

## Why it matters

Editing a remote config file and then closing the window or a split is a normal gesture. The app already marks the tab dirty (dot on the tab), so the user expects to be asked. Losing an unsaved remote edit with no recovery is real data loss.

## Evidence

- `src/App.tsx:274-288`
- `src/store/slices/windowManagementSlice.ts:303-322`
- `src/utils/windowClose.ts:31-52`
- `src/store/slices/tabOpenersSlice.ts:417`
- `src/components/Terminal/TerminalView.tsx:401-422`
- `src/components/Terminal/TabBar.tsx:170-190`

## Recommendation

Add a dirty-editor check to `prepareWindowClose` and `handleClosePanel`: collect the tabs in scope whose id is set in `editorDirtyTabs`. If any are dirty, show the existing UnsavedChangesDialog pattern (Save all / Discard / Cancel) before the session decision, or add an "N unsaved editors will be discarded" row to the window-close dialog. Unit-test that `prepareWindowClose` returns "prompt" for a window with only a dirty editor tab.

## Verification

Confirmed. prepareWindowClose (windowManagementSlice.ts:303) bases its decision only on classifyWindowCloseSessions, and that function drops every tab without a sessionId (windowClose.ts). So a window holding only FileEditor, ConnectionEditor or Settings tabs returns "proceed" and is destroyed (App.tsx:285). FileEditor and ConnectionEditor do set editorDirtyTabs, but only TabBar's single-tab close and ConnectionEditor read it. handleClosePanel (TerminalView.tsx:401) checks only countLiveSessions and then calls removePanel. I found no draft or recovery buffer in FileEditor.
