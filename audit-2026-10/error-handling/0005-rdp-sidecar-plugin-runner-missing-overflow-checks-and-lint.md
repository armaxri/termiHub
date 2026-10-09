---
id: ERR2-005
title: "RDP sidecar is missing the release overflow-checks (ERR-010) and the no-unwrap lint; plugin-runner is missing the lint"
angle: error-handling
severity: low
category: reliability
is_workaround: false
subsystem: "rdp-sidecar (separate workspace), plugin-runner"
evidence:
  - rdp-sidecar/Cargo.toml:17
  - rdp-sidecar/Cargo.toml:20
  - rdp-sidecar/Cargo.toml:21
  - Cargo.toml:33
  - Cargo.toml:89
  - src-tauri/src/lib.rs:4
  - rdp-sidecar/src/drive.rs:671
  - plugin-runner/src/lib.rs:1
status: fixed
resolution: "#4343 — sidecar release overflow-checks; no-panic lint on all crate roots; check-crate-policy.mjs CI gate"
audit: "2026-10"
commit: "663465d52"
relation: previous-incomplete
previous_id: ERR-010
---

## What

ERR-010 was fixed by adding `[profile.release] overflow-checks = true` to the root Cargo.toml. rdp-sidecar is excluded from the root workspace (Cargo.toml:33) and has its own release profile. Its comment says the profile is 'matching the root workspace's release profile', but it only sets `strip = true`. The shipped termihub-rdp-helper therefore still wraps silently on overflow, for example in to_filetime's `(secs as i64 + EPOCH_DIFF) * 10_000_000` at drive.rs:671, and in the parsing of server-controlled RDP PDUs.
Separately, the TOOL-010 policy (deny clippy::unwrap_used, expect_used and panic outside tests) is declared only in src-tauri, agent, core and plugin-api. Neither plugin-runner, which runs native plugin code and decodes host IPC, nor rdp-sidecar, which talks to possibly hostile RDP servers, declares it.

## Why it matters

The ventilator-grade policy says unintended overflow must fail fast instead of producing silently corrupt values. The two binaries that handle the most untrusted input are the ones left out. Both are currently clean of production unwraps, so this is a gap in prevention rather than a live crash, but nothing stops a regression.

## Recommendation

1. Add `overflow-checks = true` to rdp-sidecar/Cargo.toml [profile.release], and correct the 'matching' comment.
2. Add the same `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]` header to plugin-runner/src/lib.rs, plugin-runner/src/main.rs and rdp-sidecar/src/main.rs, and make sure CI runs clippy on the sidecar with -D warnings.
3. Use checked_mul / saturating arithmetic in to_filetime.

## Verification

Confirmed. rdp-sidecar/Cargo.toml [profile.release] sets only `strip = true`, even though its comment says it matches the root profile, which has `overflow-checks = true` at Cargo.toml:89. The deny(clippy::unwrap_used...) header exists only in src-tauri, agent, core and plugin-api; plugin-runner and rdp-sidecar have none. to_filetime uses unchecked arithmetic, but it only overflows for absurd timestamps. This is a gap in prevention, not a live bug: low.
