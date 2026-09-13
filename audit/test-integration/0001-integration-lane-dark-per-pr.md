---
id: TIN-001
title: Whole integration/E2E lane is dark per-PR — real backends and app-launch suites never run on a PR
angle: test-integration
severity: high
category: test-gap
is_workaround: false
subsystem: .github/workflows, tests/system, core/tests, agent/tests
evidence:
  - .github/workflows/code-quality.yml:1152
  - .github/workflows/code-quality.yml:1107
  - .github/workflows/system-integration.yml:1
  - .github/workflows/integration-fixtures.yml:530
  - tests/system/conftest.py:319
status: open
---

## What

Nothing that launches the real app or touches a real backend runs on a pull
request. Per-PR CI runs only:

- `code-quality.yml` → **System-Test Harness (machinery)**: `pytest -m "not
  integration"` against a `FakeApp` — no app build, no Docker
  (`code-quality.yml:1152`).
- `code-quality.yml` → **Run Tests**: `cargo test --workspace --all-features`
  with **no containers up** (`code-quality.yml:1107`), so every
  `require_docker!`-gated test in `core/tests` (17 files) and every
  Docker-gated test in `agent/tests` self-skips.

The suites that actually exercise integration run only on a **nightly / manual**
cadence:

- ~66 of 91 Python suites are `@pytest.mark.integration` (launch the built app,
  drive it over the bridge, hit Docker SSH/telnet/serial/agent fixtures) — they
  run only in `system-integration.yml` (daily 05:05Z on develop, weekly on main).
- `core/tests` real-backend suites (SSH/SFTP/telnet/tunnel/VNC/FTP/monitoring)
  run only in `integration-fixtures.yml` (nightly + on PRs that touch
  `core/src/backends/**`, `core/tests/**`, or `tests/docker/**`).

So a PR that changes frontend state, a Tauri command, an appStore projection, a
testid, or the harness itself gets **green CI while every integration path stays
merely collected/compiled, never executed**. The workflow headers say this
plainly: "every one of these ~360 tests is otherwise merely *collected*, never
*run*. That dark lane is how stale-testid rot slipped in unnoticed (#1568): a
green PR proves the harness *collects*, not that it *works*"
(`system-integration.yml:6`).

## Why it matters

This is the structural cause of the app/harness drift that has shipped three
times (stale testids #1568, undismissable dialog #1654, a Windows bug #1587).
The per-PR gate cannot catch:

- a frontend change that renames/removes a `data-testid` a bridge verb selects on
  (the catalog is coverage-checked, not behavior-checked — see TIN-012);
- a Tauri-command or projection-intent signature change that breaks a bridge
  verb;
- a real-connect regression (SSH auth, SFTP transfer, tunnel, reconnect) in a
  backend the PR did not obviously touch;
- a harness/app protocol drift.

Detection latency is up to ~24h (develop nightly) and the fix then races the
next day's merges. For a "ventilator-grade" release the central end-to-end
safety net is off during the exact window (the PR) where regressions are
introduced.

## Evidence

- `code-quality.yml:1128-1152` — machinery-only lane, `-m "not integration"`,
  `FakeApp`, explicit "The `integration` group … runs in the dedicated
  system-test lanes, not on every PR."
- `code-quality.yml:1106-1107` — `cargo test --workspace --all-features` with no
  Docker step in the job.
- `integration-fixtures.yml:536-541` — "The regular 'Run Tests' job runs … with
  NO containers up, so every `require_docker!`-gated integration test in
  core/tests skips."
- `tests/system/conftest.py:189-207` — fixtures `pytest.skip(...)` when no
  container runtime is present, so absence reads as skip, not fail.

## Recommendation

The nightly cadence is a deliberate owner decision (#1569) and full parity
per-PR is likely too slow. But the split is drawn at "all or nothing," which is
too coarse. Options to shrink the dark window without slowing PRs materially:

- Run a **thin per-PR smoke of the bridge against the real app** (app-launch +
  a handful of no-Docker UI suites: CSP boot, terminal render, connection-editor,
  layout) so testid/protocol drift fails on the PR that causes it. The
  `display-grades` job already proves a two-suite app-launch subset finishes well
  inside budget.
- **Path-trigger the integration lane** the way `integration-fixtures.yml`
  already does for backend changes — extend it to fire on `src/**`,
  `src-tauri/src/commands/**`, `src/testbridge/**`, and `tests/system/**` so a
  PR that most likely breaks the harness gets integration feedback before merge.
- At minimum, make the nightly result **visibly gate develop** (a failing
  nightly should block new merges or page loudly), so drift can't accumulate for
  a week on main.
