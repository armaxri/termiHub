---
id: CONC-009
title: Per-agent io_task is detached with cooperative-only shutdown (no abort handle)
angle: concurrency-reliability
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri/terminal/agent_manager
evidence:
  - src-tauri/src/terminal/agent_manager.rs:861
  - src-tauri/src/terminal/agent_manager.rs:860
  - src-tauri/src/terminal/agent_manager.rs:944
  - src-tauri/src/terminal/agent_manager.rs:2029
status: fixed
resolution: "#2809 — io_task AbortHandle retained in AgentConnection, fired on teardown/evict/prune (forced stop of wedged task)"
---

## What

The per-agent `agent_io_task` is spawned fire-and-forget (`agent_manager.rs:861`); its `JoinHandle`
is dropped and only `command_tx` is retained in the agent map. The task **also holds a clone of its
own `command_tx`** (`command_tx_task`, `:860`) for the agent-forward relay. Shutdown is therefore
**cooperative-only**:

- `command_rx.recv()` yields `None` (clean shutdown) only when **all** `command_tx` clones drop
  (`:2029`) — but the task holds one itself, so external droppers can never close it that way.
- The only real stop is delivering `AgentIoCommand::Disconnect` (`:944`, `:2116`).

There is no `AbortHandle`, so nothing can force-stop the task.

## Why it matters

The task owns the entire agent transport — the russh `session` + `channel`. If `Disconnect` is
never delivered (or cannot be, per CONC-002 while the task is parked in a blocking reconnect
connect), the task and its SSH session leak with no fallback. The reconnect-exhaustion path does
`return` and self-reaps the map entry (`:2325`), and `Disconnect` returns cleanly, so the common
paths are covered — but the combination "task holds its own `command_tx` clone" + "no abort handle"
+ "Disconnect can't be processed during a blocking reconnect connect" means the intended shutdown
signal has a real window where it does nothing, and there is no escape hatch.

## Evidence

```rust
let command_tx_task = command_tx.clone();   // :860  task holds its own sender clone
tokio::spawn(async move { agent_io_task(..., command_tx_task, ...).await });  // :861  JoinHandle dropped
```

Clean-shutdown-on-sender-drop can thus never fire from outside:

```rust
cmd = command_rx.recv() => { let cmd = match cmd { Some(c) => c, None => { alive.store(false); return; } } }  // :2026-2033
```

## Recommendation

Store the `JoinHandle`/`AbortHandle` in the `AgentConnection` so `disconnect_agent` and app shutdown
can `.abort()` as a guaranteed fallback after signalling `Disconnect`. Reconsider having the task
hold its own `command_tx` clone (or hold a `WeakSender`) so an all-external-senders-dropped
condition can actually close the loop. Pairs with CONC-002 (make the reconnect connect cancellable
so `Disconnect` is honored promptly).
</content>
