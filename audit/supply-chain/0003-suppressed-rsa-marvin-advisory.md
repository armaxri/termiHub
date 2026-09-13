---
id: SUP-003
title: RUSTSEC-2023-0071 (Marvin timing sidechannel in `rsa`) is suppressed in both audit tools
angle: supply-chain
severity: medium
category: workaround
is_workaround: true
subsystem: core/backends/ssh
evidence:
  - deny.toml:43
  - .cargo/audit.toml:1
status: open
---

## What

The Marvin-attack RSA timing side-channel advisory RUSTSEC-2023-0071 is on the
ignore list of **both** supply-chain tools: `deny.toml` `[advisories] ignore`
and `.cargo/audit.toml` `[advisories] ignore`. It is the only vulnerability
advisory the project actively suppresses. The `rsa` crate in the tree is the
pre-release `0.10.0-rc.18` (see SUP-002), pulled transitively via `ssh-key`.

## Why it matters

Suppressing a live cryptographic advisory is a deliberate risk acceptance, not a
neutral config choice. The documented rationale is sound on its face — the code
only extracts raw RSA key components and rebuilds them via OpenSSL, and never
performs RSA decryption *through* this crate, so the padding-oracle timing
channel is claimed not to apply. That reasoning is plausible but load-bearing:
it is only valid as long as no code path ever routes an RSA private-key
operation through the `rsa` crate. There is no automated guard that this stays
true; a future change that uses `rsa` for an actual decryption/signing operation
would silently inherit the suppressed vulnerability with no CI signal.

## Evidence

- `deny.toml:43-45` — `ignore = ["RUSTSEC-2023-0071"]` with the raw-component
  rationale in the comment above.
- `.cargo/audit.toml:1-11` — the same ignore, same rationale, kept in sync so
  cargo-audit and cargo-deny agree.

## Recommendation

Keep the suppression (the rationale is reasonable) but harden the assumption it
rests on: (1) add a source-level assertion or a `cargo tree`/grep-based CI check
that `rsa` is used only for key-component extraction, never for a
sign/decrypt operation, so the "sidechannel does not apply" claim cannot silently
become false; (2) the real fix is to reach a `russh`/`ssh-key` release whose
transitive `rsa` carries the constant-time Marvin fix, at which point the ignore
can be deleted — tie this to the #1037 stable-RustCrypto migration. Re-review the
suppression at each release rather than letting it become permanent furniture.
