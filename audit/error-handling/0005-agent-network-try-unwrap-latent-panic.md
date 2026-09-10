---
id: ERR-005
title: Agent network diagnostics panic via Arc::try_unwrap().unwrap() if any result-collector clone survives
angle: error-handling
severity: medium
category: bug
is_workaround: true
subsystem: agent/src/network/mod.rs
evidence:
  - agent/src/network/mod.rs:50
  - agent/src/network/mod.rs:71
  - agent/src/network/mod.rs:107
status: open
---

## What
Three agent network handlers collect results into an `Arc<Mutex<Vec<_>>>`, hand a **clone** of that `Arc` to a per-result callback, run the scan, then reclaim the vec with a triple-unwrap:

```rust
let results = Arc::try_unwrap(results).unwrap().into_inner().unwrap();   // port scan  :50
let results = Arc::try_unwrap(results).unwrap().into_inner().unwrap();   // ping       :71
let hops    = Arc::try_unwrap(hops).unwrap().into_inner().unwrap();      // traceroute :107
```

`Arc::try_unwrap(...).unwrap()` **panics if the strong count is not exactly 1** at that moment — i.e. if *any* clone of the `Arc` still exists. The clone lives inside the `on_result`/`on_hop` closure that was moved into `scan_ports` / `ping_stream` / `traceroute`. Correctness therefore depends entirely on those functions **fully dropping the callback before returning** — including every internal task they spawn. Port scanning in particular runs with concurrency (spawned probe tasks); if the driver returns after the last *await* but a straggler task still holds the callback (cancellation, a probe finishing after the summary is produced, or the callback being cloned per-task), `try_unwrap` panics.

This is the exact anti-pattern the repo bans (`.unwrap()` on a real path) and it sits on a **user-reachable, hostile-input-adjacent** verb: the desktop tells the agent to port-scan / ping / traceroute an arbitrary host.

## Why it matters
- **A panic here kills the async task servicing that RPC inside the agent worker process.** Depending on where it unwinds, it can drop the client's transport loop — the desktop sees the agent connection die mid-diagnostic. The panic is timing-dependent (task scheduling, cancellation), so it is exactly the kind of intermittent crash that escapes unit tests and shows up under load.
- The `results_clone.lock().unwrap()` inside each closure (`:36,64,100`) is a second poison-panic site feeding the same subsystem (see ERR-001): if a probe panics while holding that lock, the mutex poisons and the `into_inner().unwrap()` at the end panics too.
- The correct value is trivially recoverable without any unwrap.

## Evidence
- `agent/src/network/mod.rs:50,71,107` — `Arc::try_unwrap(...).unwrap().into_inner().unwrap()`.
- `agent/src/network/mod.rs:36,64,100` — `.lock().unwrap()` inside the result callbacks.

## Recommendation
Don't reclaim through `Arc::try_unwrap`. Either (a) collect via an `mpsc`/`tokio::sync::mpsc` channel the driver owns and drain it after the await, or (b) keep the `Arc<Mutex<Vec>>` but read it out with `results.lock().unwrap_or_else(|e| e.into_inner()).clone()` / `std::mem::take` — no strong-count assumption, no panic. Add a test that runs a scan with concurrency + mid-scan cancel to prove no residual clone panics. Mark `is_workaround` until removed.
</content>
