---
id: TIN-002
title: Nightly integration lane retries every failure 4× and scales all waits 2× — masks flakes and real regressions
angle: test-integration
severity: high
category: workaround
is_workaround: true
subsystem: .github/workflows/system-integration.yml
evidence:
  - .github/workflows/system-integration.yml:289
  - .github/workflows/system-integration.yml:353
  - .github/workflows/system-integration.yml:503
  - .github/workflows/system-integration.yml:517
  - tests/system/pyproject.toml:20
status: in-progress
resolution: "#2741"
---

## What

The only lane that runs the real-app/real-backend integration suite retries
every failing test up to **four** times and multiplies every harness wait budget
by **two**, so a test that passes as rarely as **1 run in 5** still greens the
nightly.

- All four `pytest.sh -m integration` invocations pass `--reruns 4
  --reruns-delay 1` (`system-integration.yml:289, 353, 503, 517`).
- The macOS/Windows legs additionally set `TERMIHUB_WAIT_SCALE: '2'`
  (`:344-345, :514`), doubling every `SystemTest.wait()` / bridge command
  timeout.

The intent (per #2698) is to absorb "irreducible hosted-CI environmental
flakiness." But `--reruns` re-runs on **any** failure, not just a classified
environmental one, so a genuine intermittent regression — a race in reconnect, a
projection-ordering bug, a flaky transfer — is retried until it passes and the
lane stays green. This is the exact lane whose job is to *catch* app/harness
drift (TIN-001); a 4× retry blunts it.

## Why it matters

- **Detection is the lane's whole purpose.** Under a 4× retry the nightly can no
  longer distinguish "irreducibly flaky infra" from "intermittently broken code."
  A reconnect/transfer bug that reproduces 30% of the time will show green.
- **Flake debt is hidden, not paid down.** The repo's own operating memory says
  chronic flakes recur and "3 green proves nothing"; retry-until-green is the
  softer version of the same trap.
- **Comment/behaviour drift.** Every one of the four call sites is documented as
  `--reruns 2` in its preceding comment (`:278, :346, :495`) and pyproject says
  the retries are bounded, but the executed value is `4`. A reader auditing the
  masking budget is told half the real number.

## Evidence

- `system-integration.yml:289` — `... --reruns 4 --reruns-delay 1 -r aR`, with
  the comment three lines above (`:278`) reading "`--reruns 2 --reruns-delay 1`".
- Same 2-vs-4 mismatch at `:346`/`:353`, `:495`/`:503`, and `:517`.
- `:344` `TERMIHUB_WAIT_SCALE: '2'`; `systemtest.py:227` — "`timeout` is scaled by
  `TERMIHUB_WAIT_SCALE` so this one primitive … gets contention headroom."

## Recommendation

- **Cut the retry budget and reconcile the comments.** Bring the executed value
  back to the documented `2` (or lower), and — critically — surface RERUN counts
  as a tracked signal, not a silent pass. A test that only passes on rerun should
  file/So-update a flake tracker, per the repo's quarantine-not-whack-a-mole rule.
- **Prefer per-test quarantine over lane-wide retry.** Lane-wide `--reruns`
  applies the mask to *stable* tests too, so a newly-flaky (i.e. newly-broken)
  test is auto-absorbed. Quarantine the known-flaky few (already the pattern for
  #2495) and run the rest at `--reruns 0`, so a new failure reds the lane.
- Treat `TERMIHUB_WAIT_SCALE=2` as a stopgap for runner over-subscription
  (#2660/#2690); the real fix is right-sizing xdist workers so waits need no
  inflation, otherwise a genuine slow-hang regression gets 2× the rope.
