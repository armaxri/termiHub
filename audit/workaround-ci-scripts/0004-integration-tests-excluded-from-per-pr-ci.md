---
id: WA-CI-004
title: Integration tests excluded from per-PR CI — the integration lane is dark on PRs
angle: workaround-ci-scripts
severity: high
category: test-gap
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:261
  - .github/workflows/code-quality.yml:216
  - .github/workflows/integration-fixtures.yml:22
  - .github/workflows/system-integration.yml:6
status: open
---

## What
Per-PR CI deliberately does **not** run the app-level integration suites:
- The Python bridge harness runs `-m "not integration"` on PRs (`code-quality.yml:261`); the
  `integration` group (which launches the real desktop app) runs only in the dedicated
  nightly/scheduled `system-integration.yml` lanes.
- The Rust "Run Tests" job runs `cargo test --workspace --all-features` with **no Docker
  containers up** (`code-quality.yml:216`), so every `require_docker!`-gated integration test
  in `core/tests` self-skips.

So a PR can go green while its integration path is completely unexercised, unless it happens
to touch a path that triggers `integration-fixtures.yml` (which is itself path-filtered — see
WA-CI-024).

## Why it matters
This is the classic "dark lane": per the coordinator's own durable lessons, this exact gap
shipped drift/regressions silently three times (#1568, #1654, #1587). A green PR is not proof
the integration behavior works. On a safety-critical, pre-release app this is a real
release-readiness hole, not just a speed trade-off.

## Evidence
`./tests/system/pytest.sh -m "not integration" -q` (line 261); comment at
`system-integration.yml:6`; `require_docker!` self-skip note at `integration-fixtures.yml:22`.

## Recommendation
This is an intentional cost/speed trade-off (integration is slow + Docker-bound), so it is a
*justified* stopgap — but before release the integration lanes must be run green against the
release candidate. Options: (a) run the full integration + fixtures lanes as a required gate
on the release branch, (b) widen `integration-fixtures.yml`'s PR triggers, or (c) at minimum
document a mandatory pre-release "full integration green" checklist item. Track that the
release is not cut on per-PR green alone.
