---
id: WA-CI-023
title: A handful of core integration tests are #[ignore]d for fixture-content gaps (#864)
angle: workaround-ci-scripts
severity: medium
category: test-gap
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/integration-fixtures.yml:67
  - core/src/backends/docker/mod.rs:1446
  - core/src/backends/docker/mod.rs:1513
status: open
---

## What
The `integration-fixtures.yml` lane runs `core/tests` against live Docker fixtures with
`--test-threads=1`, and its comment notes "A handful of tests are `#[ignore]`d for pre-existing
fixture-content gaps tracked in #864; they will be re-enabled there." Separately, two Docker
backend tests carry hard `#[ignore]` for host-specific setups
(`docker/mod.rs:1446` requires a live Docker+Podman host with docker.sock→Podman; `:1513`
requires a macOS host with a running Podman machine).

## Why it matters
`#[ignore]`d integration tests are coverage holes hidden even in the fixtures lane that is
supposed to exercise them. The docker.sock→Podman and macOS-Podman-machine tests never run in
any automated lane, so that behavior is only ever manually verified.

## Evidence
`integration-fixtures.yml:67` (the #864 note); `#[ignore = "requires a live Docker+Podman host
with docker.sock -> Podman"]` (docker/mod.rs:1446); `#[ignore = "requires a macOS host with a
running Podman machine"]` (docker/mod.rs:1513).

## Recommendation
Fill the #864 fixture-content gaps and re-enable the ignored fixtures-lane tests. For the two
host-specific docker.sock/Podman-machine tests, either provision the required host in a
scheduled lane or convert them into a documented manual test in `docs/testing.md` so the
behavior is at least tracked. Medium.
