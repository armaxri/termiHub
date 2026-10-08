---
id: MOCK2-004
title: "test_auto_refresh_keeps_stats sleeps 7s and then asserts only that stats exist, so it passes even when auto-refresh is broken"
angle: test-mocking
severity: low
category: test-gap
is_workaround: false
subsystem: "tests/system/tests/test_ssh_monitoring.py"
evidence:
  - tests/system/tests/test_ssh_monitoring.py:134
  - tests/system/tests/test_ssh_monitoring.py:137
  - tests/system/tests/test_ssh_monitoring.py:138
  - tests/system/tests/test_ssh_monitoring.py:123
  - tests/system/termihub_harness/ui/monitoring.py:31
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The test waits for the first stats, runs `time.sleep(7)  # auto-refresh interval is ~5s`, then asserts `self.monitoring_stats() is not None`. `monitoring_stats()` only checks that the `monitoring-cpu` element exists and reads its text. Once the first sample has rendered, that stays true even if no further sample ever arrives. The same class already has a `_sample_count(key)` helper (:123) that reads the monitor's `sampleCount`, but this test does not use it.

## Why it matters

The test claims to cover auto-refresh but cannot fail when refresh stops: a stalled collector or a monitor stuck in Connecting (compare follow-up #3252) still passes. It also spends a fixed 7s of wall clock per run on the nightly lanes, which are already close to their timeouts.

## Recommendation

Replace the sleep with a bounded poll that proves refresh happened. Read `n0 = _sample_count(key)`, then `self.wait(lambda: (_sample_count(key) or 0) > n0, timeout=20, what="a second monitoring sample")`. Optionally also assert that the displayed text updated.

## Verification

Confirmed. test_auto_refresh_keeps_stats does wait_for_monitoring_stats, then time.sleep(7), then asserts monitoring_stats() is not None. monitoring_stats() only checks that monitoring-cpu exists and reads text, which stays true after the first sample even if refresh stalls. The \_sample_count helper at :123 is available but unused. The test cannot detect a broken auto-refresh and wastes a fixed 7s.
