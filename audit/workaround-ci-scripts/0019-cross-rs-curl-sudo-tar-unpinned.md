---
id: WA-CI-019
title: cross-rs installed via curl|sudo tar from "latest" (unpinned supply-chain fetch)
angle: workaround-ci-scripts
severity: medium
category: supply-chain
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/agent.yml:57
status: fixed
resolution: "#2753"
---

## What
`agent.yml` installs the cross-compiler by piping an unpinned "latest" release tarball straight
into `sudo tar` onto the runner PATH:
`curl -fsSL https://github.com/cross-rs/cross/releases/latest/download/cross-…tar.gz | sudo tar xz -C /usr/local/bin`
(line 57). No version pin, no checksum verification. The workflow also drops `CROSS_CONFIG` on
CI (using stock cross images from GHCR instead of the repo's custom localhost images) to avoid
a flaky Docker Buildx / Docker Hub pull (#2056).

## Why it matters
`curl | sudo tar` from `latest` is the canonical unpinned supply-chain pattern: a compromised or
broken cross release lands as root on the runner that builds the **shipped agent binaries**, and
"latest" makes builds non-reproducible (a new cross release can change behavior with no repo
change). This is the build path for release artifacts, so the trust boundary matters.

## Evidence
`curl … cross/releases/latest/download/… | sudo tar xz -C /usr/local/bin` (agent.yml lines 55-57).

## Recommendation
Pin cross-rs to a specific release tag and verify the tarball's published checksum before
extraction (or install via `cargo install cross --locked`/`taiki-e/install-action`, which the
repo already uses for cargo-audit/cargo-deny). Avoid `latest` for anything on the release build
path. Medium (supply-chain, release artifacts).
