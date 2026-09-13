---
id: SM-020
title: Reconnect is modeled at least three inconsistent ways across subsystems (vocabulary + retry-cap drift)
angle: state-machine-ux
severity: high
category: arch
is_workaround: false
subsystem: cross-cutting — session/agent/tunnel/monitoring/remote-desktop
evidence:
  - src-tauri/src/agents_projection/store.rs:43
  - src-tauri/src/session_projection/store.rs:49
  - src/store/appStore.ts:1218
  - src/types/tunnel.ts:76
  - src/types/monitoring.ts:9
  - src/types/remoteDesktop.ts:11
status: open
---

## What
The same underlying event — a transport drop and its recovery — is modeled with at least
three materially different state vocabularies, plus two adjacent parallel machines, authored
by different migration phases and stitched together only informally:

1. **Agent transport** — `AgentConnectionState { Disconnected, Connecting, Connected, Reconnecting }`
   (4 values, region-authoritative, `agents_projection/store.rs:43-53`).
2. **Session lifecycle** — `SessionStatus { Connecting, Connected, Disconnected, Reconnecting, Failed, SessionLost }`
   (6 values, its own ported `reconnect_backoff` engine, `session_projection/store.rs:49-73`);
   adds `SessionLost`/`Failed` that #1 cannot express.
3. **`remoteStates` / `setRemoteState` / `remote-state-change`** — an **untyped
   `Record<string,string>`** (`appStore.ts:1218`, reducer `:6042`), never migrated to a
   region, and the map the **tab-strip dot actually renders from** — blind to #2's
   `sessionLost`/`failed` (see SM-011).

Adjacent parallel machines: tunnels `TunnelStatus{…,error}` (`tunnel.ts:76`), monitoring
`MonitorStatus{connecting,live,stale,reconnecting,offline,paused}` (`monitoring.ts:9`, uses
`live`/`offline` instead of `connected`/`disconnected`), remote-desktop caps retries at 3
(`remoteDesktop.ts:11`) vs the agent path's 10, and a separate agentless
`TerminalAutoReconnectState` loop (`src/types/terminal.ts:215`).

## Why it matters
- **Correctness:** #3 cannot represent `SessionLost`, so the primary compact status indicator
  lies about lost sessions (SM-011). No single source stitches #2 (the richest) into #3 (what
  the UI reads).
- **Inconsistent recovery semantics:** different retry caps (10 vs 3), different backoff
  policies, and different "terminal" vocabularies (`error` present in tunnel/monitoring, absent
  in agent/session enums) mean "reconnecting" and "gave up" mean different things per
  subsystem — the user cannot build one mental model of what a spinner means or when it stops.
- **Maintenance:** every new reconnect fix must be applied N times in N vocabularies; the
  Open Connections badge set already mixes `up`/`down`/`connected`/`reconnecting`/`stale` for
  what is conceptually one "last-poll-succeeded" signal (`OpenConnectionsModal.tsx:1164-1177`).

## Evidence
See the six evidence pointers above; grep confirms `remoteStates` is never a region and no
`setRemoteState` call exists on the `SessionLost`/`Failed` paths.

## Recommendation
Converge on one canonical connection-lifecycle vocabulary and one backoff/retry policy shared
by session, agent, tunnel, monitoring, and remote-desktop (a single enum + one
`reconnect_backoff` engine, region-authoritative). As the concrete first step, render every
per-session/per-tab status from the `session-lifecycle` region and retire the untyped
`remoteStates` map (SM-011). This is the structural fix behind SM-011/SM-014 and the badge
drift.
