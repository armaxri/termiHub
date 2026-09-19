---
id: WA-CI-021
title: vitest testTimeout inflated to 15s to absorb Windows-runner setup starvation
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: vitest.config.ts
evidence:
  - vitest.config.ts
status: open
---

## What
`vitest.config.ts` raises `testTimeout` from the 5000ms default to 15000ms because the Windows
CI job "has been seen spending 240s+ just on environment setup," starving otherwise-instant
component tests into timing out (#1025).

## Why it matters
A 3× global timeout is a mask for runner oversubscription (same family as WA-CI-006/021 and the
#2639 macOS-lane timeout work): it absorbs the jitter but also lets a genuinely slow/hung test
run 3× longer before failing, delaying the real signal. The comment acknowledges the root cause
is Windows environment-setup starvation, which the timeout does not fix.

## Evidence
`testTimeout: 15000` with the #1025 rationale comment in `vitest.config.ts`.

## Recommendation
Keep as headroom, but track the root cause (Windows runner setup taking 240s+ is itself a
problem — cold pnpm/node setup, cache misses). If the setup time is fixed (WA-CI-007 pnpm
retries, node cache), lower the timeout back toward the default so real hangs surface faster.
Low.
