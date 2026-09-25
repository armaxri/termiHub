---
id: TOOL-005
title: Integration/system coverage is dark per-PR and uninstrumented even nightly
angle: tooling-coverage
severity: medium
category: tooling
is_workaround: true
subsystem: ci / integration-tests
evidence:
  - .github/workflows/code-quality.yml:263
  - docs/testing.md:331
  - docs/testing.md:359
status: open
---

## What

The Docker-backed integration tests and the Python bridge system-test harness do
**not** run on the per-PR lane (the PR lane runs `-m "not integration"` and the
"machinery" suite against a FakeApp). They run only nightly, and even there they are
**not instrumented for coverage** — so the substantial share of behavior only
exercised through integration (SSH/telnet/serial/SFTP backends, agent reconnect, app
boot) contributes **zero** to any coverage number. The per-PR "coverage-gap report"
is `continue-on-error` (advisory), so a coverage gap never fails a build.

## Why it matters

This is the dark lane the coordinator's own record cites for shipping real bugs
"three times" (stale testids, undismissable dialog, a Windows bug) precisely because
green per-PR CI proves nothing there. For coverage specifically it means the unified
number (TOOL-001) will *under*-report real coverage (integration-only paths look
uncovered) unless the integration lane is instrumented and merged in. The advisory
`continue-on-error` gap report is a stopgap that surfaces gaps without ever gating.

## Evidence

- `.github/workflows/code-quality.yml:263` — the test-inventory / coverage-gap report
  step is `continue-on-error: true` (advisory only).
- `docs/testing.md:331` — "Because the per-PR lane … it only runs nightly" — explicit
  acknowledgement that integration coverage is dark per-PR.
- `docs/testing.md:359` — the app-boot smoke coverage added to the merge gate is a
  deliberate partial substitute for the nightly lane.

## Recommendation

- Instrument the **nightly integration lane** with `cargo-llvm-cov` (Rust) and, where
  feasible, collect frontend coverage from the harness runs; merge both into the
  unified lcov (TOOL-001) so integration-only paths stop reading as uncovered.
- Promote the coverage-gap report from advisory to **blocking on the release gate**
  (keep it advisory per-PR): a feature area with zero automated *and* manual coverage
  should block a release, not just print to the step summary. This removes the
  `is_workaround` `continue-on-error` posture at the point it matters most.
