---
id: TIN2-006
title: "The dispatch default 'both' uploads two same-named failure artifacts per OS, so the second upload fails"
angle: test-integration
severity: low
category: "ci-correctness"
is_workaround: false
subsystem: "system-integration.yml"
evidence:
  - .github/workflows/system-integration.yml:47
  - .github/workflows/system-integration.yml:529
  - .github/workflows/system-integration.yml:726
  - .github/workflows/system-integration.yml:511
  - tests/system/conftest.py:632
  - tests/system/termihub_harness/systemtest.py:86
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

A manual 'Run workflow' defaults to branch=both, which runs main and develop legs for each OS. Both legs upload with `name: system-integration-artifacts-${{ matrix.os }}` (line 529) or `display-grades-artifacts-${{ matrix.os }}` (line 726), and neither name includes matrix.branch. actions/upload-artifact v4 artifacts are immutable per run, so when both legs on one OS have failure bundles, the second upload fails with a 409 conflict. Failure bundles are written on every failed attempt, including attempts that later pass on rerun. The harness-coverage artifact (line 511) already includes the branch, which shows the intended pattern.

## Why it matters

The second leg's diagnostics (app log, store snapshot, hang tracebacks) are lost exactly when both branches fail. The `if: always()` upload step also errors, so a leg whose tests passed after reruns can still be marked failed. That muddies the 'is develop green?' signal in the manual runs used to validate harness changes.

## Evidence

- `.github/workflows/system-integration.yml:47`
- `.github/workflows/system-integration.yml:529`
- `.github/workflows/system-integration.yml:726`
- `.github/workflows/system-integration.yml:511`
- `tests/system/conftest.py:632`
- `tests/system/termihub_harness/systemtest.py:86`

## Recommendation

Include the branch in both names: `system-integration-artifacts-${{ matrix.os }}-${{ matrix.branch }}` and `display-grades-artifacts-${{ matrix.os }}-${{ matrix.branch }}`. For the release-candidate call the branch is a sha, so consider a short form.

## Verification

Confirmed. On workflow_dispatch the setup job defaults to branches=["main","develop"]. The matrix is branch x os, and both upload steps (v4.6.2, no overwrite flag) use names that contain only matrix.os: system-integration-artifacts-${{ matrix.os }} and display-grades-artifacts-${{ matrix.os }}. When both legs have files under tests/system/artifacts/, the second upload fails with a 409 and loses its diagnostics. The harness-coverage artifact does include matrix.branch. This hits manual runs only; scheduled runs grade a single branch.
