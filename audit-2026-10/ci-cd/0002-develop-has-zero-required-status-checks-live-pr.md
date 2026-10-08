---
id: CI2-002
title: "develop has zero required status checks live; PR Gate is required nowhere and the drift check cannot run"
angle: ci-cd
severity: medium
category: reliability
is_workaround: false
subsystem: .github
evidence:
  - .github/branch-protection.json:98
  - .github/branch-protection.json:99
  - .github/workflows/code-quality.yml:1474
  - .github/workflows/branch-protection.yml:20
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: CI-017
---

## What

CI-017 was closed by committing protection-as-code, but the develop entry is still `status: proposed`. Live `GET /branches/develop/protection` returns no `required_status_checks` at all (only force-push and deletion are disallowed, and enforce_admins is false). The `PR Gate` aggregate (#3678) exists but is required on no branch. main's live set still names checks the slim lane no longer reports (Build on macos/windows, Run Tests (macos-latest), Security Audit). The weekly drift workflow that would surface this is not on the default branch (API 404), so it has never run.

## Why it matters

Every PR into develop, where all integration happens, can merge with red or still-pending CI. Branch protection does not enforce the whole per-PR gate design (changed-area jobs, the fail-closed PR Gate, Agent Live Tests); only the coordinator's manual check-watching does. The committed file gives an impression of enforcement that the live repo does not have.

## Recommendation

Apply the proposed develop protection (`scripts/internal/apply-branch-protection.sh --branch develop --apply`), flip its status to `enforced`, and get branch-protection.yml onto main (or dispatch it from a main-resident scheduler) so drift is actually checked. Consider making develop's required set just `PR Gate` plus `Lint Commit Messages`, so the gate's needs-list is the single source of truth.

## Verification

I checked every claim against the code and the live GitHub API, and all of them hold. (1) .github/branch-protection.json marks develop as "status": "proposed", with the note "maintainer applies with scripts/internal/apply-branch-protection.sh --branch develop --apply". (2) The live GET /branches/develop/protection response has no required_status_checks and no required_pull_request_reviews. Only force pushes and deletions are blocked, and enforce_admins is false. The repo's only ruleset ("Repo Protection") has enforcement "disabled", and GET /rules/branches/develop returns []. (3) main's live required contexts are still the old 10-name set (Security Audit, Run Tests (macos/windows-latest), Build on macos/windows). None of them is PR Gate, so PR Gate is required on no branch. (4) GET contents/.github/workflows/branch-protection.yml?ref=main returns 404, and main is the default branch. Scheduled workflows only run from the default branch, so the weekly drift check has never run. Its own comment ("A scheduled run starts on the default branch (main)") assumes the file is on main. I found no hidden guard. Nothing in the repo forces develop PRs to be green, so only the coordinator's manual check-watching does. Two things lower the severity. First, docs/contributing.md ("Required checks per branch") states openly that develop is "proposed — the maintainer applies it" and that main's new set is "pending (#3677) — applied when the next release PR into main is opened". So this is a known, documented admin action not yet taken, not a hidden code defect, and it is not a full false sense of enforcement. Second, the drift workflow will reach main with the next release merge. It is a real gap: the remediation for CI-017 is incomplete in the live repo, and this matters on a project held to a 'ventilator-grade' safety bar. But it is a one-command fix that needs an admin, with no direct product impact, so I rate it medium, not high.
