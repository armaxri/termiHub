---
id: WA-CI-006
title: TERMIHUB_WAIT_SCALE=2 inflates every harness timeout to dodge CI slowness
angle: workaround-ci-scripts
severity: medium
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/system-integration.yml:344
  - .github/workflows/system-integration.yml:513
  - .github/workflows/system-integration.yml:333
status: open
---

## What
The integration lanes set `TERMIHUB_WAIT_SCALE: '2'`, which multiplies every harness
wait/command budget by 2× under CI (comment lines 333-344, #2690). Combined with `--reruns 4`
(WA-CI-005) this doubles the time a genuinely-hung path is tolerated before failing.

## Why it matters
Inflating every timeout is a blunt instrument: it hides real latency regressions (a connect
or command that got 1.8× slower still passes) and slows the failure signal for a truly wedged
test. It is a symptom of CI-runner oversubscription rather than a fix for it.

## Evidence
`TERMIHUB_WAIT_SCALE: '2'` at lines 344 and 513; the multiply-every-budget comment at 333-344.

## Recommendation
Acceptable as headroom for shared-runner jitter, but scope it as narrowly as possible: prefer
targeted per-operation deadlines over a global 2× multiplier, and record the *actual* observed
wait times (the harness already emits `[termihub-test-timing]` lines) so the scale factor can
be lowered as the runner contention issues (#2639 shard/timeout) are addressed. Track alongside
WA-CI-005 as the same "absorb CI noise" cluster.
