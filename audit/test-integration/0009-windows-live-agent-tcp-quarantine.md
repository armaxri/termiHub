---
id: TIN-009
title: 16 Windows live-agent-TCP tests are quarantined behind a still-open deep-fix and non-blocking grading lanes
angle: test-integration
severity: medium
category: workaround
is_workaround: true
subsystem: agent/tests/local_agent_integration.rs, agent/tests/tcp_listener_readiness.rs
evidence:
  - agent/tests/local_agent_integration.rs:52
  - .github/workflows/agent-integration-windows-serial-grade.yml:823
  - .github/workflows/agent-integration-windows-grade.yml:1
status: open
---

## What

16 live-agent-TCP tests (15 in `local_agent_integration.rs`, 1 in
`tcp_listener_readiness.rs`) chronically flaked **only on the Windows CI leg**
(`Os { code: 10060, kind: TimedOut }`, a random test each run, from cold-start
over-subscription). They are quarantined via `#[cfg_attr(windows, ignore …
#2495)]`, so per-PR CI no longer runs them on Windows. The deep-fix tracker
**#2495 is still open**.

Two grading lanes exist to eventually un-quarantine, both **non-gating**:

- `agent-integration-windows-serial-grade.yml` — runs the `--ignored` subset
  serially/isolated, `continue-on-error: true` (`:823`), so a red grade can never
  red a PR; it only accumulates a signal.
- `agent-integration-windows-grade.yml` — `workflow_dispatch`-only manual loop.

## Why it matters

- The agent's live TCP transport is exactly the layer that carries remote
  sessions; on Windows it is currently **unverified in blocking CI**. A real
  Windows transport regression would not red any required check.
- The repo's own rule ("3 green proves nothing — require many consecutive green
  runs") means this quarantine is likely to persist; it is a standing hole in
  Windows agent coverage, not a transient one. Transport band-aids (#2492 connect
  retry, #2494 read deadline) and concurrency gates (#2501/#2528) reduced but
  never eliminated the flake.

## Evidence

- `local_agent_integration.rs:52` — quarantine rationale + `#[cfg_attr(windows,
  ignore … #2495)]`.
- `agent-integration-windows-serial-grade.yml:779-794, 823` — non-blocking by
  design; un-quarantine steps documented but not taken.

## Recommendation

- Drive #2495 to a deterministic root-cause fix (the serial+isolated lane already
  shows the contention is the cause), then remove `continue-on-error` and the
  `#[cfg_attr(windows, ignore …)]` attributes so the tests run per-PR again.
- Until then, keep the quarantine visible on the release checklist as a known
  Windows-agent coverage gap — it should not be forgotten because the grading
  lanes are green-by-non-blocking.
