---
id: SM-002
title: Agent-task recover fold has no cancel guard — a user-stopped tab silently resurrects
angle: state-machine-ux
severity: high
category: bug
is_workaround: false
subsystem: src-tauri/src/terminal/agent_manager.rs + src-tauri/src/session_projection
evidence:
  - src-tauri/src/session_projection/store.rs:471
  - src-tauri/src/terminal/agent_manager.rs:2421
  - src-tauri/src/session_projection/projection.rs:160
  - src-tauri/src/session_projection/redrive.rs:181
  - src/store/appStore.ts:6021
status: fixed
resolution: "#2789 — agent recover fold guarded on status==Reconnecting; tears down recovered session if user cancelled"
---

## What
For an agent-hosted tab in `Reconnecting(phase=Idle)`, the user's Stop button
(`cancelAutoReconnect`, `appStore.ts:6021-6028`) dispatches `session.cancelReconnect`, which
unconditionally forces `Disconnected(User)` (`store.rs:471`). But the agent I/O task is
still re-establishing the transport in place; on success it calls
`fold_agent_session_recovered → store.connected(tab)` (`agent_manager.rs:2421`,
`projection.rs:160-163`) with **no check** that the user cancelled. The redrive path guards
exactly this race with a `still_connecting` re-check before settling
(`redrive.rs:181-190,269-272`); the agent-task recover fold has no equivalent guard.

## Why it matters
A tab the user explicitly Stopped can silently flip back to `Connected` (or oscillate,
depending on ordering). The user's "stop trying" intent is lost, and the status is
ambiguous/self-reverting — the opposite of the deterministic cancel the reconnect UX
promises. It also re-establishes a transport/session the user asked to abandon.

## Evidence
- `store.rs:471` — `cancel_reconnect` forces `Disconnected` regardless of phase.
- `agent_manager.rs:2421` + `projection.rs:160-163` — `fold_agent_session_recovered` folds
  `Connected` with no cancel/`still_connecting` check.
- `redrive.rs:181-190,269-272` — the analogous redrive path DOES re-check and tears down the
  orphaned session, proving the guard is known but not applied on the agent path.

## Recommendation
Apply the redrive's `still_connecting` guard to the agent-task recover fold: before folding
`Connected`, verify the tab is still in a `Reconnecting` phase (not cancelled/removed); if
the user cancelled, tear down the freshly recovered session instead of adopting it.
