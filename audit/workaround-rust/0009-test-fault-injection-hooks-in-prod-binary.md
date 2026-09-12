---
id: WA-RS-009
title: Test fault-injection env hooks compiled into production binaries
angle: workaround-rust
severity: low
category: workaround
is_workaround: true
subsystem: agent/io, agent/daemon
evidence:
  - agent/src/io/tcp.rs:196
  - agent/src/daemon/transport.rs:490
status: fixed
resolution: "#2847 — TERMIHUB_TEST_STARTUP_DELAY_MS gated behind cfg(debug_assertions) (compiled out of release, verified via strings); LINGERING_SOCKET was already cfg(test)-gated (finding half-stale)"
---

## What
Fault-injection hooks that exist only to make test races reproducible live in
production (non-`#[cfg(test)]`) code paths, gated on env vars:

- `agent/src/io/tcp.rs` — `startup_test_delay()` sleeps
  `TERMIHUB_TEST_STARTUP_DELAY_MS` ms on the listener-bind path (#1579), to
  reproduce the accept-before-ready race.
- `agent/src/daemon/transport.rs` — `TERMIHUB_TEST_LINGERING_SOCKET` simulates
  the dead-but-lingering daemon socket from the #2491 reconnect bug.

## Why it matters
Test-only behavior is shipped inside the release agent binary. Each is documented
as "unset in production → a single failed env lookup", so runtime cost/risk is
negligible — but it is test scaffolding embedded in production code, and an
attacker/operator who sets these env vars on the agent host can inject a startup
delay or a fake lingering socket. Related config-via-env hooks that are contract,
not fault injection: `TERMIHUB_TYPE_ID`, `TERMIHUB_SETTINGS`,
`TERMIHUB_BUFFER_SIZE` (daemon spawn contract, legitimate) and
`TERMIHUB_AGENT_UPDATE_API_URL/ASSET_SUFFIX/INITIAL_DELAY_MS` (documented update
overrides).

## Recommendation
Gate the pure fault-injection hooks (`STARTUP_DELAY_MS`, `LINGERING_SOCKET`)
behind a `#[cfg(feature = "test-hooks")]` / `#[cfg(debug_assertions)]` so they are
compiled out of release builds entirely, rather than relying on the env var being
unset. Keep the legitimate config-via-env contract vars as-is (they are how the
parent configures the daemon child) but confirm they are documented in
`docs/remote-protocol.md`.
