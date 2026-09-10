---
id: CONC-006
title: Monitoring push-task abort handle registered after spawn — leak / missed-stop window
angle: concurrency-reliability
severity: medium
category: bug
is_workaround: false
subsystem: src-tauri/session/monitoring_controller
evidence:
  - src-tauri/src/session/monitoring_controller.rs:178
  - src-tauri/src/session/monitoring_controller.rs:239
  - src-tauri/src/session/monitoring_controller.rs:243
  - src-tauri/src/session/monitoring_controller.rs:252
status: open
---

## What

`start_session_monitoring` spawns the push task (`monitoring_controller.rs:178`) and only
*afterwards* registers its `AbortHandle` into `monitoring_tasks` via `.insert` (`:239-243`). Two
problems:

1. **Overwrite-without-abort on double start.** If a session already has a running monitor and
   `start_session_monitoring` is called again for it (re-subscribe, run-location change), `.insert`
   overwrites the existing abort handle **without aborting the old task**. The prior push task
   leaks — it keeps reading its subscription and emitting `session-monitoring-stats` /
   `-status` events and folding into the store, so the session now has two collectors racing on the
   same region.
2. **Missed-stop window.** The task is spawned and already emitting *before* its handle is
   registered. A `stop_session_monitoring` (`:252`) that runs in the spawn→insert gap finds no
   handle and returns without aborting; the task keeps running. No lock spans the spawn+insert, so
   a concurrent stop can interleave.

## Why it matters

Leaked monitor tasks hold a live subscription (and, on the agent-routed path, an override proxy)
and emit duplicate/stale stats into the projection store — visible as flickering or doubled
monitoring data, plus a resource the Open Connections panel cannot see. On a drop/reconnect where
monitors are torn down and re-established, the double-start overwrite is the likely trigger.

## Evidence

```rust
let join_handle = tokio::spawn(async move { /* select loop emitting events */ });  // :178
let abort_handle = join_handle.abort_handle();
self.monitoring_tasks.lock().await.insert(session_id.to_string(), abort_handle);   // :243  overwrites silently
```

`stop` only aborts what is present at call time:

```rust
if let Some(handle) = self.monitoring_tasks.lock().await.remove(session_id) { handle.abort(); }  // :252
```

## Recommendation

Under the `monitoring_tasks` lock, `insert` and if a previous handle was returned, `.abort()` it —
make start idempotent (abort-then-replace). Ideally hold the map lock across the swap so a
concurrent stop cannot slip between spawn and register, or spawn in a paused state and register
before the first emit. Add a test: start twice for one session, assert only one task survives and
the first was aborted; stop immediately after start, assert the task is aborted.
</content>
