---
id: CI-017
title: Required checks and branch protection live outside the repo and are unverifiable from source
angle: ci-cd
severity: high
category: reliability
is_workaround: false
subsystem: .github
evidence:
  - .github/workflows/code-quality.yml:4
  - .github/workflows/auto-close-issues.yml:21
status: open
---

## What
Which of the workflow jobs are actually **required** to merge — and whether `develop`/`main` are
protected, require passing checks, require review, or forbid direct pushes — is GitHub
branch-protection/ruleset configuration, **not** stored in the repo. The audit context notes
main-branch protection is still being set up (#2644), and #2634/#2639 concern the Linux/shard legs'
required status. Nothing in `.github/` pins the required-check set, so from source alone it is
impossible to confirm any check gates a merge.

## Why it matters
Every gate quality in this audit is contingent on the branch-protection config: if the jobs are not
marked required (or protection is off), a PR can merge red, and all the careful per-PR checks become
advisory in practice. The CLAUDE.md workflow forbids direct pushes to develop/main and mandates PRs,
but that is a convention enforced by the humans/agents, not by a verifiable rule in-repo. A misconfig
(or a disabled ruleset) is invisible and silent — the exact failure mode that lets a regression
land. For a safety-critical release, the gating rule set should be reviewable and version-controlled.

## Evidence
No branch-protection/ruleset file in the repo; job names (`Rust Code Quality`, `Build on …`,
`Run Tests (…)`, `Security Audit`, `Lint Commit Messages`, etc.) are the strings a protection rule
would reference, but the mapping is external. #2644 (protect main) still open per audit context.

## Recommendation
Capture the intended required-check set and protection rules as code (a GitHub ruleset exported to
the repo, or a `gh api` script under `.github/` that asserts protection matches expectations, run in
CI). Complete #2644 and document the exact required checks for develop and main. Add a periodic job
that fails if branch protection drifts from the committed expectation, so a disabled/relaxed rule is
caught rather than assumed.
