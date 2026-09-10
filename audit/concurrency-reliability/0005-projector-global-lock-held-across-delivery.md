---
id: CONC-005
title: Projector holds one global mutex over all regions across subscriber delivery
angle: concurrency-reliability
severity: medium
category: perf
is_workaround: false
subsystem: src-tauri/projection
evidence:
  - src-tauri/src/projection/mod.rs:164
  - src-tauri/src/projection/mod.rs:308
  - src-tauri/src/projection/mod.rs:312
  - src-tauri/src/commands/projection.rs:60
  - src-tauri/src/projection/mod.rs:347
status: open
---

## What

The `Projector` guards **all** regions with a single `std::sync::Mutex<HashMap<String,
RegionState>>` (`mod.rs:164`). `publish` holds that lock while calling `fan_out`, which invokes
`sub.sink.deliver(frame)` for **every** subscriber inline under the lock (`mod.rs:308-312`). On
desktop the sink is a `tauri::ipc::Channel::send` (`commands/projection.rs:60-66`); in
remote-client mode it is a WebSocket send half.

Separately, the intent `Dispatcher` serializes **every** intent across **all** domains behind one
`write_lock` mutex (`mod.rs:347`, `:361`).

## Why it matters

- **Delivery-under-lock:** any subscriber sink that is slow or momentarily blocked (a backed-up IPC
  channel, a stalled WebSocket send in remote-client mode) holds the global region lock for its
  full duration. While held, *every* `publish`, `subscribe`, `unsubscribe`, `resync`, and
  `snapshot` for *every* region blocks — unrelated domains (tunnels, monitoring, connections,
  transfers) stall on one slow consumer. As more domains migrate onto the substrate (Phase 2+),
  this becomes the single hottest lock in the app.
- **One lock over sharded state:** regions are logically independent but share one mutex, so there
  is no per-region concurrency even absent a slow sink.
- Combined with the global `Dispatcher.write_lock`, the substrate has two process-wide
  serialization points on the state hot path. This matches the "global dispatcher lock" flagged by
  the Rust audit and extends it to the fan-out path.

The reap-on-deliver design (`retain(|sub| sub.sink.deliver(..).is_ok())`) means a *dead* sink is
cheap, but a *slow-but-open* sink is the hazard.

## Evidence

```rust
pub struct Projector { regions: Mutex<HashMap<String, RegionState>> }   // :164  one lock, all regions

fn fan_out(state: &mut RegionState, frame: &ProjectionFrame) {
    state.subscribers.retain(|sub| sub.sink.deliver(frame).is_ok());    // :312  deliver() called under the region lock
}
```

The doc comment at `mod.rs:315` asserts "only ever locked for the short body of a projector call" —
but `deliver()` is arbitrary I/O and is inside that body.

## Recommendation

Do not deliver under the lock: under the lock, bump the version, compute the diff, and **snapshot
the subscriber sink Arcs**; release the lock; then deliver outside it (reaping dead sinks on a
follow-up short lock). Shard the region map (per-region lock, or `dashmap`) so independent domains
don't contend. For remote-client WebSocket sinks, deliver through a bounded per-subscriber queue so
a slow socket applies backpressure to itself, not to the projector.
</content>
