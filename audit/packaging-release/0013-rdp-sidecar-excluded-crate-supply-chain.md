---
id: PKG-013
title: RDP sidecar is a workspace-excluded crate (own Cargo.lock) bundled into release but outside the workspace's per-PR audit/lint gates
angle: packaging-release
severity: medium
category: supply-chain
is_workaround: true
subsystem: rdp-sidecar
evidence:
  - scripts/build-rdp-sidecar.sh:5
  - .github/workflows/release.yml:189
  - src-tauri/tauri.sidecar.conf.json:4
status: open
---

## What
`termihub-rdp-helper` (the IronRDP sidecar) is a **workspace-excluded** crate with its
**own `Cargo.lock`**, deliberately separated because IronRDP's CredSSP crypto and
`russh` pin incompatible RustCrypto pre-releases and Cargo allows only one version per
crate per lockfile. It is cross-built per target and bundled next to the desktop app
via Tauri `externalBin` in every release (release.yml "Build RDP sidecar for
bundling").

Because it is excluded from the workspace, it is **not covered by the workspace-wide
CI gates** — `cargo clippy --workspace`, `cargo test --workspace`, and (critically for
supply chain) `cargo deny` / `cargo audit` run over the workspace lockfile do not see
the sidecar's separate lockfile. So a shipped binary is built from an independent,
pre-release-pinned dependency graph that the repo's advisory/yank/license scanning does
not audit on a per-PR basis.

## Why it matters
The sidecar ships in the default release build (`rdp-sidecar` is a default feature) and
runs on the user's machine handling RDP/CredSSP crypto. A yanked crate or a security
advisory in its dependency tree (or an incompatible-license transitive dep) would not
be caught by the same gates that protect the main workspace — the memory notes
recurring cargo-deny yank/advisory breakage in the main tree, and this second lockfile
is a blind spot for exactly that class of issue. It relies on pre-release RustCrypto
pins, which are inherently higher-risk.

## Evidence
- `scripts/build-rdp-sidecar.sh:5-11` — documents the workspace-exclusion and separate
  Cargo.lock rationale.
- `release.yml:189-191` — the sidecar is cross-built and staged into
  `src-tauri/binaries/` for every release matrix target.
- `src-tauri/tauri.sidecar.conf.json:4` — `externalBin` bundles it into the app.
- The supply-chain audit angle should confirm whether any CI job runs `cargo deny` /
  `cargo audit` against `rdp-sidecar/Cargo.lock` (this audit found none in the
  release/build workflows in scope).

## Recommendation
Bring the sidecar's lockfile under the same supply-chain gates: run `cargo deny check`
and `cargo audit` against `rdp-sidecar/Cargo.lock` in CI (a dedicated matrix leg, since
it cannot join the workspace), and include it in the lockfile-update automation. Track
the pre-release RustCrypto pins with a plan to move to stable releases once IronRDP and
russh converge. At minimum, document that the sidecar carries an independently-audited
dependency set.
