---
id: WA-RS-005
title: Network command handlers panic on missing agent client via .expect()
angle: workaround-rust
severity: low
category: reliability
is_workaround: true
subsystem: src-tauri/commands/network
evidence:
  - src-tauri/src/commands/network.rs:98
  - src-tauri/src/commands/network.rs:229
status: open
---

## What
Two network command handlers assert an invariant with a panic:

```rust
let client = agent_client.expect("agent client present for agent location");
```

## Why it matters
If the "agent location" branch is ever reached without a resolved agent client
(a routing/state bug), the Tauri command panics instead of returning an error to
the frontend. A panicking command handler is worse UX than a surfaced error and
can destabilize the backend.

## Recommendation
Return a proper `Err(...)` ("no agent client for agent-located request") so the
frontend shows a recoverable error. Reserve panics for truly-unreachable states,
and even then prefer `unreachable!` with a clear message over `.expect()` on an
`Option` carrying external state.
