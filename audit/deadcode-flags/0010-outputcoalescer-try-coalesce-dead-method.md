---
id: DEAD-010
title: OutputCoalescer::try_coalesce() is never called in production
angle: deadcode-flags
severity: low
category: perf
is_workaround: false
subsystem: core/src/output/coalescer.rs
evidence:
  - core/src/output/coalescer.rs:37
  - src-tauri/src/session/manager.rs:1870
status: open
---

## What
`OutputCoalescer` is used by the session output loop, but only its `push`,
`pending_len`, and `flush` methods. `try_coalesce()` — the threshold-batching variant
that drains exactly `max_batch_bytes` and keeps the remainder — is **only exercised by
unit tests**, never on any real code path. The production loop in `manager.rs` reads
its own `pending_len() < MAX_COALESCE_BYTES` gate and then calls `flush()`, so
`try_coalesce`'s batching logic is dead.

## Why it matters
Dead method plus five unit tests testing behaviour the app never invokes. Minor, but
it is the kind of "looks load-bearing, isn't" surface a pre-release cleanup should remove.

## Evidence
- `core/src/output/coalescer.rs:37` `pub fn try_coalesce(&mut self) -> Option<Vec<u8>>`.
- Only caller of `OutputCoalescer`: `src-tauri/src/session/manager.rs:1870-1888`,
  which uses `push` / `pending_len` / `flush`, not `try_coalesce`.
- `grep -rn "try_coalesce" core/ src-tauri/ agent/` → only the definition and its
  in-file `#[cfg(test)]` tests.

## Recommendation
Either delete `try_coalesce` and its unit tests, or — if the intended design was for
`manager.rs` to batch via `try_coalesce` rather than the hand-rolled `pending_len`
loop — switch the loop to use it and keep one path. Deleting is the lower-risk option
for release.
