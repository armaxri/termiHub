---
id: LIBBE2-005
title: "Two hand-rolled constant-time comparisons while the subtle crate is already used in core"
angle: lib-usage-backend
severity: low
category: security-hygiene
is_workaround: false
subsystem: "src-tauri/credential, agent/io/auth"
evidence:
  - src-tauri/src/credential/master_password.rs:411
  - src-tauri/src/credential/master_password.rs:535
  - agent/src/io/auth.rs:141
  - agent/src/io/auth.rs:194
  - core/src/embedded_servers/http_server.rs:19
  - core/src/embedded_servers/http_server.rs:283
status: fixed
resolution: "#4363 — master-password and agent listen-token compares use subtle::ConstantTimeEq; bespoke helpers deleted"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Secret comparisons are done three ways. core's HTTP server uses `subtle::ConstantTimeEq` (http_server.rs:19,283). The agent listen-token check uses its own ct_eq, an XOR fold with std::hint::black_box (auth.rs:194). The master-password verifier uses another fold, constant_time_eq (master_password.rs:535), which has no black_box or other optimisation barrier, so nothing stops LLVM from turning the reduction into an early-exit compare.

## Why it matters

Constant-time comparison is exactly what `subtle` exists to guarantee, with optimisation barriers. Hand copies cannot promise it, and the two copies already differ (one has black_box, one does not). The practical timing risk is small: the master-password compare is local and on derived keys, and the agent compares SHA-256 digests. Still, security primitives should have a single audited implementation.

## Evidence

- `src-tauri/src/credential/master_password.rs:411`
- `src-tauri/src/credential/master_password.rs:535`
- `agent/src/io/auth.rs:141`
- `agent/src/io/auth.rs:194`
- `core/src/embedded_servers/http_server.rs:19`
- `core/src/embedded_servers/http_server.rs:283`

## Recommendation

Add `subtle = "2"` to src-tauri and agent (2.6.1 is already in Cargo.lock through core). Replace both helpers with `a.ct_eq(b).into()`, keeping the length check or comparing fixed-size digests, and delete constant_time_eq and ct_eq along with their bespoke tests.

## Verification

Confirmed. src-tauri master_password.rs:535 uses a plain XOR fold with no black_box. agent auth.rs:194 uses an XOR fold with black_box. core uses subtle (optional, embedded-servers) for HTTP Basic auth. src-tauri and agent do not depend on subtle directly. The real timing risk is negligible: the master-password compare runs locally on Argon2-derived keys, and the agent compares SHA-256 digests. Security-hygiene consolidation only.
