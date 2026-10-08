---
id: WA-CI2-001
title: "Scheduled CI lanes never run: their workflow files are not on the default branch (main)"
angle: workaround-ci-scripts
severity: medium
category: masked-gate
is_workaround: false
subsystem: ci/workflows
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - .github/workflows/security-audit.yml:46-49
  - .github/workflows/coverage.yml:31-36
  - .github/workflows/coverage.yml:71
  - .github/workflows/integration-coverage-nightly.yml:14-18
  - .github/workflows/integration-coverage-nightly.yml:36
  - .github/workflows/branch-protection.yml:17-20
  - .github/workflows/cargo-update-lockfile.yml:35
  - .github/workflows/plugin-sandbox-nightly.yml:25-27
  - .github/workflows/vendored-forks.yml:40-42
  - .github/workflows/windows-ssh-host.yml:31-33
  - .github/workflows/wsl-live.yml:25-27
status: open
resolution: ""
---

## What

GitHub fires `schedule:` only from the workflow file on the default branch. `gh workflow run <file>` also only works for a workflow registered from there. main (800bb9f99, 2026-09-29) carries just 11 of develop's 28 workflows. Every scheduled lane added or moved since then is missing from main: security-audit, coverage, integration-coverage-nightly, branch-protection, cargo-update-lockfile, plugin-sandbox-nightly, vendored-forks, windows-ssh-host and wsl-live. The live Actions API confirms it. All of these have zero `schedule` runs ever. cargo-update-lockfile, integration-coverage-nightly, branch-protection and release-candidate are not even registered (404 / missing from /actions/workflows). Coverage last ran on 2026-10-05, a develop push. #4119 (67bc2653b, 2026-10-06) then removed the develop push trigger and moved the ratchet to a nightly that dispatches itself from main. That nightly cannot fire, so the blocking unit-coverage ratchet (#3740) has run nowhere for 4 days. The integration-coverage-nightly.yml header was written to work around this exact default-branch rule (lines 3-6), but the file itself is not on main.

## Why it matters

Several safety nets the docs describe as live are silently off: (1) the daily RUSTSEC/yank scan, whose comment says a daily run surfaces advisories on develop and main without waiting for a merge; (2) the blocking coverage ratchet; (3) the weekly branch-protection drift check (CI-017's fix); (4) the nightly WSL-live, native Windows sshd, and plugin-sandbox IPC-fuzz and perf lanes, which otherwise run only on path-filtered PRs or not at all; (5) the daily lockfile refresh that pre-empts yanked crates. Nothing reports a schedule that never fires, so every lane looks green. The same structure will recur after each release whenever a scheduled workflow is added or changed on develop, because main's stale copy is what runs.

## Recommendation

Short term: land the develop→main release merge, or a workflows-only sync PR into main, so these files exist on the default branch. Then dispatch coverage.yml on develop once to re-grade the ratchet. Structurally: add a check to Code Quality on develop pushes (or the weekly drift job) that lists every workflow with `schedule:`, `workflow_run:` or a dispatcher role and fails or annotates when `git show origin/main:<path>` is missing or its `on:` block differs. Alternatively, move all cron triggers into one small dispatcher workflow on main that runs `gh workflow run <file> --ref develop`, so a new nightly only needs main to know the dispatcher. Note in docs/contributing.md that a new scheduled lane is dark until it reaches main.

## Verification

I checked this against the live repo and it holds. The default branch is main, at 800bb9f99 from 2026-09-29. Its .github/workflows has only 11 files, and none of these are among them: security-audit, coverage, integration-coverage-nightly, branch-protection, cargo-update-lockfile, plugin-sandbox-nightly, vendored-forks, windows-ssh-host or wsl-live. The Actions API shows zero `schedule` runs for every one of them. For example, coverage has push=100 and nothing else, security-audit has push and pull_request runs only, and wsl-live and windows-ssh-host have pull_request runs only. branch-protection, cargo-update-lockfile and integration-coverage-nightly are not registered at all.

coverage.yml on develop now triggers on push to main only, plus a schedule and workflow_dispatch. Its nightly-dispatch job depends on the schedule firing on main, which cannot happen until the file exists there. The last coverage run was 2026-10-05T23:15Z, a develop push, so the blocking ratchet has run nowhere since then.

I found no ADR, FINAL-SUMMARY or contributing.md decision that accepts this. The workflow headers assume the files will be on main, which shows the dependency was known but the release merge has not happened yet.

I'm lowering the severity from high to medium for three reasons. First, the nets are not all dark: security-audit still runs on every develop/main push and on PRs, so advisories surface on the next merge; the daily scan only adds coverage on quiet days. Second, vendored-forks, windows-ssh-host and wsl-live still run on their path-filtered PRs. Third, the structure is meant to work once develop is merged into main, and the project is pre-release, so the fix is a single sync. The real exposures are: the coverage ratchet has been ungraded for about 4 days, the branch-protection drift check and lockfile refresh do not run, and the gap will recur silently each time a scheduled lane changes on develop.
