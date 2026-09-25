---
id: WA-RS-002
title: Agent network diagnostics panic via Arc::try_unwrap().unwrap().into_inner().unwrap()
angle: workaround-rust
severity: medium
category: reliability
is_workaround: true
subsystem: agent/network
evidence:
  - agent/src/network/mod.rs:50
  - agent/src/network/mod.rs:71
  - agent/src/network/mod.rs:107
status: fixed
resolution: "#2750 — poison-tolerant drain"
---

## What
Three network-diagnostic handlers (ping sweep, port scan, traceroute — the
`results`/`hops` accumulators) unwrap an `Arc` and its inner lock twice in a row:

```rust
let results = Arc::try_unwrap(results).unwrap().into_inner().unwrap();
```

`Arc::try_unwrap` returns `Err` (and thus `.unwrap()` panics) if **any** other
clone of the `Arc` is still alive. These handlers spawn concurrent tasks that
each hold a clone; the code assumes every task has fully completed and dropped
its clone by this point. Correctness hinges entirely on `scan_ports` /
`ping_stream` / the traceroute call dropping the `on_result` callback (which owns
one clone) **before** the `.await` returns. It currently holds, so this is a
**latent** panic, not one that fires today — but it is a fragile invariant that
a future refactor of the scan/ping internals (e.g. spawning a lingering
result-drain task) would silently turn into a crash.

## Why it matters
If a single spawned diagnostic task is still running (slow host, task not yet
joined, cancellation race) the agent process **panics** instead of returning a
result or error. On the remote agent a panic tears down the worker and can drop
other multiplexed sessions on that agent. This violates the repo rule "No
`.unwrap()` in production code" on a genuinely fallible path.

## Evidence
`agent/src/network/mod.rs:50,71,107` — all three follow the identical
`try_unwrap().unwrap().into_inner().unwrap()` shape.

## Recommendation
Collect results without shared ownership: use `futures::future::join_all` /
`JoinSet` and return owned `Vec`s from each task, or replace the
`Arc<Mutex<Vec<_>>>` accumulator with an `mpsc` channel drained after all tasks
join. If the shared accumulator must stay, replace the double-unwrap with
graceful handling: `Arc::try_unwrap(...).map(|m| m.into_inner()...).unwrap_or_default()`
after an explicit join of every spawned task, and propagate a real error rather
than panicking.
