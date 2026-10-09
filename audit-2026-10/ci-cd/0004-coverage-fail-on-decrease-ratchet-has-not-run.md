---
id: CI2-004
title: "Coverage fail-on-decrease ratchet has not run since #4119 (schedule-only trigger never fires)"
angle: ci-cd
severity: medium
category: test-gap
is_workaround: false
subsystem: .github/workflows/coverage.yml
evidence:
  - .github/workflows/coverage.yml:17
  - .github/workflows/coverage.yml:33
  - .github/workflows/coverage.yml:36
status: fixed
resolution: "#4277 — the ratchet is dispatched on develop (push catch-up now, scheduled-dispatch.yml cron once on main); heartbeat alarm past 36 h"
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: CI-011
---

## What

\#4119 removed the develop push trigger from coverage.yml. Develop is now meant to be graded by the 07:23 schedule, whose `nightly-dispatch` job dispatches the workflow on develop. coverage.yml does not exist on main, so the schedule never fires. The last Coverage run of any kind was a develop push on 2026-10-05T23:15Z, so the blocking per-component ratchet against scripts/coverage-baseline.json has graded nothing since. The `push: main` trigger only fires on a release merge.

## Why it matters

CI-011 was closed as fixed by making this ratchet blocking. Right now no lane runs it, so coverage drops land unnoticed and the next run (whenever main gets the file) will report a multi-day batch of regressions with no attribution. The release coverage summary also reads this workflow's run on the release sha.

## Recommendation

Until coverage.yml is on main, restore a develop trigger (for example `push: branches: [develop]` with a `coverage-push-develop` cancel-in-progress group, which keeps #4119's volume cut), or have a main-resident dispatcher trigger it nightly. Add an alarm that fails when the newest Coverage run on develop is older than 36 h.

## Verification

Confirmed. coverage.yml only triggers on push:main, schedule and workflow_dispatch. A GitHub API check shows coverage.yml is absent on main (404), so the schedule and its nightly-dispatch job never fire. The newest Coverage run is the develop push at 2026-10-05T23:15Z, from before #4119. The blocking ratchet currently grades nothing.
