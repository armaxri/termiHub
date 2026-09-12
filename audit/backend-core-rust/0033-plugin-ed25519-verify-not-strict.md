---
id: CORE-033
title: Plugin signature uses ed25519 verify() instead of verify_strict() (signature malleability)
angle: backend-core-rust
severity: medium
category: security
is_workaround: false
subsystem: core/plugin
evidence:
  - core/src/plugin/signature.rs
status: fixed
resolution: "#2797 — plugin sig verify_strict (rejects malleable/small-order)"
---

## What
Package signature verification uses `ed25519-dalek`'s `verify()` rather than
`verify_strict()` (reported by the plugin/files audit).

## Why it matters
Plain `verify()` accepts non-canonical `R`/`A` encodings and small-order points,
so a given (key, message) can have multiple accepted signatures (malleability) and
cross-implementation agreement is not guaranteed. For a code-signing trust
boundary — deciding whether to load native plugin code — the strict, canonical
check is the correct one; malleability can undermine "signed exactly once by this
publisher" assumptions and any signature-equality/dedup logic built on top.

## Evidence
`core/src/plugin/signature.rs` (verification call site) and `trust_store.rs`.

## Recommendation
Use `VerifyingKey::verify_strict` for package signature verification. Add a test
asserting a non-canonical/malleable signature is rejected.
