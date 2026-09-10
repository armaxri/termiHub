---
id: TBE-005
title: Docker/Podman runtime-detection tests are #[ignore] and run on no CI lane
angle: test-backend
severity: medium
category: workaround
is_workaround: true
subsystem: core/backends/docker
evidence:
  - core/src/backends/docker/mod.rs:1446
  - core/src/backends/docker/mod.rs:1513
status: open
---

## What
Two docker backend tests are hard `#[ignore]`d with live-host requirements:
`#[ignore = "requires a live Docker+Podman host with docker.sock -> Podman"]` (mod.rs:1446) and
`#[ignore = "requires a macOS host with a running Podman machine"]` (mod.rs:1513). These are the
only two `#[ignore]` attributes in the codebase (aside from the Windows `cfg_attr` quarantine).
Being `#[ignore]`, they run on **no** CI lane — not per-PR, not the nightly integration lane —
unless a human manually invokes `-- --ignored` on a correctly-provisioned host.

## Why it matters
Runtime auto-detection (docker.sock pointing at Podman; macOS Podman-machine) is exactly the kind
of environment-specific branch that silently rots — the code path has no automated guardian. For a
release that claims Docker + Podman parity, the detection logic ships effectively unverified.

## Evidence
- docker/mod.rs:1446, :1513 — the two `#[ignore = "requires ..."]` attributes.
- No workflow references these test names with `--ignored` (grep of `.github/workflows`).

## Recommendation
Either (a) provide a provisioned nightly lane (Podman-machine on a macOS runner, docker.sock→Podman
on Linux) that runs them via `--ignored`, or (b) refactor the detection logic to be unit-testable
against a faked filesystem/socket probe so the branch is covered without a live host. Track as a
coverage workaround until one of those exists.
