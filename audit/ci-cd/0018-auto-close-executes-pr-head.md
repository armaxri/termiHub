---
id: CI-018
title: auto-close executes a PR-head script with issues:write
angle: ci-cd
severity: low
category: security
is_workaround: false
subsystem: .github/workflows/auto-close-issues.yml
evidence:
  - .github/workflows/auto-close-issues.yml:9
  - .github/workflows/auto-close-issues.yml:24
  - .github/workflows/auto-close-issues.yml:35
status: open
---

## What
`auto-close-issues.yml` triggers on `pull_request: [closed]` with `permissions: issues: write`
(`:12-14`), checks out the repository (`actions/checkout@v4`, default ref, `:24-25`), and runs
`node scripts/internal/parse-issue-refs.mjs` (`:35`) — a script from the checked-out tree — to decide
which issues to close. The PR title/body are passed via environment variables (`PR_TITLE`, `PR_BODY`)
and consumed by the Node script, not interpolated into the shell, so classic shell-injection is
avoided (good). The residual concern is that the *script itself* comes from the merged PR's code.

## Why it matters
The job only fires on `merged == true` PRs into develop, so the code has been merged (typically after
maintainer review), which bounds the risk. But the pattern — run a repo-provided script from a PR's
own tree in a job that holds `issues: write` — means a merged malicious change to `parse-issue-refs.mjs`
(or anything it imports) executes with the issues-write token. Blast radius is limited to
issue manipulation (closing/commenting), and it is a first-party (not fork) merge path, hence low.

## Evidence
`:9` `pull_request` (not `pull_request_target`, so fork PRs get a read-only token — correct); `:24`
checkout of the merged code; `:35` executes it with the elevated token. `@v4` checkout is also an
older pin than the `@v6` used elsewhere (CI-003).

## Recommendation
Pin the script to the base branch rather than the PR head (e.g. `actions/checkout` with
`ref: ${{ github.event.pull_request.base.ref }}` or `sparse-checkout` of the trusted script from the
default branch), so the closing logic always comes from reviewed base-branch code. Keep the
env-var-not-interpolation discipline. Minor: bump the checkout pin to match the rest and SHA-pin it.
