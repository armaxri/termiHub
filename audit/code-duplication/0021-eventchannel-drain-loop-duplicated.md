---
id: DUP-021
title: The broadcast EventChannel drain loop (Lagged/Closed contract) is reimplemented four times
angle: code-duplication
severity: medium
category: reliability
is_workaround: false
subsystem: core/service + agent/service + src-tauri managers
evidence:
  - agent/src/service/mod.rs:89
  - src-tauri/src/embedded_servers/server_manager.rs:732
  - src-tauri/src/network/mod.rs:915
status: open
---

## What

The service `EventChannel` (a `tokio::broadcast`) is drained with the same
`Ok / Lagged(_) => continue / Closed => break` contract in at least four places: the agent registry
(`AgentServiceRegistry::start`, draining into an `Arc<Mutex<Option<Value>>>` slot) and the three
desktop `spawn_event_bridge` copies from DUP-020 (draining into Tauri emits). The sinks differ; the
broadcast lag/closed policy is identical and re-typed each time.

## Why it matters

Medium — the lag/closed policy is a correctness contract owned by the channel, not the sink. A
change to how lag is handled (e.g. emit a "gap" marker instead of silently continuing) has to be
made in four places.

## Evidence

- `agent/src/service/mod.rs:89-104` — drain into `latest: Arc<Mutex<Option<Value>>>`.
- `src-tauri/src/embedded_servers/server_manager.rs:732-747` and `src-tauri/src/network/mod.rs:915-930`
  — drain into Tauri emits.

## Recommendation

Add a small `core::service` helper on `EventChannel` — e.g. `spawn_drain(rx, f)` or
`subscribe_latest() -> Arc<Mutex<Option<Value>>>` — that owns the Lagged/Closed policy once and takes
a sink closure. Both the agent registry and the desktop bridges (DUP-020) use it.
