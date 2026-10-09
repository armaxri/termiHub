---
id: TFE2-002
title: "Coverage ratchet has been dead since #4119: coverage.yml is not on the default branch, so its nightly schedule never fires"
angle: test-frontend
severity: medium
category: tooling
is_workaround: false
subsystem: ".github/workflows/coverage.yml"
evidence:
  - .github/workflows/coverage.yml:17-36
  - .github/workflows/coverage.yml:56-75
  - scripts/coverage-baseline.json:4-9
status: fixed
resolution: "#4277 — develop pushes dispatch coverage.yml when its newest develop run is older than 28 h; the heartbeat fails past 36 h"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

\#4119 (67bc2653b, 2026-10-06) removed the `push: develop` trigger from coverage.yml. It now relies on a `schedule` trigger plus a `nightly-dispatch` job that runs `gh workflow run coverage.yml --ref develop`. GitHub only runs `schedule` from the default branch's copy of the workflow, and the default branch is `main`. Listing `.github/workflows` on main via the contents API shows no coverage.yml (or integration-coverage-nightly.yml). The Actions API returns `total_count: 0` coverage.yml runs created since 2026-10-06; the last run was a develop push on 2026-10-05. So the blocking unit-coverage ratchet against scripts/coverage-baseline.json (frontend 86.76 and the other components) has not graded develop for 4 days and won't until main is synced.

## Why it matters

The workflow header says this ratchet is the forcing function that reds develop on a coverage drop. Since #4119 it silently grades nothing. Per-PR vitest floors still gate the frontend, but the cross-component ratchet and the integration overlay (and their release-summary use) are offline, and nothing alerts on that.

## Evidence

- `.github/workflows/coverage.yml:17-36`
- `.github/workflows/coverage.yml:56-75`
- `scripts/coverage-baseline.json:4-9`

## Recommendation

Do one of these: (a) land coverage.yml (and integration-coverage-nightly.yml) on main so the cron exists on the default branch; (b) trigger the nightly from a workflow already on main (e.g. code-quality.yml or system-integration.yml) via `gh workflow run coverage.yml --ref develop`; or (c) restore a cheap `push: develop` path-filtered trigger until main catches up. Also add a staleness check that fails when the newest develop coverage run is older than ~36h.

## Verification

Confirmed. coverage.yml now triggers only on push to main, schedule and workflow_dispatch, and schedule runs only from the default branch, which the API reports as `main`. The contents API for main lists no coverage.yml or integration-coverage-nightly.yml. The Actions API shows the newest coverage.yml run is a develop push at 2026-10-05T23:15Z, with nothing since, so the blocking ratchet has stopped grading develop. plugin-sandbox-nightly.yml spells out the same caveat about the default branch, but coverage.yml's header assumes the nightly works. Medium is right: a gate is silently offline, while the per-PR vitest floors still gate the frontend.
