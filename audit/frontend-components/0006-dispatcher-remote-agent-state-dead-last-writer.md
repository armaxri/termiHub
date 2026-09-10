---
id: FEC-006
title: Dispatcher registers remote-state-change/agent-state-change listeners that nothing consumes; single-callback maps are last-writer-wins
angle: frontend-components
severity: low
category: bug
is_workaround: false
subsystem: src/services/events
evidence:
  - src/services/events.ts:272
  - src/services/events.ts:291
  - src/services/events.ts:384
  - src/services/events.ts:392
status: open
---

## What
`TerminalOutputDispatcher.doInit()` registers global Tauri listeners for
`remote-state-change` and `agent-state-change`, routing them through
`subscribeRemoteState(sessionId, cb)` / `subscribeAgentState(agentId, cb)`. A
repo-wide search shows **no caller** of either subscribe method — they are dead.
The events are therefore received on every session/agent state change and
dropped into empty callback maps.

Separately, unlike `outputCallbacks`/`exitCallbacks` (which use
`Map<string, Set<cb>>`), these two use `Map<string, single cb>`:
`this.remoteStateCallbacks.set(sessionId, callback)`. If they were ever used by
two subscribers for the same id, the second `set` would silently displace the
first, and the returned unsubscribe (`delete(sessionId)`) would remove whichever
callback currently owns the key regardless of which subscription is
unsubscribing — a latent last-writer-wins / wrong-handler-removal bug.

## Why it matters
Low today because the code is unused, but it is (a) dead surface that costs two
always-on global listeners doing per-event map lookups for nothing, and (b) a
trap: the next feature that wires session/agent state through this path inherits
the single-callback asymmetry and the unsubscribe-removes-wrong-handler bug.

## Evidence
`src/services/events.ts:272-308` (listeners registered),
`src/services/events.ts:384-397` (single-callback maps + unconditional delete),
no consumers found via grep for `subscribeRemoteState`/`subscribeAgentState`.

## Recommendation
Either delete the two listeners + subscribe methods until a consumer exists, or,
if they are about to be used, convert them to the `Map<string, Set<cb>>`
pattern used by output/exit and have the unsubscribe close over its own callback.
