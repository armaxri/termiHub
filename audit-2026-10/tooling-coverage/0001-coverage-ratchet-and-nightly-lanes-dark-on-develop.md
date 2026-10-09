---
id: TOOL2-001
title: "Coverage ratchet and every schedule-only nightly lane are switched off for develop because their workflow files are not on main"
angle: tooling-coverage
severity: medium
category: ci-gating
is_workaround: false
subsystem: "CI / coverage"
evidence:
  - ".github/workflows/coverage.yml:31-36"
  - ".github/workflows/coverage.yml:17-29"
  - ".github/workflows/integration-coverage-nightly.yml:14-19"
  - ".github/workflows/plugin-sandbox-nightly.yml:17-31"
  - ".github/workflows/cargo-update-lockfile.yml"
  - ".github/workflows/branch-protection.yml"
  - ".github/workflows/integration-fixtures.yml:1"
  - ".github/workflows/system-integration.yml:1"
  - "scripts/release-check.sh:368-372"
status: fixed
resolution: "#4277 — coverage, fixtures-coverage and plugin-sandbox lanes are dispatched on develop when stale; heartbeat fails past 36 h; misleading comments fixed"
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: TOOL-001
---

## What

\#4119 (commit 67bc2653b) removed `push: develop` from coverage.yml. The file now runs only on `push: main`, `schedule` and `workflow_dispatch`. GitHub runs scheduled workflows from the default branch's copy of the file. The default branch is main, and coverage.yml does not exist there. Main's last commit is 2026-09-29 and develop is about 4,780 commits ahead. Confirmed with read-only gh: `gh api contents/.github/workflows?ref=main` lists only agent-cleanup, agent-integration-windows-\*, agent, auto-close-issues, build, code-quality, dev-build, integration-fixtures, release and system-integration.

As a result:

1. The last coverage.yml run of any kind was 2026-10-05, so the blocking unified fail-on-decrease ratchet (the TOOL-001 flagship fix) has not graded develop since #4119 merged.
2. integration-coverage-nightly.yml has never run (`gh run list` returns 404, 'not found on the default branch'), and integration-fixtures has no workflow_dispatch runs on develop. So the TOOL-005 instrumented develop integration lcov that coverage.yml is supposed to merge has never been produced.
3. The plugin-sandbox-nightly fuzz and perf gate (#4190), cargo-update-lockfile.yml and the weekly branch-protection drift check (branch-protection.yml) are dark for the same reason. plugin-sandbox-nightly says so in its own NOTE comment; the others are silent about it.

The comments in coverage.yml ('develop — once a night') and release-check.sh:371 ('the same ratchet coverage.yml enforces on develop/main') now describe a gate that does not run.

## Why it matters

Under a ventilator-grade, full-coverage-before-release bar, the only automated whole-app coverage gate is silently off on the branch where all work lands. A coverage drop or a dead fuzz/perf regression in the plugin sandbox (a security boundary) can now build up for weeks. It would only surface at release time, either on the first push to main or when release-check.sh is run by hand, and by then it is spread across thousands of commits. Nothing alerts on a missing nightly: the absence of runs looks the same as green.

## Evidence

- `.github/workflows/coverage.yml:31-36`
- `.github/workflows/coverage.yml:17-29`
- `.github/workflows/integration-coverage-nightly.yml:14-19`
- `.github/workflows/plugin-sandbox-nightly.yml:17-31`
- `.github/workflows/cargo-update-lockfile.yml`
- `.github/workflows/branch-protection.yml`
- `.github/workflows/integration-fixtures.yml:1`
- `.github/workflows/system-integration.yml:1`
- `scripts/release-check.sh:368-372`

## Recommendation

Short term: restore `push: branches: [develop]` on coverage.yml, perhaps gated by the ci-changes classifier or concurrency-cancelled per #4119's volume goal. Alternatively, add the nightly triggers as a trampoline job in a workflow that already exists on main (e.g. a `schedule` job in code-quality.yml or system-integration.yml that runs `gh workflow run coverage.yml|integration-fixtures.yml|plugin-sandbox-nightly.yml --ref develop`).

Durable: add a 'nightly heartbeat' check, either a step in the main-resident system-integration nightly or a small script, that fails when the newest successful coverage.yml, integration-fixtures develop dispatch or plugin-sandbox-nightly run is older than ~36h. Also fix the misleading comments in coverage.yml and release-check.sh until the files reach main.

## Verification

I could not refute this; every claim checked out. coverage.yml (lines 31-36) now triggers only on push to main, a schedule and workflow_dispatch. Its header comment says the scheduled run "just dispatches this workflow on develop", but a schedule only fires from the default branch's copy of the file. The default branch is main, and coverage.yml is not on main. A read-only gh listing of main's workflows shows only agent-cleanup, agent-integration-windows-grade, agent-integration-windows-serial-grade, agent, auto-close-issues, build, code-quality, dev-build, integration-fixtures, release and system-integration. main's last commit is 2026-09-29. The newest coverage.yml run is a develop push on 2026-10-05T23:15, and there are zero runs of any kind since #4119. For integration-coverage-nightly.yml, cargo-update-lockfile.yml and branch-protection.yml, `gh run list` returns HTTP 404 "not found on the default branch", so they have never run. integration-fixtures has no develop workflow_dispatch runs (the last dispatches are dev8 branches on 2026-09-27), so the TOOL-005 develop integration lcov is never produced. plugin-sandbox-nightly has only push runs on dev2 ci-probe branches and no dispatch or schedule runs, as its own NOTE comment admits. main's copy of system-integration.yml does not dispatch the dev-only workflows. The comments in coverage.yml and release-check.sh:371 that describe a develop ratchet are therefore inaccurate. I found no ADR or decision that accepts this. The #4119 decision was to move coverage to a nightly run, not to switch it off, so this is an unintended regression.

Severity lowered from high to medium: no product behaviour is affected; the same ratchet still blocks at release time through release-check.sh (which hard-fails if cargo-llvm-cov is missing) and the main-push coverage run; the per-PR vitest coverage floors (#2066) still gate frontend PRs. The real harm is late detection: the whole-app/Rust ratchet, the plugin-sandbox fuzz/perf gate, lockfile advisory refresh and branch-protection drift checks are silently dark on develop, and a missing nightly looks the same as a green one. The fix is cheap: put the files on main or add a trampoline job, plus a heartbeat check.
