---
id: PERF-010
title: OutputCoalescer::try_coalesce is dead code carrying an O(n²) remainder copy
angle: performance
severity: low
category: perf
is_workaround: true
subsystem: core/src/output/coalescer.rs
evidence:
  - core/src/output/coalescer.rs:37
  - core/src/output/coalescer.rs:41
  - src-tauri/src/session/manager.rs:1870
status: open
---

## What
`OutputCoalescer::try_coalesce` (the size-thresholded drain that splits at
`max_batch_bytes`) is **dead code**: the real output reader loop drives the coalescer with
`push()` / `pending_len()` / `flush()` only, and `try_coalesce()` is referenced solely by
its own unit tests. The dead method also contains an inefficient implementation —
`self.pending = self.pending[self.max_batch_bytes..].to_vec()` reallocates and copies the
entire remainder on each call (O(n²) over a large pending buffer) — but since it is never
called, this is a latent trap rather than a live cost.

## Why it matters
Two smaller issues, not a live hot-path defect:
1. **Misleading dead code.** The coalescer's public contract advertises a batch-splitting
   method the app does not use; a future caller could adopt `try_coalesce` and inherit the
   O(n²) remainder copy. `flush()` (which the app actually uses) drains everything and never
   splits at `max_batch_bytes`, so a single emit can exceed the nominal 32 KB batch cap —
   worth documenting as the real behaviour.
2. Per the workaround mandate, dead code kept "just in case" should be removed before
   release.

## Evidence
- `core/src/output/coalescer.rs:37-44` — `try_coalesce`, with the remainder `to_vec()` at line 41-42.
- `core/src/output/coalescer.rs:52-135` — the only callers are `#[cfg(test)]` unit tests.
- `src-tauri/src/session/manager.rs:1870-1884` — the production loop uses `push` + `pending_len` + `flush`, never `try_coalesce`.

## Recommendation
- Remove `try_coalesce` (and its tests), or, if a size-capped emit is actually wanted, wire
  it into `run_output_reader` and fix the remainder handling to a `VecDeque`/`drain` so it is
  O(batch) not O(remainder). Then update the doc comment to state the true per-emit size
  bound. Given the reader already caps accumulation via the `pending_len() < MAX` guard,
  deletion is the simpler correct choice.
</content>
</invoke>
