---
id: CI-013
title: Windows leg runs the whole workspace, so one flaky suite reds every unrelated PR
angle: ci-cd
severity: high
category: reliability
is_workaround: false
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:216
  - .github/workflows/agent.yml:108
status: open
---

## What
The per-PR `tests` matrix runs `cargo test --workspace --all-features` on `windows-latest`
(`code-quality.yml:216`), and `agent.yml`'s `build-windows` runs
`cargo test -p termihub-agent -p termihub-core --all-features` (`:108`). Because these are whole-
workspace/whole-crate runs, **any** flaky test anywhere in the workspace on Windows reds the Windows
leg of **every** PR, regardless of what the PR changed. This is the documented root of the #2495
quarantine (agent cold-start oversubscription) and the #2498 `local_shell` PTY flake — one flaky
suite contends on the runner's few cores and times out a random unrelated test.

## Why it matters
The repo's own memory records "the Windows leg runs the whole workspace, so one flaky suite reds
*every* PR's Windows leg; stabilizing it is high-leverage," and "CI flakes are the biggest non-code
time sink." A shared, contention-prone Windows leg turns every flake into a fleet-wide red, drives
the re-run-until-green culture, and pushes teams toward quarantining (CI-006) rather than fixing.
It also erodes trust in the gate: reviewers learn to ignore a red Windows leg, which is exactly when
a real Windows regression slips through.

## Evidence
`code-quality.yml:216` (workspace) and `agent.yml:107-108` (agent+core together, the specific
combination #2495 blames). `fail-fast: false` (`code-quality.yml:169`) prevents cross-*platform*
cancellation but does nothing for within-Windows contention.

## Recommendation
Reduce Windows contention structurally: cap test threads / serialize the known-heavy live-agent and
PTY suites on Windows (`--test-threads`), or split them into a dedicated Windows job with resource
headroom so they cannot starve unrelated tests. Fund the #2495/#2498 deterministic fixes as
high-leverage flake removal rather than continuing to quarantine. Track a per-suite flake rate so the
worst offenders are visible.
