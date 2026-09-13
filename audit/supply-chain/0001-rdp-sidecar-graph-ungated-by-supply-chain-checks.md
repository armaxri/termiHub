---
id: SUP-001
title: RDP sidecar's 556-crate graph (incl. pre-release CredSSP crypto + a vendored fork) escapes every supply-chain gate
angle: supply-chain
severity: high
category: supply-chain
is_workaround: true
subsystem: rdp-sidecar
evidence:
  - Cargo.toml:12
  - Cargo.toml:18
  - rdp-sidecar/Cargo.toml:8
  - rdp-sidecar/Cargo.lock
  - .github/workflows/code-quality.yml:343
  - rdp-sidecar/vendor/ironrdp-rdpsnd
status: open
---

## What

The RDP sidecar (`rdp-sidecar/`) is **excluded from the Cargo workspace**
(`[workspace] exclude = ["rdp-sidecar"]`) and carries its **own** `Cargo.lock`
(556 packages). The `Security Audit` CI job runs `cargo audit` and
`cargo deny check advisories bans licenses sources` from the repo root, which
operate on the **root workspace `Cargo.lock` only**. No workflow step ever `cd`s
into `rdp-sidecar/` or points cargo-deny/cargo-audit at
`rdp-sidecar/Cargo.lock`. So the entire IronRDP dependency graph — the code that
**decodes untrusted RDP wire input** and performs CredSSP authentication — has
**zero** yank, vulnerability, license, or source-registry gating.

That graph is not benign: it includes a full pre-release RustCrypto/CredSSP
stack (`rsa 0.10.0-rc.18`, `ecdsa 0.17.0-rc.22`, `ed25519-dalek 3.0.0-rc.1`,
`x25519-dalek 3.0.0-rc.1`, `curve25519-dalek 5.0.0-rc.1`, `p256/p384/p521
0.14.0-rc.14`, `aes-gcm 0.11.0-rc.4`, `picky 7.0.0-rc.25`), plus a **vendored,
frozen fork** (`rdp-sidecar/vendor/ironrdp-rdpsnd`, patched over upstream 0.9.0)
that upstream advisories will never reach.

The exclusion itself is a deliberate, well-reasoned workaround for the #1725
RustCrypto version conflict (IronRDP's CredSSP crypto and russh pin incompatible
RustCrypto pre-releases; Cargo allows one version per crate per lockfile). The
problem is not the exclusion — it is that the exclusion silently carries the
sidecar out of the audit perimeter with nothing put back in its place.

## Why it matters

RDP ships in the desktop's default feature set (`default = ["ftp",
"mock-remote-desktop", "vnc", "rdp-sidecar"]`) and the helper binary is bundled
next to the app. A yanked or advisory-bearing crate anywhere in those 556
packages — on the path that parses hostile RDP framebuffer/PDU data — would
never trip CI, would never appear in `THIRD_PARTY_LICENSES` reasoning, and could
carry a non-allowlisted license into a shipped binary undetected. For a
safety-critical release that stakes its supply-chain posture on cargo-deny, a
whole second dependency graph outside the gate is a material blind spot.

## Evidence

- `Cargo.toml:18` — `exclude = ["rdp-sidecar"]`; `rdp-sidecar/Cargo.toml:8`
  documents the own-lockfile rationale.
- `.github/workflows/code-quality.yml:324-344` — `cargo audit` and
  `cargo deny check …` run once, from repo root; no sidecar-scoped invocation.
- `grep -n "rdp-sidecar" .github/workflows/* | grep -iE "deny|audit"` → no
  matches.
- `rdp-sidecar/Cargo.lock` — 556 packages; pre-release crypto enumerated above;
  0 git sources (good) but 0 audit coverage (bad).

## Recommendation

Add sidecar-scoped supply-chain gates to the `Security Audit` job (and to the
release/bundle lane that builds it): `cargo audit --file rdp-sidecar/Cargo.lock`
and `cargo deny --manifest-path rdp-sidecar/Cargo.toml check advisories bans
licenses sources` (with a sidecar `deny.toml`, or reuse the root one). The
sidecar's pre-release crypto will need its own documented `bans` sign-off and
likely its own advisory `ignore` list, mirroring the root config. Until that
lands, treat the RDP feature as not-yet-cleared for a safety-critical release.
Track the underlying #1725 conflict resolution (single RustCrypto line across
russh + IronRDP) as the real fix that would let the sidecar rejoin the workspace
and the single gate.
