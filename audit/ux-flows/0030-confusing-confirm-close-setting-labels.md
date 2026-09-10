---
id: UX-030
title: Three similarly-named "confirm close…" settings with subtly different triggers are easy to confuse
angle: ux-flows
severity: low
category: ux
is_workaround: false
subsystem: src/components/Settings
evidence:
  - src/components/Settings/settingsRegistry.ts:404
  - src/components/Settings/settingsRegistry.ts:364
status: open
---

## What
Three toggles with near-identical names but different triggers sit adjacent under General:
`confirmCloseTabOnShortcut` (`:364-380`), `confirmCloseLiveSession` (`:381-403`), and
`confirmCloseAttachedTab` (`:404-424`). The last is labeled "Notify When Closing a Persistent-Session
Tab" but its keywords/description describe a *one-time notice*, not a per-close confirm — so its
label ("confirm close…"-family) implies behavior it doesn't have.

## Why it matters
A user trying to control close-confirmation behavior faces three similarly-worded switches whose
distinctions (on-shortcut vs live-session vs attached-tab, confirm vs one-time-notice) are not clear
from the labels. This invites toggling the wrong one and being surprised by the result.

## Evidence
- `settingsRegistry.ts:364-424` — the three confirm/notify toggles and their overlapping labels.

## Recommendation
Rename for precise, differentiated labels (e.g. "Confirm before closing a tab via keyboard shortcut",
"Confirm before closing a tab with a live session", "Show a one-time notice when closing a
persistent-session tab") and group them under a "Close confirmations" sub-header.
