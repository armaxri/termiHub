---
id: PKG-003
title: Auto-update integrity relies on a same-channel SHA-256 checksum, not a cryptographic signature (no authenticity guarantee)
angle: packaging-release
severity: high
category: supply-chain
is_workaround: false
subsystem: agent/src/update
evidence:
  - agent/src/update/download.rs:47
  - agent/src/update/checksum.rs:53
  - .github/workflows/release.yml:363
  - src-tauri/src/commands/update.rs:95
status: open
---

## What
There is no cryptographic signature anywhere in the update path — no Tauri updater
plugin, no minisign/cosign public key, no Authenticode/Developer-ID trust anchor used
for update verification.

- **Desktop app:** the "updater" (`src-tauri/src/commands/update.rs`) is *check-only*:
  it polls the GitHub releases API, compares semver, and surfaces release notes / a
  link. It never downloads or installs a new bundle. So the desktop has no auto-apply
  path (see PKG-013 for the posture note), and correspondingly no signature check.
- **Remote agent self-update** (`agent/src/update/`, off by default) does download and
  install a new binary. It verifies the download against a `.sha256` sidecar — but
  that sidecar is fetched from the **same GitHub release over the same channel** as
  the binary (`release.yml` publishes `<asset>` and `<asset>.sha256` side by side).

A same-origin checksum proves **integrity** (the download was not truncated/corrupted
in transit) but not **authenticity**: anyone able to publish or replace a GitHub
release asset — a leaked/over-scoped `GITHUB_TOKEN` or Actions secret, a compromised
maintainer account, a malicious repo collaborator, or a registry/CDN substitution
that also swaps the sidecar — can serve a trojaned agent binary with a matching
checksum, and the fail-closed check passes.

## Why it matters
The remote agent runs on the user's servers/Raspberry Pis with the user's privileges;
a poisoned self-update is a serious supply-chain compromise. The checksum design reads
as if it provides tamper protection, but against an adversary who controls the release
it provides none. This is the release-engineering half of the security-angle
AGT/SEC findings on unsigned updates.

## Evidence
- `agent/src/update/download.rs:47-72` — `download_and_verify` downloads the binary,
  then downloads the checksum from `urls.checksum_url` (same release) and compares.
- `agent/src/update/checksum.rs:53` — `verify_file_checksum` is a plain SHA-256 equality
  check; no signature.
- `release.yml:363-371` (and macOS/Windows agent jobs) — the runner computes
  `sha256sum` at publish time and uploads it next to the binary; there is no signing
  step and no private key.
- `src-tauri/src/commands/update.rs:95` — desktop `fetch_update_info` only reads the
  release metadata; there is no download/verify/install for the desktop app.

## Recommendation
Sign update artifacts and verify a signature, not just a hash:
- Adopt the Tauri updater plugin with a minisign keypair (public key baked into the
  app, private key in a protected CI secret), producing signed `latest.json` +
  per-artifact signatures — or, if keeping the custom updater, sign the agent binary
  (and its manifest) with an embedded ed25519/minisign public key and verify the
  signature before staging in `download_and_verify`.
- Until signing exists, treat the checksum as an integrity-only control and say so in
  the security docs; keep agent self-update off by default (as it is). Track this as a
  hard pre-v1.0 blocker rather than a beta nicety.
