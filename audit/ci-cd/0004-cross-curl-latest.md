---
id: CI-004
title: "cross fetched via curl | tar from releases/latest builds shipped agent binaries"
angle: ci-cd
severity: high
category: supply-chain
is_workaround: false
subsystem: .github/workflows
evidence:
  - .github/workflows/release.yml:346
  - .github/workflows/dev-build.yml:298
  - .github/workflows/agent.yml:51
status: fixed
resolution: "#2753 — cross-rs pinned+checksummed"
---

## What
The Linux agent build jobs install `cross-rs` by piping an unauthenticated download of the
**`releases/latest`** tarball straight into `tar` as root:

```
curl -fsSL https://github.com/cross-rs/cross/releases/latest/download/cross-x86_64-unknown-linux-gnu.tar.gz \
  | sudo tar xz -C /usr/local/bin
```

This appears in `release.yml:346-348`, `dev-build.yml:298-300`, and `agent.yml:51-53`. In
`release.yml` the resulting `cross` binary then builds the `termihub-agent` musl binaries that are
**uploaded as public release assets** and installed by users' desktops on remote hosts.

## Why it matters
Three compounding problems: (1) no version pin — `latest` silently changes what runs, so the release
is not reproducible and a bad upstream release lands with no PR; (2) no integrity check — no checksum
or signature verification on the tarball, so a compromised/hijacked download executes as root and can
tamper with the agent binaries; (3) `curl | sudo tar` is the canonical unsafe install idiom. The
agent is remote-code-execution infrastructure (it runs on the user's servers), so a tampered agent
build is a high-severity supply-chain path.

## Evidence
The three occurrences above. Contrast the desktop/agent *artifacts* which do get a `.sha256` sidecar
(`release.yml:367`) — but the *tool that builds them* is fetched unverified.

## Recommendation
Pin `cross` to an exact version and verify it: download a fixed tag, fetch the published checksum,
`sha256sum -c` before extracting; or install via `cargo install cross --version x.y.z --locked`; or
use a SHA-pinned setup action. Do not extract as root into `/usr/local/bin` from an unverified pipe.
Apply the same to any other `curl | sh`/`curl | tar` install steps.
