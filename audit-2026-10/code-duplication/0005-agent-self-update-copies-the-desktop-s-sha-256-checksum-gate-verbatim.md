---
id: DUP2-005
title: "Agent self-update copies the desktop's SHA-256 checksum gate verbatim, while the signature half of the same release-asset contract lives in core"
angle: code-duplication
severity: low
category: duplication
is_workaround: false
subsystem: "agent/update + src-tauri terminal/agent_binary (agent release-asset verification)"
evidence:
  - agent/src/update/checksum.rs:1-73
  - src-tauri/src/terminal/agent_binary.rs:40-42
  - src-tauri/src/terminal/agent_binary.rs:175-241
  - core/src/agent_update_signature.rs:265
  - core/src/backends/rdp_sidecar/integrity.rs:73-89
  - core/src/plugin/signature.rs:243-256
status: fixed
resolution: "#4365 — one .sha256 gate in core::agent_update_checksum on util::sha256, also used by rdp_sidecar::integrity and plugin::signature"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The fail-closed `.sha256` sidecar check for agent binaries exists twice, line for line. `sha256_hex_of_file`, `parse_sha256_sidecar`, `verify_file_checksum`, `checksum_sidecar_path` and `CHECKSUM_EXT` are in both `agent/src/update/checksum.rs` (whose header says it 'mirrors the desktop-side verification introduced in #1350') and `src-tauri/src/terminal/agent_binary.rs:175-241`. Each has its own copy of the tests. The other half of the same release-asset contract, the `.sig` Ed25519 sidecar (`SIGNATURE_EXT`, `signature_sidecar_path`, `SignaturePolicy`), is already in `core::agent_update_signature` and used by both sides. Core also has two more independent streaming SHA-256-of-file helpers: `rdp_sidecar::integrity::sha256_hex_of_file` and `plugin::signature::sha256_file`.

## Why it matters

This is a security gate (AGT-004/AGT-005: never stage an agent binary that does not match its published checksum). Desktop deploy and agent self-update must accept the same sidecar formats (bare hex, `sha256sum` text or binary mode) and reject the same garbage. Today that agreement depends on two copies staying in sync. A future format change, such as a multi-line or BSD-style sidecar or a stricter token rule, made on one side silently splits the push-deploy and self-update paths. Signatures are already shared and checksums are not, an inconsistency left over from the centralization.

## Recommendation

Move the checksum helpers next to the signature helpers: create `core::agent_update` (or extend `core::agent_update_signature`) with `CHECKSUM_EXT`, `checksum_sidecar_path`, `parse_sha256_sidecar` and `verify_file_checksum`, built on one `core::util::sha256_hex_of_reader`/`_of_file` primitive that `rdp_sidecar::integrity` and `plugin::signature::sha256_file` (prefixed form) also use. Delete `agent/src/update/checksum.rs` and the desktop copies, and keep one test suite in core.

## Verification

Confirmed. agent/src/update/checksum.rs and src-tauri agent_binary.rs:175-242 differ only in doc wording, the extra sha256_hex_of_bytes and visibility. The header says it 'mirrors' the desktop. The signature half is shared in core. rdp_sidecar::integrity::sha256_hex_of_file and plugin::signature::sha256_file are further copies. The two copies are identical today, so this is drift risk rather than an active defect: low, not medium.
