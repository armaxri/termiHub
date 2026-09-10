---
id: CONC-002
title: Agent reconnect uses the non-cancellable blocking SSH connect; Disconnect cannot interrupt a hung reconnect
angle: concurrency-reliability
severity: high
category: reliability
is_workaround: false
subsystem: src-tauri/terminal/agent_manager
evidence:
  - src-tauri/src/terminal/agent_manager.rs:2650
  - src-tauri/src/terminal/agent_manager.rs:2625
  - src-tauri/src/terminal/agent_manager.rs:2631
  - src-tauri/src/utils/ssh_auth.rs:26
  - src-tauri/src/utils/ssh_auth.rs:62
  - src-tauri/src/terminal/agent_manager.rs:944
status: open
---

## What

The desktop→agent in-task reconnect loop (`reconnect_agent`, `agent_manager.rs:2609`) establishes
each attempt with the **non-cancellable** blocking helper `connect_and_authenticate(&ssh_config)`
(`:2650`), which internally does `block_in_place` + `Handle::block_on(core_connect(..))`
(`ssh_auth.rs:26`). The `alive` flag is checked only in the backoff sleep *between* attempts
(`:2631`, `:2643`) and never during the SSH TCP-connect/auth itself. A cancellable twin —
`connect_and_authenticate_cancellable` (`ssh_auth.rs:62`) — exists and is used by the **initial**
agent connect (G1/#1235) and by the tunnel module, but the reconnect path does not take it.

## Why it matters

When an agent drops and the host becomes unreachable/black-holed, each reconnect attempt blocks in
`core_connect` for the full OS/TCP connect timeout (tens of seconds). During that window:

- A user **Disconnect** sets `alive=false` and sends `AgentIoCommand::Disconnect`
  (`agent_manager.rs:944-945`), but the `agent_io_task` is parked inside
  `block_on(core_connect(..))` and cannot process `command_rx`. The disconnect is not honored until
  the connect times out — the "Cancel/Kill reconnect" intent the lifecycle work added is defeated
  for the duration of each attempt.
- `shutdown_agent` and app shutdown are similarly delayed.

This is exactly the sibling of the already-fixed initial-connect hang (G1) and the earlier
stuck-reconnect dead-socket bug, still present on the reconnect leg — the one leg where reconnect
correctness matters most.

## Evidence

```rust
// reconnect_agent, per attempt:
let session = match connect_and_authenticate(&ssh_config) {  // :2650  NON-cancellable, blocks
    Ok(s) => s,
    Err(e) => { warn!(...); continue; }
};
```

`alive` is honored only here, before the connect:

```rust
loop { if !alive.load(SeqCst) { return Err("Reconnect stopped by user"); } ... sleep(100ms) } // :2630
if !alive.load(SeqCst) { return Err(...); }  // :2643  — last check BEFORE the blocking connect
```

## Recommendation

Thread a `CancellationToken` into `reconnect_agent` (fired when `alive` flips / on
`AgentIoCommand::Disconnect`) and switch `:2650` to
`connect_and_authenticate_cancellable(&ssh_config, token)`, mirroring the initial connect path.
Also apply a connect wall-clock timeout per attempt so a silently-dropping host fails fast rather
than waiting out the OS timeout. Regression test: fire the token mid-connect and assert the loop
returns promptly.
</content>
