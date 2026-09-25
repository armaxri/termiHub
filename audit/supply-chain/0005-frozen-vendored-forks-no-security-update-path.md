---
id: SUP-005
title: Vendored forks (vnc-rs, ironrdp-rdpsnd) are frozen path copies with no upstream security-update path
angle: supply-chain
severity: medium
category: supply-chain
is_workaround: false
subsystem: vendor
evidence:
  - vendor/vnc-rs/Cargo.toml:3
  - vendor/vnc-rs/README.md:28
  - rdp-sidecar/Cargo.toml:205
  - rdp-sidecar/vendor/ironrdp-rdpsnd/README.md
status: open
---

## What

The project maintains two in-tree forks of third-party crates, both wired in as
path/patch dependencies:

- `vendor/vnc-rs` — a fork of upstream `vnc-rs 0.5.3`, a workspace member used by
  the VNC backend (adds VeNCrypt/TLS negotiation).
- `rdp-sidecar/vendor/ironrdp-rdpsnd` — a fork of upstream `ironrdp-rdpsnd 0.9.0`,
  injected via `[patch.crates-io]` in the RDP sidecar (fixes audio-format
  mapping).

Both are pinned to a specific upstream point release and consumed by
**path/patch**, not by version range. Neither has any mechanism (Dependabot,
renovate, the weekly `cargo update` chore) that can pull an upstream security or
bug fix — `cargo update` cannot advance a path dependency, and a `[patch]`
override permanently shadows the crates.io version regardless of what upstream
publishes.

## Why it matters

Both forks sit on **untrusted-remote-input** paths: `vnc-rs` decodes hostile RFB
framebuffer data; `ironrdp-rdpsnd` decodes RDP audio channel data. If upstream
`vnc-rs` or `ironrdp-rdpsnd` ships a fix for a parsing/soundness bug (exactly the
class of bug that bites protocol decoders), termiHub will not receive it — the
fork silently diverges and ages. There is no automated "your fork is N commits
behind upstream / upstream released a fix" signal. Over a long-lived project this
is how a known-fixed decoder vulnerability quietly persists in a shipped binary.

## Evidence

- `vendor/vnc-rs/Cargo.toml:3` — `version = "0.5.3"`; README documents it as a
  fork of upstream 0.5.3 with local VeNCrypt patches.
- `rdp-sidecar/Cargo.toml:205-206` — `[patch.crates-io] ironrdp-rdpsnd = { path =
  "vendor/ironrdp-rdpsnd" }`; README documents the fork of 0.9.0.
- No workflow or config references upstream-divergence tracking for either.

## Recommendation

For each fork, document the exact upstream commit/tag it was branched from and
add a lightweight periodic check (a scheduled CI job or a checklist item in the
release runbook) that compares against the latest upstream release and flags new
commits touching the forked files. Better: upstream the changes (VeNCrypt support
to `vnc-rs`, the audio-format fix to `ironrdp-rdpsnd`) so the fork can be retired
and the crate consumed by version range again — that restores the automated
update path and the cargo-deny/audit coverage. Until then, treat "re-base fork on
latest upstream" as a standing release-prep task.
