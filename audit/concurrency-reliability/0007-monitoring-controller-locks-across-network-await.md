---
id: CONC-007
title: MonitoringController holds sessions/overrides mutexes across provider network awaits
angle: concurrency-reliability
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri/session/monitoring_controller
evidence:
  - src-tauri/src/session/monitoring_controller.rs:258
  - src-tauri/src/session/monitoring_controller.rs:259
  - src-tauri/src/session/monitoring_controller.rs:265
  - src-tauri/src/session/monitoring_controller.rs:289
  - src-tauri/src/session/monitoring_controller.rs:313
  - src-tauri/src/session/monitoring_controller.rs:338
status: open
---

## What

Several `MonitoringController` methods hold a `tokio::sync::Mutex` guard across an agent/provider
network round-trip:

- `stop_session_monitoring` line **258**: `if let Some(proxy) =
  self.monitoring_overrides.lock().await.remove(...)` — the scrutinee guard temporary stays alive
  for the whole `if let` block, so `monitoring_overrides` is **held across
  `proxy.unsubscribe().await`** (`:259`, an agent RPC).
- Line **265→268**: `sessions` guard held across `provider.unsubscribe().await`.
- Line **289→297**: `sessions` held across `provider.set_paused(..).await`.
- Line **313→323**: `sessions` held across `provider.set_interval(..).await`.
- Line **338→341**: `sessions` held across `provider.cancel_connect().await`.

## Why it matters

These are `tokio::sync::Mutex`es, so the task only parks (no runtime freeze), but for the full
duration of each provider network call **no other operation can touch that map**. On the agent-
routed path (`RemoteMonitoringProxy`) `unsubscribe`/`set_paused`/`cancel_connect` are RPCs to the
agent — which, per CONC-003, can themselves stall for the whole reconnect window. So a
`stop_session_monitoring` during an agent drop can pin the `sessions`/`overrides` map for minutes,
blocking every other session's monitoring control and any code path that locks `sessions`.

There is also a latent reentrancy-deadlock: if any awaited provider callback re-enters the same map
lock, the task self-deadlocks. Contrast the well-written `override_provider` helper (`:88-97`) and
the `start` path (`:126-147`) which deliberately clone the Arc / scope the guard *before* awaiting —
the methods above don't.

## Evidence

```rust
// scrutinee guard lives across the whole block:
if let Some(proxy) = self.monitoring_overrides.lock().await.remove(session_id) {  // :258 lock held...
    if let Err(e) = proxy.unsubscribe().await { ... }                             // :259 ...across the RPC
    return Ok(());
}
let sessions = self.sessions.lock().await;                                        // :265
if let Some(entry) = sessions.get(session_id) {
    if let Some(provider) = entry.connection.monitoring() {
        if let Err(e) = provider.unsubscribe().await { ... }                      // :268 held across RPC
```

## Recommendation

Clone the needed Arc (proxy / provider) under the lock, drop the guard, then await — the same
pattern `override_provider` and the local-start branch already use. For the `if let` at `:258`,
bind `let proxy = { let mut g = ...lock().await; g.remove(..) };` on its own line so the guard is
released before `unsubscribe().await`.
</content>
