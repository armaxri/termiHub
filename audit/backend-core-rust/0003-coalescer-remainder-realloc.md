---
id: CORE-003
title: OutputCoalescer::try_coalesce reallocates and copies the remainder on every call
angle: backend-core-rust
severity: low
category: perf
is_workaround: false
subsystem: core/output/coalescer
evidence:
  - core/src/output/coalescer.rs:41
status: open
---

## What
`try_coalesce` slices off the batch, then rebuilds `pending` from the remainder
with a fresh allocation and copy:

```rust
let batch = self.pending[..self.max_batch_bytes].to_vec();
self.pending = self.pending[self.max_batch_bytes..].to_vec();
Some(batch)
```

Every call copies the entire remaining buffer into a new `Vec`.

## Why it matters
On a hot terminal-output path a large `pending` drained in `max_batch_bytes`
chunks becomes O(n²) in total copying (each drain re-copies the tail). It is a
per-session overhead on the output fast path. Not a correctness issue, but the
coalescer exists precisely to reduce output-path overhead, so the quadratic copy
undercuts its purpose.

## Evidence
`core/src/output/coalescer.rs:37-44`. `flush` (line 27-32) already does the
right thing with `std::mem::take`; only `try_coalesce` re-allocates.

## Recommendation
Use a `VecDeque<u8>` for `pending` and `drain(..max_batch_bytes)`, or keep a
`Vec` and use `self.pending.drain(..n).collect()` for the batch (leaving the
remainder shifted in place once), avoiding a full remainder copy per call.
