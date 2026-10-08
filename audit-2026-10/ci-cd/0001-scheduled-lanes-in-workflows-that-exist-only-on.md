---
id: CI2-001
title: "Scheduled lanes in workflows that exist only on develop never fire (nightly/daily/weekly gates are dark)"
angle: ci-cd
severity: medium
category: reliability
is_workaround: false
subsystem: .github/workflows
evidence:
  - .github/workflows/security-audit.yml:49
  - .github/workflows/cargo-update-lockfile.yml:39
  - .github/workflows/coverage.yml:36
  - .github/workflows/integration-coverage-nightly.yml:18
  - .github/workflows/branch-protection.yml:20
  - .github/workflows/plugin-sandbox-nightly.yml:27
  - .github/workflows/wsl-live.yml:27
  - .github/workflows/windows-ssh-host.yml:33
  - .github/workflows/vendored-forks.yml:42
  - .github/workflows/system-integration.yml:125
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

GitHub fires `schedule:` (and `workflow_dispatch`, and `workflow_run`) only from the workflow file on the default branch, which is `main`. main's last commit is 2026-09-29, develop is 4782 commits ahead, and main has only 11 workflow files. As a result, `gh run list --event schedule` shows zero scheduled runs ever for security-audit, coverage, plugin-sandbox-nightly, wsl-live, windows-ssh-host and vendored-forks. For cargo-update-lockfile, integration-coverage-nightly, branch-protection and plugin-lpac-per-machine the API returns 404 ('workflow not found on the default branch'). The two nightlies that do fire (system-integration, integration-fixtures) run main's stale copy against develop's tree. For example, main's system-integration.yml still has `timeout-minutes: 120`, while develop raised it to 180 (#4017) because the Linux leg took 116 of 120 min. It also lacks the #3657/#4004/#4083/#4092 changes.

## Why it matters

Several documented gates and safety nets depend on these schedules: the daily RUSTSEC/yank audit of develop and main, the coverage ratchet (CI-011 since #4119), the daily lockfile refresh (CI-016), the branch-protection drift check (CI-017), plugin IPC fuzzing and the sandbox perf gate (#4190), and the live WSL and Windows SSH host lanes. Every one of them is silently off, while the docs and comments claim they run. The workflow comments show the authors knew schedules fire from main (coverage.yml:19-21) but missed that the files are not on main yet.

## Recommendation

Either (a) sync the CI plumbing to main now by fast-forwarding or cherry-picking the .github/workflows + .github/actions + scripts/internal CI helpers onto main, or (b) commit one small 'scheduler' workflow to main that `gh workflow run <file> --ref develop` dispatches each develop-only workflow on its cron. That is the pattern integration-coverage-nightly.yml already uses, and it needs that dispatcher itself on main. Add a guard as well: a per-PR or weekly check that every workflow with `schedule:` or `workflow_run:` on develop exists on the default branch (`gh api repos/:r/contents/.github/workflows?ref=main`), and fail or annotate when one does not.

## Verification

I could not refute it; the core claim checks out against live data. The default branch is `main`, and main has only the 11 workflow files the finding lists. `gh run list --event schedule` returns no scheduled runs at all for security-audit, coverage, plugin-sandbox-nightly, wsl-live, windows-ssh-host or vendored-forks. For cargo-update-lockfile.yml the API returns HTTP 404 "not found on the default branch".

system-integration does fire nightly, but from main's copy (headBranch=main), and that copy still has `timeout-minutes: 120` at line 142. The finding's stale-copy claim is therefore confirmed.

The dispatcher pattern does not save it either. integration-coverage-nightly.yml:36 runs `gh workflow run integration-fixtures.yml --ref develop` and coverage.yml:71 runs `gh workflow run coverage.yml --ref develop`. Both live in workflows that are themselves missing from main, so neither ever runs.

Nothing I found records this as a deliberate decision: there is no matching text in audit/FINAL-SUMMARY.md or docs/architecture.md, and no open issue about it.

I rate it medium rather than high because other triggers still cover part of the gap:

- security-audit runs on every push to develop (and on PRs touching dependencies), so advisories are still checked often, just not daily on a quiet tree.
- vendored-forks runs on push and PR path filters.
- wsl-live and windows-ssh-host run on PR path filters.

The lanes that are fully dark are:

- the lockfile refresh
- the branch-protection drift check
- the develop coverage ratchet
- integration-coverage-nightly
- plugin IPC fuzzing and the sandbox perf gate

That is a real loss of the safety nets the docs describe. It is a silent-degradation problem for a pre-release project, not an active defect in what ships, and syncing CI to main would fix it.
