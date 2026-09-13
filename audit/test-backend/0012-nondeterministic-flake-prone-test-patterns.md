---
id: TBE-012
title: Timing/real-network/port-contention patterns make integration tests inherently flake-prone
angle: test-backend
severity: medium
category: test-gap
is_workaround: false
subsystem: core/tests + agent/tests
evidence:
  - core/tests/network_resilience.rs:66
  - core/src/ipc/ndjson.rs:86
  - agent/tests/local_agent_integration.rs:98
  - agent/tests/tcp_listener_readiness.rs:129
status: open
---

## What
Several tests are non-deterministic by construction:
- `network_resilience.rs` drives real `tc netem` latency/loss/jitter/corruption profiles
  (net_fault_01..10) against a live container — timing-dependent pass/fail with no fake clock.
- `ndjson.rs:86` uses a real `sleep(10ms)` to sequence a partial-read test — a wall-clock race.
- The whole `local_agent_integration.rs` suite needed a bespoke concurrency gate + phase-timing
  instrumentation (lines 91-268) precisely because parallel real agent processes oversubscribe the
  runner (#2495), and `tcp_listener_readiness.rs:129` caps worker threads for the same reason.

## Why it matters
The project's own operating notes call CI flakes "the biggest non-code time sink," with ~half a
dozen agents burned chasing single flakes and a standing quarantine (TBE-004). Timing-based and
real-network tests are the root pattern: they conflate "the code regressed" with "the runner was
busy." Under a ventilator-grade bar a flaky safety check is worse than a slow one — it trains
reviewers to re-run rather than investigate.

## Evidence
- network_resilience.rs:30-300 — 10 real-tc-netem timing tests.
- ndjson.rs:86 — `tokio::time::sleep(Duration::from_millis(10))` inside a unit test.
- local_agent_integration.rs:91-268 — concurrency gate + timing instrumentation added to fight
  oversubscription flake; tcp_listener_readiness.rs:129 — Windows worker-thread cap.

## Recommendation
Where behaviour (not real transport timing) is under test, replace wall-clock sleeps with
`tokio::time::pause()`/`advance()` deterministic time and in-memory duplex transports (the ndjson
partial-read test can use `duplex` without a real sleep). Keep the genuinely-network tests but
isolate them to the nightly lane and gate them on fixture health (TBE-006) so a busy runner reds as
"infra", not "regression". Track the #2495 root cause to removal rather than living on the
concurrency-gate workaround indefinitely.
