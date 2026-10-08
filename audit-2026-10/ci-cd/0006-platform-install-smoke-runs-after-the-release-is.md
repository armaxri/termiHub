---
id: CI2-006
title: "Platform install smoke runs after the release is published and marked latest, so it cannot gate users"
angle: ci-cd
severity: medium
category: packaging
is_workaround: false
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:1309
  - .github/workflows/release.yml:1311
  - .github/workflows/release.yml:1329
  - .github/workflows/release-linux-smoke.yml:37
  - .github/workflows/release-windows-smoke.yml:44
  - .github/workflows/release-macos-smoke.yml:53
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`mark-latest` needs only [create-release, verify-release] and runs `gh release edit --latest` inside the Release run. The five install smokes (Linux x64/arm64, macOS, Windows x64/arm64) are separate `workflow_run: [Release] completed` workflows. They start only after Release has finished, including mark-latest, and nothing in them demotes or retracts the release on failure.

## Why it matters

With TERMIHUB_STABLE_RELEASE=true, which is the planned stable path, a release whose installer does not install or launch on a platform is already GitHub's 'Latest'. The desktop update check and the agent self-updater follow releases/latest, so they pick it up before any smoke result exists. The 'enforcing' smoke is post-hoc. (Prereleases are unaffected while the beta stays prerelease-only.)

## Recommendation

Make the smokes reusable (`workflow_call`) and call them from release.yml as jobs that mark-latest `needs:`, or move mark-latest into a final workflow that runs only when all smoke workflows for the tag concluded success. Alternatively, have each smoke on failure run `gh release edit --prerelease` / restore the previous latest.

## Verification

Confirmed. mark-latest needs only [create-release, verify-release] (release.yml:1311). The smokes are separate workflow_run:[Release] workflows, and none of them demotes or retracts the release. That makes them post-hoc for a stable release. Today's impact is reduced: releases are prerelease-only in the beta, mark-latest skips prereleases, and the smoke workflows are not on main yet either, so they could not run anyway. It is still a real gating-design flaw for the planned stable path.
