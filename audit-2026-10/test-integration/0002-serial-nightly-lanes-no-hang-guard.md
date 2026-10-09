---
id: TIN2-002
title: "Serial nightly lanes (Linux bulk, all display-grades legs) run without a hang guard"
angle: test-integration
severity: medium
category: "ci-robustness"
is_workaround: false
subsystem: "tests/system hang_guard + system-integration.yml"
evidence:
  - tests/system/termihub_harness/hang_guard.py:22
  - tests/system/termihub_harness/hang_guard.py:73
  - tests/system/conftest.py:166
  - .github/workflows/system-integration.yml:123
  - .github/workflows/system-integration.yml:125
  - .github/workflows/system-integration.yml:411
  - .github/workflows/system-integration.yml:560
  - .github/workflows/system-integration.yml:690
  - .github/workflows/system-integration.yml:702
  - tests/system/pyproject.toml:8
status: fixed
resolution: "#4315 — serial lanes run under one xdist worker so the hang guard arms; a hang dumps stacks, processes and app state"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The per-phase hang guard (#4017) arms only when PYTEST_XDIST_WORKER is set (hang_guard.py:73). Only the macOS/Windows bulk legs run under xdist. The Linux bulk leg runs serially with no -n (system-integration.yml:411). It is the leg with every Docker-backed suite and a 180-minute ceiling. The display-grades job runs serially on all three OSes (lines 690/702, 90-minute ceiling). pytest-timeout is not a dependency (pyproject.toml), so these runs have no per-test bound. The workflow comment at line 123 states the gap itself: 'A hang is bounded per test by the harness' hang guard on the xdist legs'.

## Why it matters

\#4017 recorded the failure mode: one blocking call with no timeout froze a lane until the job ceiling cancelled it. The result was no failure, no traceback, and every later suite unrun. On the Linux leg that means up to 180 runner-minutes lost, plus every SSH/SFTP/agent/RDP/VNC suite after the hang going unrun, with no record of which test hung. display-grades carries test_agent_reconnect_ui, the only automated grade of the safety-critical reconnect path. A hang there shows up as a 90-minute 'operation was canceled' with no attributed failure.

## Evidence

- `tests/system/termihub_harness/hang_guard.py:22`
- `tests/system/termihub_harness/hang_guard.py:73`
- `tests/system/conftest.py:166`
- `.github/workflows/system-integration.yml:123`
- `.github/workflows/system-integration.yml:125`
- `.github/workflows/system-integration.yml:411`
- `.github/workflows/system-integration.yml:560`
- `.github/workflows/system-integration.yml:690`
- `.github/workflows/system-integration.yml:702`
- `tests/system/pyproject.toml:8`

## Recommendation

Run the Linux bulk step and the display-grades steps under xdist with a single worker (`-n 1 --dist loadscope`). This needs no extra parallelism, so the fixed host ports are unaffected. A hung test then crashes and is attributed, and a replacement worker carries on with the rest. Alternatively, add pytest-timeout with method=thread and a generous per-test budget as a backstop for non-xdist runs. Update the comment at line 123 to match.

## Verification

Confirmed. hang_guard.enabled() arms only on PYTEST_XDIST_WORKER unless TERMIHUB_TEST_HANG_GUARD=1, and no workflow sets that variable. The Linux bulk step (line 411) and both display-grades steps run without -n. pyproject has no pytest-timeout. The workflow comment at line 123 itself says the hang bound applies only 'on the xdist legs'. A hang on the Linux leg (180 min) or in display-grades (90 min) would end in an unattributed cancel.
