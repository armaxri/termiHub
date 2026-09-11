---
id: CI-002
title: "--reruns 4 masks real regressions on the sole reconnect/integration grade"
angle: ci-cd
severity: critical
category: workaround
is_workaround: true
subsystem: .github/workflows/system-integration.yml
evidence:
  - .github/workflows/system-integration.yml:288
  - .github/workflows/system-integration.yml:352
  - .github/workflows/system-integration.yml:503
  - .github/workflows/system-integration.yml:517
status: in-progress
resolution: "#2741"
---

## What
Every leg of the integration lane retries failing tests up to four times and only reds the lane if a
test fails *all* attempts:

- Bulk Linux: `--reruns 4 --reruns-delay 1` (`system-integration.yml:288`)
- Bulk macOS/Windows (xdist): `--reruns 4 --reruns-delay 1` (`:352`)
- Display-critical grades Linux: `--reruns 4` (`:503`)
- Display-critical grades macOS/Windows: `--reruns 4` (`:517`)

The display-critical grades include `test_agent_reconnect_ui` — the *only* automated grade of the
safety-critical agent-reconnect path — and `test_layout_scrollback_ui`. On top of the retries,
`TERMIHUB_WAIT_SCALE=2` (`:343`, `:513`) doubles every readiness/command budget.

## Why it matters
`--reruns` re-runs only tests that failed, so a *deterministic* regression still fails — but an
**intermittent** real bug (a race, a timing-dependent reconnect failure, a resource leak that only
manifests under load) passes on retry and never reds the lane. On a ventilator-grade app this is the
worst masking to have on the reconnect grade specifically: the failure mode the feature exists to
prevent is exactly the intermittent one. The repo's own operating memory says "quarantine-not-retry
is the better pattern" and "un-quarantine needs >>3 green runs" — yet the fix applied here is
lane-wide blanket retry, the opposite pattern, on the one lane that grades reconnect. Combined with
CI-001 (this lane is not even per-PR), the reconnect path has no gate that fails on an intermittent
regression.

## Evidence
The four `--reruns 4` occurrences above; the comment at `:280-286` justifies them as absorbing
"residual hosted-CI environmental flakiness". `-r aR` keeps RERUN lines visible, so persistent
flakes are *tracked*, but a passing-on-rerun failure does not fail the run.

## Recommendation
Do not blanket-retry the reconnect/UI grades. Run `test_agent_reconnect_ui` and
`test_layout_scrollback_ui` with **zero reruns** and fail on first failure; if they flake, quarantine
the specific test and file a deterministic-fix tracker (the pattern the repo already endorses).
Reserve `--reruns` for genuinely environment-bound suites and cap it lower (1–2). Emit a
per-test flake ledger from the `-r aR` output so a "passed on rerun" is surfaced as a warning that a
human reviews, not silently swallowed.
