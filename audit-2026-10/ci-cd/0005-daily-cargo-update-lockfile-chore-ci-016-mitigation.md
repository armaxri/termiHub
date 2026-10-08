---
id: CI2-005
title: "Daily cargo-update lockfile chore (CI-016 mitigation) has never run"
angle: ci-cd
severity: medium
category: supply-chain
is_workaround: false
subsystem: .github/workflows/cargo-update-lockfile.yml
evidence:
  - .github/workflows/cargo-update-lockfile.yml:39
  - .github/workflows/cargo-update-lockfile.yml:40
  - .github/workflows/cargo-update-lockfile.yml:210
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: CI-016
---

## What

CI-016 was resolved by '#3291 daily cargo-update chore with auto-merge'. The workflow is not on the default branch: `gh run list --workflow cargo-update-lockfile.yml` returns HTTP 404, and no 'chore(deps): update cargo lockfile' PR has ever been opened. Neither the 04:00 cron nor workflow_dispatch can start it.

## Why it matters

The proactive lockfile refresh, and its pre-PR cargo-deny gate, is the mitigation that keeps yanked-crate and advisory storms from reddening develop and every PR. In practice there is none: yanks and advisories again surface only reactively, through develop's Security Audit push runs.

## Recommendation

Land cargo-update-lockfile.yml on main, or dispatch it from a main-resident scheduler (see the scheduled-lanes finding). After that, confirm the first run opens a PR, and confirm repo auto-merge is enabled as the workflow notes.

## Verification

Confirmed. The file is absent on main (contents API 404), and `gh run list --workflow cargo-update-lockfile.yml` returns 'not found on the default branch'. The schedule and dispatch-only triggers (lines 34-40) cannot start it, so the CI-016 mitigation is inert.
