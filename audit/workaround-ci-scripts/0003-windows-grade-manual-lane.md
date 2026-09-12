---
id: WA-CI-003
title: Manual Windows agent-integration grade lane exists solely to grade a quarantine
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/agent-integration-windows-grade.yml:40
  - .github/workflows/agent-integration-windows-grade.yml:98
status: open
---

## What
`agent-integration-windows-grade.yml` is a `workflow_dispatch`-only lane that loops the
quarantined subset (WA-CI-001) `runs` times on `windows-latest` in parallel mode with
`TERMIHUB_TEST_TIMING=1`, to observe whether the aggregate cold-start gate (#2528) closed the
flake. It exists only because the tests are quarantined and can no longer be seen in normal CI.

## Why it matters
Two separate grade lanes (this + WA-CI-002) exist purely as scaffolding around the #2495
quarantine. They are throwaway infrastructure that should not outlive the quarantine.

## Evidence
Header block lines 1-38; `on: workflow_dispatch` (line 40); the loop step (line 98).

## Recommendation
Delete (or fold into WA-CI-002) as part of closing #2495 once the Windows flake is genuinely
fixed and the tests are un-quarantined. Not release-blocking on its own; it is a symptom of
WA-CI-001.
