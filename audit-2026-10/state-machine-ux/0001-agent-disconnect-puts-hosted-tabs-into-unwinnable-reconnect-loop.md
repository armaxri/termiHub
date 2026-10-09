---
id: SM2-001
title: "Disconnecting or shutting down an agent puts every hosted tab into a reconnect loop that cannot succeed (minutes of 'Reconnecting…', then a confusing failure)"
angle: state-machine-ux
severity: medium
category: bug
is_workaround: false
subsystem: src/components/Terminal/TerminalView.tsx agent-state handler + src/store/slices/terminalSessionStateSlice.ts + src-tauri/src/session_projection/redrive.rs
evidence:
  - src-tauri/src/terminal/agent_manager.rs:1396
  - src-tauri/src/terminal/agent_manager.rs:1410
  - src-tauri/src/terminal/agent_manager.rs:1605
  - src/components/Terminal/TerminalView.tsx:234
  - src/components/Terminal/TerminalView.tsx:256
  - src/store/slices/terminalSessionStateSlice.ts:392
  - src/store/reconnectHelpers.ts:52
  - src/store/reconnectHelpers.ts:55
  - src-tauri/src/session_projection/redrive.rs:134
  - src-tauri/src/session_projection/redrive.rs:147
  - src-tauri/src/terminal/agent_manager.rs:1558
  - src-tauri/src/session_projection/store.rs:521
  - src/store/slices/agentsSlice.ts:347
status: fixed
resolution: "#4309 — a user agent Disconnect/Shutdown ends hosted tabs with a manual Reconnect instead of an unwinnable reconnect loop; unexpected loss still reconnects, user-stopped tabs are left alone"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Disconnect (detach) and Shutdown both go through `disconnect_agent`. It deletes the agent's
retained transport config (`self.agent_configs.clear(agent_id)`, agent_manager.rs:1396;
shutdown also clears it at :1605) and then emits `agent-state-change` = "disconnected" with
no error (:1410). In the frontend, the no-error "disconnected" branch
(TerminalView.tsx:234-256) calls `setTerminalExited(tab.id, {reason: "dropped"})` for every
agent terminal tab that has a sessionId. The comment there even names 'a user-initiated
agent disconnect' as the case. `setTerminalExited` classifies the drop: agent-hosted tabs
always count as resilient (reconnectHelpers.ts:52-55), so it dispatches `session.reconnect`
(terminalSessionStateSlice.ts:392-393). The store folds `Reconnecting` with an armed
`Waiting` loop (store.rs:521, whose only guard is Evicted). The backend timer then starts
the redrive. Each attempt calls `reconnect_retained_agent` (redrive.rs:134), which returns
`NoRetainedConfig` because the disconnect just deleted the config (agent_manager.rs:1558),
and folds `reconnect_failed` (redrive.rs:147). The loop runs the shared 10-attempt backoff
(1s doubling to a 30s cap) before giving up. The handler also ignores each tab's current
region status, so tabs that had already ended (Disconnected(User) or SessionLost with a
sessionId still set) are put back into the loop too.

## Why it matters

The user explicitly asked to detach or stop the agent. Every terminal on it then shows the
'Reconnecting… attempt n' overlay for several minutes, in every window because the region
is shared. It ends on 'Reconnect failed: No retained config to re-establish agent …', which
says nothing about the user's own action. This is the kind of status that contradicts the
user's intent and only resolves on a timer that this angle is meant to catch. It also arms
backend timers and redrive work for sessions the user deliberately ended. If the user
reconnects the agent inside the window, the tabs silently re-attach, which makes the
outcome depend on timing.

## Evidence

- `agent_manager.rs:1396,1410,1605` — config cleared, plain "disconnected" emitted.
- `TerminalView.tsx:234-256` — no-error branch maps to `reason: "dropped"`.
- `reconnectHelpers.ts:52-55`, `terminalSessionStateSlice.ts:392` — agent tabs resilient → `session.reconnect`.
- `store.rs:521` — `reconnect()` guards only Evicted.
- `redrive.rs:134,147`, `agent_manager.rs:1558` — each attempt fails with `NoRetainedConfig`.
- `agentsSlice.ts:347` — disconnect/shutdown never fold hosted tabs.

## Recommendation

Give the user-initiated end its own reason. Either emit `agent-state-change` with a reason
(e.g. `reason: "user"`) from `disconnect_agent` / `shutdown_agent`, or fold at the backend
source: in `disconnect_agent`, before emitting, fold each `agent_hosted_sessions(agent_id)`
tab to `Disconnected(User)` (store.disconnect) and call
`clear_retained_request_with_agent_scrub` so the redrive gate
(`retained_request(..).resilient`) can never fire. In TerminalView, do not map a
user-initiated agent disconnect to `reason: "dropped"`. Use `killed`/`session.disconnect`
instead, and gate the loop on the tab's current region status (only live or connecting
tabs). Optionally make `SessionLifecycleStore::reconnect` a no-op from terminal statuses
(Disconnected(User), AuthFailed, SessionLost). Keep the explicit Force-reconnect re-attach
as its own path that does a manual reconnect. Add a test: disconnectRemoteAgent → hosted tab
region == disconnected/user, no reconnect timer armed.

## Verification

Traced the whole chain; real, no guard, no ADR/FINAL-SUMMARY decision covering it.
`shutdown_agent` reaches the same code via `disconnect_agent` (:1615); the command wrapper
(`commands/agent.rs:182`) does no folding. The per-tab retained request is never scrubbed by
the disconnect (only `session.disconnect`, `dropped`, `cancelReconnect`, give-up and
`remove` do), so the redrive gate (`redrive.rs:77`) passes. `NoRetainedConfig` folds an
ordinary `reconnect_failed`, so it backs off for `max_attempts` 10
(`core/src/reconnect_backoff.rs:84`) — roughly 3 minutes. Medium rather than high: no data or
session loss (detach leaves remote processes running), reconnecting the agent re-attaches,
the loop is cancellable; impact is misleading UX plus wasted timers/redrive work. Cleanest
fix point is the backend `disconnect_agent`, plus a user-initiated reason in the frontend.
