---
id: TBE-011
title: Reconnect/cancellation races have no fast unit tests; only golden policy + live-integration recovery
angle: test-backend
severity: medium
category: test-gap
is_workaround: false
subsystem: core/reconnect + backends
evidence:
  - core/tests/reconnect_backoff_golden.rs:1
  - core/tests/ftp_reconnect.rs:25
  - core/tests/network_resilience.rs:237
status: open
---

## What
Reconnect coverage splits into two buckets, with a gap between them:
1. **Policy** — `reconnect_backoff_golden.rs` and `core/src/backends/ftp/reconnect.rs` unit tests
   cover the *deterministic policy* (retry count, backoff curve, error classification).
2. **Live recovery** — `ftp_reconnect.rs`, `network_resilience.rs` (net_fault_08 disconnect+recovery)
   verify a full recover against a real fixture — but these are the dark integration lane (TBE-006).

Nothing in between exercises the **reconnect state machine under concurrency**: a reconnect racing
a user-initiated disconnect, a cancellation mid-connect, a second attach arriving during a
reconnect, or the dead-socket/connect-timeout fast-fail path (the #2491 "stuck Reconnecting" class)
as a deterministic unit test. `ftp_reconnect.rs:25-27` explicitly notes the *policy* lives in unit
tests and this file only checks the live wiring — so the concurrent/cancellation transitions have
no home.

## Why it matters
The reconnect machine is a documented recurring bug source (the 30s dead-socket timeout, the stuck-
reconnect inversion work). Race/cancellation transitions are the ones that produced real incidents,
yet they are only reachable through slow, fixture-bound, self-skipping integration tests. A
regression in cancel-during-reconnect would not red any per-PR lane.

## Evidence
- reconnect_backoff_golden.rs, ftp/reconnect.rs tests — policy only, no concurrency.
- ftp_reconnect.rs:25-27 — comment scoping this file to live wiring, policy elsewhere.
- No `tokio::time::timeout` + `tokio::join!` cancellation test for any reconnect path.

## Recommendation
Add unit-level state-machine tests using a fake transport (no network): assert transitions for
connect-cancelled, disconnect-during-reconnect, reconnect-succeeds-after-N, and dead-socket fast-
fail (assert the ~2s bound, not ~30s). These run per-PR and cover the transitions the integration
lane exercises too slowly and too rarely.
