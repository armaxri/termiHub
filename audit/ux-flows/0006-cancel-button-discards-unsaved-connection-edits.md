---
id: UX-006
title: Connection editor Cancel button discards unsaved edits without the dirty guard
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/ConnectionEditor
evidence:
  - src/components/ConnectionEditor/ConnectionEditor.tsx:1061
  - src/components/ConnectionEditor/ConnectionEditor.tsx:1068
  - src/components/ConnectionEditor/ConnectionEditor.tsx:680
status: open
---

## What
The connection editor guards against data loss on Escape and on tab-close, but **not** on the
visible Cancel button. `handleEscapeCancel` (`ConnectionEditor.tsx:1068-1075`) checks
`editorDirtyTabs[tabId]` and, when dirty, opens the Unsaved-Changes confirmation dialog. The Cancel
button, however, is wired to `handleCancel` (`:1061-1063`, used at `:1442`), which calls
`closeThisTab()` directly. `closeThisTab` (`:680-685`) just calls `closeTab(tabId, leaf.id)` with
no dirty check (confirmed: the escape handler needs its own guard precisely because closeThisTab
does not have one). So clicking Cancel on a dirty form throws the edits away instantly, with no
confirmation.

## Why it matters
The most obvious "back out" affordance is the *only* exit without the data-loss guard, and it is
inconsistent with Escape and tab-close, which both prompt. A user who spent time filling out an SSH
form loses everything on a misclick of the button that is supposed to be the safe way out.

## Evidence
- `ConnectionEditor.tsx:1061-1063` — `handleCancel` → `closeThisTab()` (no guard).
- `ConnectionEditor.tsx:1068-1075` — `handleEscapeCancel` → dirty check → `setPendingCloseRequest`.
- `ConnectionEditor.tsx:680-685` — `closeThisTab` → `closeTab` directly.

## Recommendation
Route the Cancel button through the same dirty-check guard as Escape/tab-close (call
`handleEscapeCancel`, or share a single guarded close path). The confirmation infrastructure
(`UnsavedChangesDialog`, `pendingCloseRequest`) already exists.
