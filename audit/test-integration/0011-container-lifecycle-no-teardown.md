---
id: TIN-011
title: The harness never tears down Docker fixtures and app-spawned session containers can orphan — flake + resource risk
angle: test-integration
severity: medium
category: reliability
is_workaround: false
subsystem: tests/system/termihub_harness/fixtures.py, orchestrator
evidence:
  - tests/system/termihub_harness/fixtures.py:153
  - scripts/test-system-linux.sh:100
  - docs/testing.md:1807
status: open
---

## What

`ComposeFixture` deliberately **does not tear containers down** — "they are
shared fixtures that survive … the infra is brought up once and torn down by the
run script, not the tests" (`fixtures.py:153-158`). Teardown depends entirely on
the orchestration script's `EXIT` trap (`test-system-linux.sh:100-129`, which is
also skippable via `--keep-infra`). If a run is killed hard (crash, SIGKILL, CI
cancel outside the trap), the fixture containers persist.

Separately, the **app itself** spawns Docker session containers
(`termihub-<ts>-<pid>`); the docs note orphaned-spawned-container handling
(#1466, `docs/testing.md:1807`) and directory-mount spawns must be "removed
manually to clean up" (#1662). The coordinator's own operating memory records a
real incident of ~27 stale `termihub-<ts>-<pid>` containers pinning the VM and
mimicking E2E failures.

## Why it matters

- Leftover containers hold the fixed host ports the Linux lane relies on
  (2201/2203/…); a subsequent run then either reuses stale state or fails to bind
  — surfacing as flaky, cross-run failures that look like real bugs.
- On a shared dev machine (the ten-checkout setup) this accumulates silently
  until the VM is starved, corrupting diagnosis (documented incident).
- Reliance on an `EXIT` trap means the one failure mode that most needs cleanup
  (a hard crash) is exactly the one the trap misses.

## Evidence

- `fixtures.py:153-158` — no teardown by design.
- `test-system-linux.sh:100-129` — cleanup only via `EXIT` trap, `--keep-infra`
  bypass.
- `docs/testing.md` — #1466 orphaned-spawned-container regrouping; #1662
  "Remove it manually."

## Recommendation

- Add a **pre-run reaper**: before bring-up, prune any container matching this
  checkout's `compose_project` prefix and any stale `termihub-<ts>-<pid>` from a
  previous run, so a run always starts clean regardless of how the last one died.
- Namespace app-spawned session containers per checkout (they already exist) and
  add a session-teardown assertion (the Open Connections panel / a bridge check)
  that no `termihub-*` session container outlives app quit — turning the manual
  "no orphan" checks (RDP helper, vcxsrv, session containers) into automated
  post-conditions.
