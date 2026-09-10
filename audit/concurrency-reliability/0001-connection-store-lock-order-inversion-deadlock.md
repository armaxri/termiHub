---
id: CONC-001
title: Agent ConnectionStore has an AB-BA lock-order inversion (deadlock)
angle: concurrency-reliability
severity: high
category: bug
is_workaround: false
subsystem: agent/session/definitions
evidence:
  - agent/src/session/definitions.rs:170
  - agent/src/session/definitions.rs:210
  - agent/src/session/definitions.rs:211
  - agent/src/session/definitions.rs:323
  - agent/src/session/definitions.rs:324
  - agent/src/session/definitions.rs:256
  - agent/src/session/definitions.rs:352
status: open
---

## What

`ConnectionStore` holds two independent `tokio::sync::Mutex`es — `connections` and `folders`
(`definitions.rs:170-171`) — and different async methods lock them in **opposite orders** while
holding the first guard across the second `.lock().await`:

- **`connections` → `folders`:** `create` (210→211), `update` (230→256), `list` (263→264),
  `delete` (311→314).
- **`folders` → `connections`:** `create_folder` (323→324), `update_folder` (338→352),
  `delete_folder` (359→…).

If `create` (holds `connections`, awaits `folders`) runs concurrently with `create_folder` (holds
`folders`, awaits `connections`), each task parks waiting for the lock the other holds — a classic
AB-BA deadlock that never resolves.

## Why it matters

A permanent deadlock of the agent's connection-definitions subsystem. Once hit, every
`connections.*` and `connections.folders.*` RPC that needs either lock hangs forever; the two
parked tasks also never release, so the transport loops that dispatched them stall. On a
ventilator-grade release this is a hard, unrecoverable hang of a core subsystem.

**Reachability:** a single client connection dispatches requests sequentially
(`io/transport.rs:71`, `call_raw().await` before the next read), so one client cannot self-deadlock.
But the `ConnectionStore` is a shared instance reachable from **multiple concurrent client
connections** (ADR-11 multi-client; daemon + desktop client; `--listen` TCP mode), each on its own
spawned transport task on the multi-thread runtime. Two clients issuing `connections.create` and
`connections.folders.create` at the same moment is enough. It is latent precisely because it needs
concurrency to trigger — it will not show in single-client testing.

## Evidence

```rust
// create: connections then folders
let mut conns = self.connections.lock().await;   // :210
let folders = self.folders.lock().await;          // :211  (held across)

// create_folder: folders then connections  ← opposite order
let mut folders = self.folders.lock().await;      // :323
let conns = self.connections.lock().await;        // :324  (held across)
```

The second lock in each pair is acquired only to pass both maps to `save_to_disk`.

## Recommendation

Enforce a single global lock order (always `connections` before `folders`) in every method — swap
the two acquisitions in `create_folder`/`update_folder`/`delete_folder`. Better: since the two are
almost always taken together for `save_to_disk`, fold both maps under **one** mutex
(`Mutex<StorageFormat>` or `Mutex<(HashMap, HashMap)>`), which removes the ordering hazard entirely
and matches the disk format that already pairs them. Add a concurrency test that spawns
`create` and `create_folder` against one shared store on a multi-thread runtime.
</content>
