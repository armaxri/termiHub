---
id: SM-001
title: Reconnecting(phase=Idle) is a timer-less no-exit state when post-recovery connection.list fails
angle: state-machine-ux
severity: critical
category: bug
is_workaround: false
subsystem: src-tauri/src/session_projection + src-tauri/src/terminal/agent_manager.rs
evidence:
  - src-tauri/src/session_projection/store.rs:416
  - src-tauri/src/session_projection/timer.rs:198
  - src-tauri/src/terminal/agent_manager.rs:2285
  - src/store/sessionBridge.ts:815
  - src/components/Terminal/TerminalDisconnectOverlay.tsx:267
status: fixed
resolution: "#2739 — bounded-retry-then-settle to SessionLost; live-grade still owed"
---

## What
When an agent-hosted session drops, every hosted tab is folded to
`Reconnecting(phase=Idle)` (`store.rs:416` `agent_transport_reconnecting`), which
deliberately does **not** arm the backend reconnect timer — the backend timer arms only
on `phase=Waiting` (`timer.rs:198-212`). Resolution is owned entirely by the agent I/O
task's reconnect loop. But when the SSH transport reconnects, the hosted sessions are only
folded back if the follow-up `connection.list` round-trip succeeds:
`resolve_agent_hosted_sessions` runs `if let Some(live_ids) = list_recovered_session_ids(...)`
(`agent_manager.rs:2285-2300`). If that list call returns `None` (times out / errors), the
code emits `"connected"` and `continue 'outer` **without resolving the hosted sessions**.
The hosted tabs stay in `Reconnecting(Idle)` with no timer, no wall-clock timeout on the
frontend (`sessionBridge.ts:815-818,881`), and no server-side driver — a genuine no-exit
state.

## Why it matters
This is the classic "stuck Reconnecting forever" the release explicitly wants to eliminate,
on the safety-critical reconnect hot path. The user sees the terminal overlay
"Reconnecting… Connection lost. Attempting to reconnect automatically."
(`TerminalDisconnectOverlay.tsx:267-305`) indefinitely, even though the agent transport is
actually back up. The only escape is manually clicking Stop. Nothing — timer, timeout, or
backend fold — will ever move the entry on its own.

## Evidence
- `store.rs:416-431` — `agent_transport_reconnecting` sets `status=Reconnecting` with
  `reconnect=INITIAL_RECONNECT_STATE` (Idle) by design so the timer does not arm.
- `timer.rs:198-212` — the one-shot reconnect timer arms **only** for `phase=Waiting`.
- `agent_manager.rs:2285-2308` — after transport reconnect, `resolve_agent_hosted_sessions`
  short-circuits when `list_recovered_session_ids` returns `None`, emits `"connected"`, and
  `continue 'outer` without folding the hosted tabs.
- `sessionBridge.ts:815-818,881` — the frontend wait for a reconnect result has no timeout.

## Recommendation
On successful transport reconnect, guarantee every hosted tab is resolved to a terminal
outcome even when `connection.list` fails: treat a failed/`None` list as "sessions
unrecoverable" and fold each hosted tab to `SessionLost`/`Failed` (with a Retry), or retry
the list with a bounded deadline and then settle. Add a backstop wall-clock deadline on the
Idle-Reconnecting regime so no session can sit in `Reconnecting` without either a timer or
an owning task guaranteed to settle it.
