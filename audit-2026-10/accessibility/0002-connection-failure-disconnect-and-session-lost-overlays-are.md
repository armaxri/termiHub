---
id: A11Y2-002
title: "Connection failure, disconnect and session-lost overlays are not announced to assistive tech"
angle: accessibility
severity: medium
category: screen-reader
is_workaround: false
subsystem: "src/components/Terminal, src/components/ui/ContentOverlay"
evidence:
  - src/components/ui/ContentOverlay.tsx:66-72
  - src/components/Terminal/TerminalConnectionOverlay.tsx:368-396
  - src/components/Terminal/TerminalDisconnectOverlay.tsx:98-102
  - src/components/Terminal/TerminalDisconnectOverlay.tsx:225-233
  - src/components/Terminal/TerminalDisconnectOverlay.tsx:345-352
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

ContentOverlay adds role="status"/aria-live only when busy is set. The terminal error states pass no busy and add no role="alert": 'Connection failed' (TerminalConnectionOverlay:371), 'Reconnect failed' / 'Authentication failed' (TerminalDisconnectOverlay:352) and 'Session lost' (:233). The auto-reconnect countdown overlay is not busy either (:98). No toast accompanies these states, and focus is not moved to the Retry or Start New Shell actions. Separately, even in the busy case the live region mounts together with its text, which many screen readers do not announce, because a live region must exist before its content changes.

## Why it matters

WCAG 4.1.3 Status Messages (AA) and 3.3.1 Error Identification (A). A screen-reader user typing in the terminal (now possible via the A11Y-006 toggle) is never told that the connection failed, authentication was rejected, or the remote session was lost. They keep typing into a dead tab with no feedback, on the app's core flow.

## Recommendation

Add an `announce?: 'polite' | 'assertive'` prop to ContentOverlay, or have error variants render the heading and error text in role="alert". Better still, keep a persistent visually-hidden live region per terminal tab (or app-wide) that is always mounted, and write the heading and error text into it on state change. Optionally move focus to the primary action (Retry or Start New Shell) when the overlay appears for the active tab. Add tests asserting that the failure heading lands in an alert or status node.

## Verification

Confirmed. ContentOverlay sets role=status/aria-live only when busy. The busy prop appears only on the connecting/reconnecting variants (ConnectionOverlay 193/211/266/326, DisconnectOverlay 298). The failure, session-lost and countdown variants have no alert role or live region, and the overlays raise no toast.
