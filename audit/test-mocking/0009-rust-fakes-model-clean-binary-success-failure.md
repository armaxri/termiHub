---
id: MOCK-009
title: Rust transport/backend fakes model clean binary success/failure with canned payloads, not partial reads, timeouts, or malformed output
angle: test-mocking
severity: medium
category: test-gap
is_workaround: false
subsystem: core/backends/ssh/monitoring, src-tauri fakes
evidence:
  - core/src/backends/ssh/monitoring.rs:526
  - core/src/backends/ssh/monitoring.rs:508
  - src-tauri/src/session/remote_proxy.rs:803
status: open
---

## What
The Rust reconnect/monitoring state machines are verified against fakes whose contract is
"connect either fully succeeds or cleanly errors, and collect returns a **fixed, well-formed**
string." Example: `FakeTransport` in the SSH monitoring tests
(`core/src/backends/ssh/monitoring.rs:526`) returns a constant `SAMPLE_STATS` blob
(`:508,561`) and toggles success/failure via atomics — its `connect` and `collect` either
`Ok` a canned value or `Err(Other(..))`, instantly.

Reality on this path is messier: a real SSH monitoring collect can return a **partial** read,
a truncated `/proc` sample, interleaved stderr, a stall that must be treated as a timeout, or
a well-formed-but-unexpected value from a different distro. None of these are representable by
a fake that only flips a clean Ok/Err flag. The same shape recurs in the src-tauri fakes
(`MockAgentRpcClient`, `FakeAgent`, `FakeTunnels`, `MockConnection` …): they model the happy
result type and a clean error, not the degraded middle.

## Why it matters
- The reconnect and Live↔Stale↔Offline transition logic — a headline reliability feature — is
  proven only against an idealized transport. A real backend's partial/slow/garbled responses
  (the exact conditions that trigger reconnect in the field) are not exercised, so a bug in how
  a *degraded* collect is classified would not be caught by these tests.
- Canned `SAMPLE_STATS` also means the monitoring **parser** is fed one perfect sample; there
  is no adversarial/malformed monitoring input here (complements TBE-002's NDJSON gap on the
  framing layer).

## Evidence
- `FakeTransport` with atomic success/fail flags and constant output:
  `core/src/backends/ssh/monitoring.rs:526-590`.
- Canned sample: `SAMPLE_STATS` at `:508`, used as `collect_output` at `:561`.
- Same clean-Ok/Err shape in `MockAgentRpcClient`: `src-tauri/src/session/remote_proxy.rs:803`.

## Recommendation
Add fault-mode capability to these fakes: a `collect` that can return a truncated/garbled
sample, a `connect`/`collect` that can *hang* (drive the timeout branch via
`tokio::time::advance`, not wall-clock sleeps), and a collect that returns an unexpected-but-
valid distro variant. Then assert the state machine classifies each correctly (Stale vs Offline
vs recovered). This turns the reconnect tests from "clean transport, does it flip flags" into
"degraded transport, does it decide correctly."
