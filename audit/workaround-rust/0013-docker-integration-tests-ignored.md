---
id: WA-RS-013
title: Docker/Podman runtime-resolution tests are #[ignore]'d and never run in CI
angle: workaround-rust
severity: low
category: test-gap
is_workaround: true
subsystem: core/backends/docker
evidence:
  - core/src/backends/docker/mod.rs:1446
  - core/src/backends/docker/mod.rs:1513
status: open
---

## What
Two tests covering Docker-context / Podman-machine socket resolution are marked
`#[ignore]` because they need a live host:

- `connect_to_runtime_honours_docker_context` — "requires a live Docker+Podman
  host with docker.sock -> Podman"
- `connect_to_runtime_reaches_macos_podman_machine` — "requires a macOS host with
  a running Podman machine"

## Why it matters
The socket/runtime-resolution logic (which runtime a connection actually reaches)
has **no automated coverage in CI** — it only runs if a developer manually
un-ignores and provides the environment. Runtime-resolution bugs (wrong socket,
Podman vs Docker) would ship undetected. These are legitimately env-gated, not a
hidden quarantine, but the coverage gap is real.

## Recommendation
Add a CI lane (or the existing Docker system-test lane) that provisions a
Docker+Podman environment and runs these with `--ignored`, or refactor the
socket-resolution decision into a pure function that takes the discovered
environment as input so the decision logic is unit-testable without a live host.
