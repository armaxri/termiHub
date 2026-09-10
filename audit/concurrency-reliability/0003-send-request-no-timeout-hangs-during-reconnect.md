---
id: CONC-003
title: send_request blocks with no timeout; agent RPCs hang for the full reconnect window
angle: concurrency-reliability
severity: high
category: reliability
is_workaround: false
subsystem: src-tauri/terminal/agent_manager
evidence:
  - src-tauri/src/terminal/agent_manager.rs:1184
  - src-tauri/src/terminal/agent_manager.rs:1186
  - src-tauri/src/terminal/agent_manager.rs:2305
  - src-tauri/src/terminal/agent_manager.rs:2044
  - src-tauri/src/commands/agent.rs:283
status: open
---

## What

`AgentConnectionManager::send_request` sends an `AgentIoCommand::Request` and then blocks on the
response oneshot with **`resp_rx.blocking_recv()`** and no timeout (`agent_manager.rs:1184-1186`).
A pending request is resolved only when (a) the agent's reply arrives and the `io_task` matches it
in `pending_responses` (`:2156`), or (b) the `io_task` drains `pending_responses` after a reconnect
**succeeds** (`:2305`) or **fails** (`:2327`).

While the `io_task` is inside `reconnect_agent` (up to 10 attempts, backoff capped at 30s each →
potentially minutes), it does not touch `command_rx` or `pending_responses` at all. So a
`send_request` that was in flight when the link dropped — and any new one issued during the outage —
blocks for the **entire reconnect duration**.

The error returned on the failure path is `TerminalError::RemoteError("Agent request timed out")`
(`:1186`) — but that string fires only when the *sender is dropped* (channel closed). There is no
actual timeout; the message is misleading.

## Why it matters

- Every agent RPC (`connection.create`, `connections.list`, monitoring, file ops, etc.) is driven
  from a Tauri command via `spawn_blocking` (`commands/agent.rs:283`, and ~25 more sites). Each
  blocked `send_request` pins one `spawn_blocking` pool thread for the whole reconnect window. A
  burst of agent operations during a drop can pile up dozens of parked blocking threads.
- The user-facing effect is a multi-minute, silent hang of agent-backed actions on every drop,
  with a final error that claims a timeout that never happened. On a ventilator-grade release this
  is an un-bounded stall on the reconnect hot path.

## Evidence

```rust
conn.command_tx.send(AgentIoCommand::Request { method, params, response_tx: resp_tx })...;
drop(agents);
resp_rx
    .blocking_recv()                                        // :1184  no timeout
    .map_err(|_| TerminalError::RemoteError("Agent request timed out".to_string()))?  // :1186 misleading
```

Pending requests are only drained *after* reconnect resolves:

```rust
// reconnect success: for (_, tx) in pending_responses.drain() { tx.send(Err("Connection lost during request")) }  // :2305
// reconnect exhausted: for (_, tx) in pending_responses.drain() { tx.send(Err("Agent disconnected")) }           // :2327
```

## Recommendation

Bound the wait: use `resp_rx.recv_timeout(..)`-equivalent via `tokio::time::timeout` in a
`spawn_blocking`, or a real per-request deadline, so a caller fails in seconds rather than minutes.
Independently, on entering the reconnect path the `io_task` should **immediately drain
`pending_responses` with a "connection lost" error** (before the backoff loop), instead of holding
them until reconnect resolves — so in-flight callers unblock at the moment of the drop. Fix the
error string to reflect the real cause ("agent connection lost" vs an actual timeout).
</content>
