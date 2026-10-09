---
id: DUP2-007
title: "Domain-separated detached Ed25519 verification is implemented twice, in agent_update_signature and plugin index_signature"
angle: code-duplication
severity: low
category: duplication
is_workaround: false
subsystem: "core/src/agent_update_signature.rs + core/src/plugin/index_signature.rs"
evidence:
  - core/src/agent_update_signature.rs:193-260
  - core/src/plugin/index_signature.rs:157-216
  - core/src/plugin/index_signature.rs:9-12
status: fixed
resolution: "#4365 — shared core::ed25519_detached (domain_message, parse_b64_signature, any_trusted_key_verifies); each policy keeps its errors"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`index_signature.rs` says it 'reuses the agent-update scheme' but does so by copying it: its own domain-prefix plus SHA-256 message builder (`index_signed_message`, compare `signed_message`), its own base64 64-byte signature parser (`parse_index_signature`, compare `parse_signature`), and its own `trusted_keys.iter().any(|k| k.verify_strict(&msg, &sig).is_ok())` loop. Only the PEM key parsing (`core::ed25519_pem`) is shared.

## Why it matters

This is the cryptographic core of two trust decisions: whether an agent binary is applied and whether a plugin index is accepted. The policies around it rightly differ (fail-closed versus a not-configured placeholder), but the primitive should not. Hardening it (for example insisting on `verify_strict`, rejecting non-canonical base64, or capping the input size) now needs two edits and two test suites.

## Recommendation

Add `core::ed25519_detached` with `domain_message(domain, digest32) -> Vec<u8>`, `parse_b64_signature(&str) -> Result<Signature, String>` and `any_trusted_key_verifies(&[VerifyingKey], &msg, &sig) -> bool`. Keep each module's policy enum and error types and map errors at the boundary.

## Verification

Confirmed. index_signature.rs has its own index_signed_message (domain + SHA-256), parse_index_signature (base64, 64 bytes) and an any(verify_strict) loop, mirroring agent_update_signature's signed_message, parse_signature and verify. Only ed25519_pem is shared. The code is small and both copies use verify_strict, so low.
