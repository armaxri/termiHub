---
id: UISF2-001
title: "WorkspaceEditor ConnectionPicker is a hand-rolled modal that bypasses ui/Modal: no dialog role, no Escape, no focus trap, unnamed close button"
angle: ui-shared-foundation
severity: medium
category: a11y
is_workaround: false
subsystem: "src/components/WorkspaceEditor"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src/components/WorkspaceEditor/ConnectionPicker.tsx:73
  - src/components/WorkspaceEditor/ConnectionPicker.tsx:78
  - src/components/WorkspaceEditor/ConnectionPicker.tsx:83
  - src/components/WorkspaceEditor/WorkspaceEditor.css:385
  - src/components/WorkspaceEditor/LayoutDesigner.tsx:120
  - src/components/ui/Modal.tsx:49
---

## What

The 'Add Connection' picker in the workspace layout designer renders its own fixed overlay (`div.connection-picker__overlay` with `position: fixed; background: var(--overlay-bg); z-index: var(--z-sticky)`) and a hand-built header with a raw icon-only `<button className="connection-picker__close">` that contains only `<X/>`. The file has no `role="dialog"`/`aria-modal`, no Escape handler, and no focus trap or focus restore. About 66 other dialogs build on ui/Modal (Radix Dialog), which provides all of these.

## Why it matters

Keyboard and screen-reader users get a modal-looking surface that is not a modal. Tab leaves the picker and reaches the editor behind the scrim. Escape does nothing. The close button has no accessible name. Focus is not returned to the leaf's '+' button on close. The overlay uses z-sticky instead of the modal layer, so other portalled layers can stack above it. This is the one picker dialog that skipped the shared Modal foundation.

## Evidence

- `src/components/WorkspaceEditor/ConnectionPicker.tsx:73`
- `src/components/WorkspaceEditor/ConnectionPicker.tsx:78`
- `src/components/WorkspaceEditor/ConnectionPicker.tsx:83`
- `src/components/WorkspaceEditor/WorkspaceEditor.css:385`
- `src/components/WorkspaceEditor/LayoutDesigner.tsx:120`
- `src/components/ui/Modal.tsx:49`

## Recommendation

Rebuild ConnectionPicker on `<Modal open title="Add Connection" onOpenChange={(o)=>!o&&onCancel()}>` and drop the bespoke overlay/header/close CSS. Keep SearchInput as the autofocus target. Render the list items as buttons inside the Modal body, or reuse useRovingListNav for arrow-key navigation. Delete `.connection-picker__overlay`/`__close` from WorkspaceEditor.css.

## Verification

Confirmed. ConnectionPicker.tsx:73-83 renders a bespoke div overlay with no role=dialog, aria-modal, Escape handler or focus trap. The close button contains only <X/> and has no aria-label. The CSS at WorkspaceEditor.css:385 uses z-index var(--z-sticky). I found no ADR or audit note that makes this a deliberate choice.
