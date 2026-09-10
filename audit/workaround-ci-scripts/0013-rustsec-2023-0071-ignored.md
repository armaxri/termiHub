---
id: WA-CI-013
title: RUSTSEC-2023-0071 (rsa Marvin timing sidechannel) ignored in deny.toml + audit.toml
angle: workaround-ci-scripts
severity: medium
category: supply-chain
is_workaround: true
subsystem: deny.toml
evidence:
  - deny.toml:49
  - .cargo/audit.toml:10
status: open
---

## What
Both cargo-deny (`deny.toml` `ignore = ["RUSTSEC-2023-0071"]`) and cargo-audit
(`.cargo/audit.toml` `ignore = ["RUSTSEC-2023-0071"]`) suppress the Marvin-attack timing
sidechannel advisory in the `rsa` crate (transitive via `ssh-key`). The documented rationale:
termiHub only extracts raw RSA key components and rebuilds via OpenSSL, never decrypting through
this crate, so the sidechannel does not apply.

## Why it matters
This is a suppressed *vulnerability* advisory (not merely unmaintained). The rationale is
plausible and consistent across both tools, so it is a legitimate, documented release sign-off
— but any future code path that *does* decrypt through `rsa` would inherit a real timing
sidechannel silently, because the advisory is globally ignored.

## Evidence
`deny.toml` lines 40-51; `.cargo/audit.toml` lines 5-10. Both carry the same rationale.

## Recommendation
Keep the ignore for release (rationale holds today), but: (1) add a code-level assertion/comment
at the `rsa` usage site tying it to this ignore so a future decrypt path triggers review, and
(2) drop the ignore once `ssh-key`/`russh` move off the vulnerable `rsa` line (tracked with the
#1037 russh upgrade). This is the correct way to retire the workaround. Medium.
