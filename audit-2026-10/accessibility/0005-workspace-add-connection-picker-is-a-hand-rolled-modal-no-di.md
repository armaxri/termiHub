---
id: A11Y2-005
title: "Workspace 'Add Connection' picker is a hand-rolled modal: no dialog role, focus trap, Escape, or close-button name"
angle: accessibility
severity: medium
category: keyboard
is_workaround: false
subsystem: "src/components/WorkspaceEditor"
evidence:
  - src/components/WorkspaceEditor/ConnectionPicker.tsx:74-84
  - src/components/WorkspaceEditor/LayoutDesigner.tsx:120
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

ConnectionPicker renders a full-screen <div className="connection-picker__overlay"> with an <h3> title. It has no role="dialog", no aria-modal, no aria-labelledby, no focus trap, no Escape handler and no focus restore. Its close control is an icon-only <button><X/></button> with no aria-label or title, the only unnamed raw icon button found in src/components. Every other modal in the app uses the Radix-backed Modal primitive.

## Why it matters

WCAG 4.1.2 (A): the close button has no accessible name, and the dialog has neither role nor name. Without a focus trap, Tab walks into the obscured workspace editor behind the overlay (2.4.3 Focus Order), and there is no keyboard way to dismiss it other than finding the unnamed button. A screen-reader user cannot tell a dialog opened.

## Recommendation

Rebuild ConnectionPicker on the shared Modal primitive (title="Add Connection"), which provides role=dialog, aria-modal, focus trap, Escape and focus restore. If it stays custom, at minimum add role="dialog" aria-modal="true" aria-labelledby to the h3 id, an Escape handler calling onCancel, and aria-label="Close" on the X button.

## Verification

Confirmed. ConnectionPicker.tsx has no role, aria attribute or Escape handler anywhere, and its close <button><X/></button> has no aria-label.
