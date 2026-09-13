---
id: TBE-004
title: 16 live-agent-TCP tests quarantined on Windows (#2495) with no landed deterministic fix
angle: test-backend
severity: medium
category: workaround
is_workaround: true
subsystem: agent/tests
evidence:
  - agent/tests/local_agent_integration.rs:52
  - agent/tests/local_agent_integration.rs:1083
  - agent/tests/tcp_listener_readiness.rs:118
  - .github/workflows/agent-integration-windows-grade.yml:117
status: open
---

## What
The live-agent-TCP integration tests are `#[cfg_attr(windows, ignore = "flaky under Windows-runner
oversubscription; see #2495")]` — 15 in `local_agent_integration.rs` (lines 1083, 1095, 1121,
1147, 1541, 1572, 1609, 1663, 1761, 2168, 2235, 2336, 2483, 2578, 2676) plus 1 in
`tcp_listener_readiness.rs:118` = **16 tests** that never run on the Windows CI leg. Windows agent
behaviour is only graded by two on-demand workflows (`agent-integration-windows-grade.yml`,
`agent-integration-windows-serial-grade.yml`), not per-PR.

## Why it matters
The quarantine masks a real, unexplained defect — the agent is genuinely >60s slow to respond
under Windows-runner load (#2495 is the OPEN deep-fix tracker for *why*). Until that lands, Windows
is the platform where the agent's connect/attach path is least verified, and per the project's own
"un-quarantine needs >>3 green runs" lesson, the mitigation (concurrency gate + phase-timing
instrumentation) has not been proven to make these deterministic. This is finished-looking test
coverage that does not actually run on one of the three shipped platforms.

## Evidence
- local_agent_integration.rs:16-63 — the quarantine rationale + un-quarantine criteria.
- 15 `ignore = "... see #2495"` attributes enumerated above; tcp_listener_readiness.rs:118 = the 16th.
- agent-integration-windows-grade.yml:117 — runs the ignored set via `-- --ignored` on demand only.

## Recommendation
Land the #2495 deterministic root-cause fix (Windows agent startup slowness), then remove all 16
`cfg_attr(windows, ignore)` attributes and re-enable on the per-PR Windows leg. Until then this is
a known un-verified surface — track it as a release-gating workaround, not settled coverage. Do
not un-quarantine on a handful of green grade runs (chronic flakes recur immediately).
