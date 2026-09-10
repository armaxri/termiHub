---
id: TBE-008
title: Agent session manager has no multi-client concurrency test; AB-BA deadlock is invisible
angle: test-backend
severity: high
category: test-gap
is_workaround: false
subsystem: agent/session/manager
evidence:
  - agent/src/session/manager.rs:1377
  - agent/src/session/manager.rs:2043
  - agent/tests/local_agent_integration.rs:98
status: open
---

## What
Every `SessionManager` unit test (manager.rs:1377-2380 — ~40 tests) drives a **single** client
sequentially: create/list/attach/detach/close, update-deferral state machine, backend-exit
settling. None spins up **two clients concurrently** attached to the same session, and none
asserts anything about lock-ordering. The agent integration tests (local_agent_integration.rs)
run many agent *processes* in parallel (manager.rs:98) but each is one client against its own
agent — again never two clients contending on one session's locks.

## Why it matters
A cross-expert finding reports an AB-BA lock-ordering deadlock in the agent that requires ≥2
clients to trigger and is therefore invisible to every single-client test. The test architecture
has no place such a bug could surface: there is no concurrent-attach fixture, no
`tokio::join!`/two-task contention test, no loom-style lock-order check. This is the highest-risk
concurrency path (shared session, multiple desktops attached) with zero adversarial concurrency
coverage.

## Evidence
- manager.rs:1377-2380 — all `#[tokio::test]` bodies are sequential, single-client.
- `grep -rn 'client_b\|two client\|concurrent attach\|tokio::join'` over agent tests → no
  concurrent-two-client-on-one-session case.
- local_agent_integration.rs:98-116 — parallelism is *across agents*, not *clients per session*.

## Recommendation
Add a concurrency test that attaches two clients to one session and exercises the
attach/detach/write/close cross-product under `tokio::join!` with a watchdog timeout (a deadlock
manifests as the test hanging → wrap in `tokio::time::timeout` and assert completion). Consider a
`loom` model of the two-lock acquisition order for the shared-session mutexes. Any reconnect/
multi-desktop feature must ship with a ≥2-client test.
