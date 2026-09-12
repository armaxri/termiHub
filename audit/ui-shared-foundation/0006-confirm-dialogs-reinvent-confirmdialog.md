---
id: UISF-006
title: Confirm-shaped dialogs hand-roll footer + focus/Enter logic instead of using ui/ConfirmDialog
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/ui/ConfirmDialog
evidence:
  - src/components/Terminal/ConfirmCloseTabDialog.tsx:19
  - src/components/Terminal/ConfirmCloseTabDialog.tsx:57
  - src/components/Terminal/LargePasteDialog.tsx:19
  - src/components/Terminal/RenameDialog.tsx:36
  - src/components/ConnectionEditor/UnsavedChangesDialog.tsx:17
  - src/components/Terminal/CloseWindowDecisionDialog.tsx:61
  - src/components/WorkflowSidebar/LocalProcessAuthDialog.tsx:28
status: open
---

## What

`src/components/ui/ConfirmDialog.tsx` is the shared yes/no / delete-confirm dialog. It already owns
`variant` (danger/warn), `confirmVariant`, `dontAskAgain`, `testIdBase`, footer buttons, and the
subtle **Cancel-focused-on-open + Enter-confirms-unless-Cancel-focused** behaviour
(ConfirmDialog.tsx:145,167-207). Several confirm-shaped dialogs instead import bare `Modal`+`Button`
and re-implement that footer (and sometimes the focus/Enter logic) by hand.

Positive references that do it right: `Sidebar/ConfirmDeleteDialog.tsx:17`,
`Terminal/ConfirmSessionCloseDialog.tsx:59`, `Terminal/ConfirmDetachTabDialog.tsx:46`,
`SessionRestoreDialog.tsx`, `UnlockDialog/UnlockDialog.tsx`.

## Why it matters

`ConfirmCloseTabDialog.tsx` is a near-line-for-line copy of ConfirmDialog internals: the
`cancelBtnRef` + `requestAnimationFrame(...focus())` effect (line 19-23) and the
"Enter confirms unless Cancel is focused" key handler (line 57) both duplicate
ConfirmDialog.tsx:145,167-207, right down to the `confirm-close-tab-cancel`/`-confirm` test-id
convention that `testIdBase` would generate. The other sites drop the safe-focus/Enter behaviour
entirely, so confirm dialogs are inconsistent in keyboard handling — some safe-default-focus, some
not. This is duplicated, drift-prone logic on user-facing confirm paths.

## Evidence

- `Terminal/ConfirmCloseTabDialog.tsx:19-79` — duplicates ConfirmDialog focus + Enter logic + footer.
- `Terminal/LargePasteDialog.tsx:19-27` — hand-rolled Cancel/Paste footer on Modal.
- `Terminal/RenameDialog.tsx:36-49` — hand-rolled Cancel/Rename footer (confirm + single Input body).
- `ConnectionEditor/UnsavedChangesDialog.tsx:17-43` — 3-way (Cancel / Just Close / Save & Close), no safe-focus.
- `Terminal/CloseWindowDecisionDialog.tsx:61-114` — 3-way destructive footer hand-rolled.
- `WorkflowSidebar/LocalProcessAuthDialog.tsx:28-60` — its own doc comment describes ConfirmDialog's
  contract ("the safe default, focused") but does not implement the safe-focus.

## Recommendation

Migrate the two-button confirms (`ConfirmCloseTabDialog`, `LargePasteDialog`, `RenameDialog`) to
`ConfirmDialog` (with a `children` body slot for RenameDialog's Input, which ConfirmDialog already
documents). Extend `ConfirmDialog` with an optional third action to absorb the 3-way decision
dialogs (`UnsavedChangesDialog`, `CloseWindowDecisionDialog`, `LocalProcessAuthDialog`) so the
safe-focus/Enter behaviour is inherited rather than re-omitted.
