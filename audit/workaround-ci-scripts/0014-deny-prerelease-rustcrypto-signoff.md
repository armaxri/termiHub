---
id: WA-CI-014
title: deny.toml accepts pre-release RustCrypto stack + allows multiple-versions/wildcards
angle: workaround-ci-scripts
severity: medium
category: supply-chain
is_workaround: true
subsystem: deny.toml
evidence:
  - deny.toml:bans
status: open
---

## What
The `[bans]` section documents a deliberate release sign-off for a **pre-release** RustCrypto
stack pulled via `russh 0.61.1`: `rsa 0.10.0-rc.x` and `ssh-key 0.7.0-rc.x` (which pinned the
once-yanked `crypto-bigint 0.7.x`, now resolved to 0.7.5). It also sets `multiple-versions =
"allow"` and `wildcards = "allow"`, so neither duplicate crate versions nor wildcard version
requirements gate CI.

## Why it matters
Shipping a safety-critical release on `-rc` (release-candidate) crypto crates is a real risk:
RC crates can have breaking changes, unaudited fixes, or be pulled. The `yanked = "deny"` gate
(the one thing that IS enforced) only guards against silent regression to a yanked version, not
against the RC crypto being buggy. `wildcards = "allow"` additionally means a `*` version
requirement (a supply-chain hazard) would not be caught.

## Evidence
`[bans]` block (rationale lines) with `multiple-versions = "allow"`, `wildcards = "allow"`.

## Recommendation
Highest-value retirement is landing the **#1037** russh upgrade onto a stable RustCrypto
0.7/0.10 line, which removes the RC sign-off entirely. Until then, keep `yanked = "deny"` and
consider tightening `wildcards = "deny"` (the workspace should have no wildcard reqs of its own,
so this is low-friction and closes a real hole). Track the RC crypto as a release-blocker-adjacent
item for the ventilator-grade bar. Medium.
