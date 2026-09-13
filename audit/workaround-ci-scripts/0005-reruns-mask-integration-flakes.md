---
id: WA-CI-005
title: system-integration lanes use --reruns 4 to auto-retry (masks residual flakes)
angle: workaround-ci-scripts
severity: medium
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/system-integration.yml:288
  - .github/workflows/system-integration.yml:352
  - .github/workflows/system-integration.yml:503
status: open
---

## What
All three integration legs of `system-integration.yml` pass `--reruns 4 --reruns-delay 1` to
pytest, so any failed integration test is silently re-run up to 4 times and passes if any
attempt succeeds. Comments (lines 278-288, 346-352, 495-503) attribute this to #2698 and call
it "bounded auto-retries [that] absorb the noise while the real bugs are already fixed."

## Why it matters
`--reruns 4` is a flake mask: a test that passes 1-in-5 times is reported green. It can hide a
real intermittent regression (a race, a resource leak, a slow path) behind the retry budget.
Per the project's own chronic-flake policy, retries should be a temporary net, not a permanent
gate design — and 4 reruns is a wide net.

## Evidence
`--reruns 4 --reruns-delay 1 -r aR` at lines 288 (macOS single-worker), 352 (xdist bulk), 503
(single-instance serial lane). The `-r aR` reporting is retained so reruns are at least visible
in the log.

## Recommendation
Justified as a stabilization net for #2698, but treat it as a ratchet to tighten: drive the
count down (4 → 2 → 0) as the underlying races are fixed, and audit the rerun report (`-r aR`)
each nightly run so a test that *only* passes on retry is triaged as a real bug rather than
left masked. Do not un-quarantine the reruns wholesale; step them down with evidence.
