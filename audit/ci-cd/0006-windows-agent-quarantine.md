---
id: CI-006
title: 16 Windows agent tests quarantined behind a non-blocking grade that never un-quarantines
angle: ci-cd
severity: high
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/agent-integration-windows-serial-grade.yml:72
  - .github/workflows/agent-integration-windows-grade.yml:40
  - .github/workflows/agent-integration-windows-serial-grade.yml:15
status: open
---

## What
16 live-agent-TCP tests (15 in `agent/tests/local_agent_integration.rs`, 1 in
`tcp_listener_readiness.rs`) are quarantined on Windows via `#[cfg_attr(windows, ignore … #2495)]`,
so the per-PR `agent.yml` Windows leg skips them entirely. Two dedicated workflows exist to grade the
quarantine:

- `agent-integration-windows-serial-grade.yml` runs the `--ignored` subset serially on agent PRs but
  is **`continue-on-error: true`** (`:72`) — it can never red a PR; it only "observes".
- `agent-integration-windows-grade.yml` is **manual-only** (`workflow_dispatch`).

A separate Windows PTY flake in `core::backends::local_shell` is tracked as #2498. The deep-fix
tracker #2495 is still open.

## Why it matters
This is a large permanently-skipped block of the agent's core transport tests on one of the three
shipped platforms, with the un-quarantine path gated on "many consecutive green" grade runs that
nobody is obligated to perform (the grade job cannot fail anything). Quarantines that never get
un-quarantined are how coverage quietly erodes: Windows agent connect/reconnect behaviour — the
safety-critical path — is graded only by an advisory job whose red result blocks nothing. The
scaffolding is well-built and honest, but it has no forcing function to ever retire the workaround.

## Evidence
`agent-integration-windows-serial-grade.yml:28-43` (the "flip to real fix" plan requires manually
removing `continue-on-error` and the `#[ignore]` attrs); `:72` the non-blocking flag;
`agent-integration-windows-grade.yml:40` manual trigger. Both cache with `save-if: false`.

## Recommendation
Give the un-quarantine a deadline and an owner. Since the serial+isolated lane is the theory for a
deterministic fix, run it blocking on a scheduled cadence (not just advisory-on-PR) and require a
tracked number of consecutive greens, then delete the `#[ignore]` attrs and close #2495 / #2498.
Until then, surface the grade result on a dashboard so the skipped coverage is visible, not silent.
