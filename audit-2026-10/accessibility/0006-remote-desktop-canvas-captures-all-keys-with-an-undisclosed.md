---
id: A11Y2-006
title: "Remote-desktop canvas captures all keys with an undisclosed escape chord, no accessible name, and no focus indicator"
angle: accessibility
severity: medium
category: keyboard
is_workaround: false
subsystem: "src/components/RemoteDesktop"
evidence:
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:393-410
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:415-431
  - src/components/RemoteDesktop/RemoteDesktopTab.css:38-41
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The VNC/RDP <canvas tabIndex={0}> calls preventDefault and stopPropagation on every key, including Tab, so focus cannot leave it by keyboard. The only exit is Ctrl+Alt+Shift (RemoteDesktopCanvas.tsx:395), which is documented only in a code comment and an internal concept doc, never in the UI or user docs. The canvas has no aria-label or role, and its CSS sets outline: none with no :focus-visible replacement, so neither sighted keyboard users nor screen-reader users can tell whether keystrokes are going to the remote machine.

## Why it matters

WCAG 2.1.2 No Keyboard Trap (A) requires that, if leaving needs more than standard keys, the user is told the method. 2.4.7 Focus Visible (AA) and 4.1.2 (A) apply as well. A keyboard-only user who tabs into a remote-desktop tab is effectively trapped, and not knowing the canvas holds focus means typing a password into the wrong target.

## Recommendation

Give the canvas role="application" and an aria-label naming the session and the escape chord, e.g. aria-label=`Remote desktop ${title}. Press Ctrl+Alt+Shift to return focus to termiHub`. Add a visible focus ring (.rd-canvas\_\_surface:focus-visible { box-shadow: var(--shadow-focus) }) and a brief on-focus hint in the toolbar or overlay that shows the release chord. Document the chord in the user guide and in the shortcuts overlay.

## Verification

Confirmed. handleKey calls preventDefault/stopPropagation on every key except the Ctrl+Alt+Shift chord. The canvas has no aria-label or role, and the CSS sets outline:none. The chord appears only in a code comment, a test and a concept doc, never in the UI or user docs.
