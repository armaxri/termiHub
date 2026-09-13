---
id: UX-015
title: No explicit "disconnect" action — ending a session means closing (destroying) the tab
angle: ux-flows
severity: low
category: ux
is_workaround: false
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/TabBar.tsx:105
status: open
---

## What
There is no disconnect control in the terminal toolbar. Ending a live session intentionally means
closing the tab (`TabBar.tsx:105-120` `finishCloseTab`, which for live/persistent sessions routes
to the confirm dialogs), which destroys the tab and its scrollback. "Disconnect but keep the tab and
its scrollback" is not a first-class action — the user must either close the tab or wait for a drop.

## Why it matters
Reconnect after a drop is well-served (dedicated overlays, preserved scrollback), but the symmetric
intentional-disconnect is not. A user who wants to drop a connection but keep the pane's history for
reference has no way to do it. This is an asymmetry in the connect/disconnect/reconnect journey.

## Evidence
- `TabBar.tsx:105-120` — the close path is the only teardown; no disconnect-in-place control in the
  terminal toolbar (grep of `TerminalView.tsx` finds only drop/reconnect event handling).

## Recommendation
Add a "Disconnect" action (toolbar and/or tab context menu) that tears down the transport but keeps
the tab in a disconnected/scrollback-preserved state, from which the existing reconnect flow can
re-establish it.
