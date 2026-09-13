---
id: LIBBE-005
title: RefPool (SSH gateway session pool) is correctly hand-rolled — generic pool crates do not fit
angle: lib-usage-backend
severity: info
category: arch
is_workaround: false
subsystem: core/backends/ssh
evidence:
  - core/src/backends/ssh/session_pool.rs:46
status: open
---

## What
`core/src/backends/ssh/session_pool.rs` implements `RefPool<T>`: a
reference-counted, single-flight pool of cheaply-cloneable handles keyed by
string, backing `shared_gateway_pool()` (process-wide reuse of jump-host gateway
`russh` sessions). This is a hand-rolled pool, and the natural buy-vs-build
question is "why not `deadpool` / `bb8` / `mobc`?"

## Why it matters
Recorded as an **info / keep-as-is** finding because keeping it hand-rolled is the
**right** call — the brief asks for those to be noted too.

The mainstream Rust pool crates (`deadpool`, `bb8`, `mobc`) model a
**checkout/check-in** pool: N interchangeable resources, each lent to one
consumer at a time and returned. `RefPool` implements a fundamentally different
shape:

- **Shared, not exclusive.** Every consumer that acquires a key gets a *clone of
  the same* `Arc` (one gateway session multiplexed by many tunnels), not an
  exclusive lease.
- **Single-flight creation** — the value is created at most once per key even
  under concurrent acquisition; racing callers await the winner.
- **Refcounted teardown** — the entry is dropped when the last `PooledRef`
  releases.
- **Generation-tagged eviction (#1315)** — a dead session can be evicted and
  replaced while a dying consumer's `PooledRef` is still in flight; the stale ref
  releases as a no-op instead of decrementing the replacement. The `Drop`-outside-
  the-lock discipline also guards against re-entrancy when a pooled value's own
  `Drop` re-enters the pool.

None of the generic crates express "many share one handle, created once,
refcounted, generation-safe eviction". Forcing one in would be a worse fit and
would not carry the #1315 correctness property. The module is thoroughly unit-
tested (single-flight under concurrency, dead-entry eviction, stale-release
no-op, failed-connect-does-not-poison).

## Evidence
`core/src/backends/ssh/session_pool.rs:46-232` (the pool), `:261-265` (`Drop` →
`release`), `:289-292` (the process-wide `OnceLock` gateway pool), and the test
module `:294-532`.

## Recommendation
**keep-as-is.** No change. If anything, the single-flight primitive alone
(`get_or_create`) resembles `async_once_cell`/`OnceCell::get_or_try_init`, but the
refcount + generation eviction on top make the bespoke type the clearer, safer
home for this logic. Flagged only to document that the buy-vs-build question was
asked and answered.
</content>
