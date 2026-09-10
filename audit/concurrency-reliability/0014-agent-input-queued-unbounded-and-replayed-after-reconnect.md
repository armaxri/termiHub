---
id: CONC-014
title: Session input queues unbounded during a drop and is replayed after reconnect
angle: concurrency-reliability
severity: low
category: reliability
is_workaround: false
subsystem: src-tauri/terminal/agent_manager
evidence:
  - src-tauri/src/terminal/agent_manager.rs:216
  - src-tauri/src/terminal/agent_manager.rs:2052
  - src-tauri/src/terminal/agent_manager.rs:1487
  - src-tauri/src/terminal/agent_manager.rs:2250
status: open
---

## What

`command_tx` is an **unbounded** `mpsc::UnboundedSender<AgentIoCommand>` (`agent_manager.rs:216`).
While the `io_task` is inside `reconnect_agent` (`:2250`), it does not drain `command_rx`, so any
`SessionInput` / `SessionResize` / `Request` produced during the outage accumulates without bound.
On a successful reconnect the loop resumes draining `command_rx` and **sends the queued
`SessionInput` frames** to the recovered session (`:2052`).

## Why it matters

Two concerns, both on the reconnect hot path:

- **Unbounded growth:** input/resize/requests typed or issued during a long outage (up to the full
  reconnect window) pile up in memory with no cap or backpressure. This is an instance of the
  systemic unbounded-channel pattern the Rust audit flagged, on the agent transport specifically.
- **Stale input replay:** keystrokes the user typed *during* the outage (e.g. into a still-focused
  agent terminal) are delivered to the session **after** reconnect, once the connection is
  re-established — potentially injecting stale commands into a remote shell the user assumed was
  disconnected. On a ventilator-grade posture, replaying buffered input into a remote session after
  a gap is a correctness/safety smell worth an explicit decision rather than an accident of queue
  semantics.

## Evidence

```rust
command_tx: UnboundedSender<AgentIoCommand>,   // :216  unbounded — no backpressure

// during reconnect the recv arm is not polled; queued SessionInput is sent on resume:
AgentIoCommand::SessionInput { session_id, data } => {
    ... let _ = channel.data(line.as_bytes()).await;   // :2063  replayed post-reconnect
}
```

## Recommendation

Decide the intended semantics explicitly: either (a) **drop** input/resize commands enqueued while
the agent is in `reconnecting` (the tab already shows a reconnecting overlay; discarding stale
keystrokes is safer), or (b) keep them but bound the queue and surface the replay. Concretely, gate
`SessionInput`/`SessionResize` on a "connected" flag so they are discarded during the outage, and/or
switch to a bounded channel so a wedged transport applies backpressure. Add a test asserting input
typed during a simulated drop is not replayed into the session after reconnect.
</content>
