---
id: WA-CI-024
title: integration-fixtures PR trigger is path-filtered, so most PRs never run it
angle: workaround-ci-scripts
severity: low
category: test-gap
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/integration-fixtures.yml:25
status: open
---

## What
`integration-fixtures.yml` only runs on a PR when it changes `tests/docker/**`, `core/tests/**`,
`core/src/backends/**`, or the workflow file itself (paths filter lines 25-31). Otherwise it
runs nightly/manual only. This is the lane that actually exercises the `require_docker!`-gated
integration tests (which self-skip everywhere else — see WA-CI-004).

## Why it matters
A PR that changes integration behavior *indirectly* (e.g. `src-tauri`, agent, session
plumbing, config that feeds the backends) gets no fixtures-lane feedback and relies on the
nightly run catching regressions after merge. It narrows the already-dark integration coverage
(WA-CI-004) further on the per-PR gate.

## Evidence
`pull_request: paths:` filter (integration-fixtures.yml lines 24-31).

## Recommendation
Accept for speed on develop, but ensure the nightly fixtures run is watched (it is per-branch,
per the branch-model memory) and gate the **release** branch on a full fixtures run regardless
of paths. Consider widening the path filter to include the session/agent plumbing that feeds the
backends. Low.
