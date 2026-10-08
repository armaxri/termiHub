---
id: UX2-001
title: "Closing a tab group from its chip X or context menu kills every session in it with no confirmation"
angle: ux-flows
severity: medium
category: destructive-action-guard
is_workaround: false
subsystem: "src/components/Terminal/TabGroupChips"
evidence:
  - src/components/Terminal/TabGroupChips.tsx:44-50
  - src/components/Terminal/TabGroupChips.tsx:151-160
  - src/components/Terminal/TabGroupChips.tsx:173-182
  - src/store/slices/tabGroupsSlice.ts:147-177
  - src/services/contextCommands.ts:161-177
  - src/components/Terminal/TerminalView.tsx:401-422
  - src/components/Terminal/Terminal.tsx:1258-1281
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`handleClose` in TabGroupChips calls `closeTabGroup(groupId)` directly from the always-visible X on every chip (when there is more than one group) and from the chip's "Close Group" context item. `closeTabGroup` removes the group from the layout without checking anything. The group's Terminal components then unmount, and each non-persistent one runs `closeTerminal(sid)`, so every live session in the group ends. Unsaved FileEditor or ConnectionEditor tabs in the group are dropped without the TabBar dirty-guard. The sibling paths are all guarded: closing a single tab with X or middle-click and closing a split panel go through `confirmCloseLiveSession` (ConfirmSessionCloseDialog), and the close-tab-group keyboard shortcut goes through `confirmCloseTabOnShortcut`. Only the mouse path for the largest blast radius has no guard.

## Why it matters

A group can hold many live SSH, serial or agent sessions plus unsaved editors. One mis-click on a 12px X next to the group name ends all of them, loses running remote processes, and offers no undo. The pointer path is also less guarded than the keyboard path for the same action. This is the same class of problem as UX-026 and UX-021.

## Evidence

- `src/components/Terminal/TabGroupChips.tsx:44-50`
- `src/components/Terminal/TabGroupChips.tsx:151-160`
- `src/components/Terminal/TabGroupChips.tsx:173-182`
- `src/store/slices/tabGroupsSlice.ts:147-177`
- `src/services/contextCommands.ts:161-177`
- `src/components/Terminal/TerminalView.tsx:401-422`
- `src/components/Terminal/Terminal.tsx:1258-1281`

## Recommendation

Route both chip close paths through one guard that counts the group's live sessions (`countLiveSessions` over `getAllLeaves(group.rootPanel)`) and its dirty editor tabs. If either count is non-zero and `confirmCloseLiveSession !== false`, raise ConfirmSessionCloseDialog with a new `kind: "group"` ("Close group X? N live sessions will end, M unsaved editors will be discarded"). Reuse it for the shortcut path, and add a test that clicking `tab-group-chip-close` on a group with a live tab opens the dialog.

## Verification

The finding is real. I could not refute it.

- **No guard on the mouse path.** In TabGroupChips.tsx:44-50, `handleClose` only calls `stopPropagation()` and then `closeTabGroup(groupId)`. Both the chip X (lines 151-160) and the "Close Group" context item (lines 173-182) call it with no confirmation.
- **The store action checks nothing either.** `closeTabGroup` in tabGroupsSlice.ts:147-177 only refuses to close the last remaining group. It does not count live sessions or dirty editors.
- **The keyboard path is guarded.** `closeActiveTabGroup` in contextCommands.ts:161-177 raises `setPendingShortcutCloseConfirm({kind:"tab-group"})` when `confirmCloseTabOnShortcut` is on, so the two paths for the same action are inconsistent.
- **Closing a panel is guarded too.** `handleClosePanel` in TerminalView.tsx:401-422 counts live sessions and raises `kind:"panel"` through `confirmCloseLiveSession`. The chip path has neither check.
- **Sessions really end.** TerminalView.tsx:620 shows that terminals in inactive groups stay mounted. Removing the group unmounts them, and the teardown in Terminal.tsx:1258-1281 calls `closeTerminal(sid)` for every session that is not persistent and not moving windows.
- **No deliberate decision found.** Neither audit/FINAL-SUMMARY.md nor docs/architecture.md mentions tab-group closing. No test covers the chip-close path either.

**Why medium rather than high:**

- The X only renders when there are at least two groups.
- It is an explicit close control, not an accidental gesture.
- Persistent-connection tabs only detach, so their backend sessions keep running.
- Nothing is corrupted. The loss is session state, which can be reconnected.

Even so, it is still a real gap: a pointer path with a large blast radius bypasses the guards that its sibling paths enforce.
