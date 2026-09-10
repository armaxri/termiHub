---
id: AGT-012
title: Desktop RPC calls have no request timeout — a live-but-stuck agent hangs the caller forever; the "timed out" error is a misnomer
angle: agent-protocol
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri/src/terminal/agent_manager.rs
evidence:
  - src-tauri/src/terminal/agent_manager.rs:1184
  - src-tauri/src/terminal/agent_manager.rs:1172
status: open
---

## What
`AgentConnectionManager::send_request` correlates responses via a per-request
`oneshot::channel` and then calls `resp_rx.blocking_recv()` with **no timeout**
(`src-tauri/src/terminal/agent_manager.rs:1184`). The oneshot resolves only when the I/O
task sends the response or *drops* the sender. There is no per-request deadline: if the
agent is alive but a handler never responds (a wedged handler, a lost/dropped response
frame, a slow file/network op), the calling thread blocks indefinitely, occupying a
`spawn_blocking` worker thread. The mapped error message —
`"Agent request timed out"` (`:1186`) — is misleading: it fires on sender-*drop*
(I/O task gone / disconnect), never on an actual elapsed timeout.

## Why it matters
On a safety-critical app, an unbounded RPC wait is a latent hang and a resource leak: every
stuck request pins a blocking-pool thread, and enough of them starve the pool so unrelated
work also stalls. A dead connection does unblock (the I/O task drops the map), but a
live-but-stuck agent does not. There is no bound on request latency and no way for the UI
to recover a single hung call without tearing the whole connection down.

## Evidence
- `src-tauri/src/terminal/agent_manager.rs:1172` — `oneshot::channel()` per request.
- `src-tauri/src/terminal/agent_manager.rs:1184-1186` — `blocking_recv()` with the
  misleading "timed out" mapping and no `tokio::time::timeout` / `recv_timeout`.

## Recommendation
Add a real per-request timeout (e.g. `recv_timeout` on a sync channel, or run the await
under `tokio::time::timeout`), returning a genuine timeout error and freeing the thread.
Complement with an application-level keepalive (`health.check`) to detect a hung-but-alive
agent, and fix the error message to distinguish "connection lost" from "timed out".
