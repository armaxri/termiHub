---
id: SEC-011
title: Plugin signatures verified with non-strict ed25519 (signature malleability permitted)
angle: security
severity: low
category: security
is_workaround: false
subsystem: core/src/plugin
evidence:
  - core/src/plugin/signature.rs:359
status: open
---

## What

Plugin package signatures are checked with `ed25519_dalek`'s non-strict
`VerifyingKey::verify`:

```rust
// core/src/plugin/signature.rs:359-361
verifying_key
    .verify(&payload, &ed_sig)
    .map_err(|_| SignatureError::BadSignature)?;
```

`verify` accepts signatures/public keys that `verify_strict` rejects (non-canonical
`s`/`R` encodings, small-order components) — i.e. it permits signature
malleability.

## Why it matters

For this format the practical impact is **low**: the verifier also enforces
`keyId == sha256(publicKey)`, an exact-set digest match binding every archive byte,
and a domain-separation tag, and the trust decision keys on the pinned public key.
An attacker cannot forge a signature for content they did not sign, so malleability
does not yield a content-swap. The concern is defense-in-depth and consistency
with best practice: a malleable-but-valid signature variant could confuse any
future logic that treats the signature bytes as a unique identifier (dedup,
replay caches, audit logs), and "use `verify_strict` for anything security-relevant"
is the standard guidance for the crate.

## Evidence

- `core/src/plugin/signature.rs:359` — `verifying_key.verify(...)` (non-strict).

## Recommendation

Switch to `verifying_key.verify_strict(&payload, &ed_sig)` (same signature, same
error mapping). No format or compatibility change — strict verification only
rejects non-canonical encodings that a legitimate signer never produces. Add a
one-line note that strict verification is required.
