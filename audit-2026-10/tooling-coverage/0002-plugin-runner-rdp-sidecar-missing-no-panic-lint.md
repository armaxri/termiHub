---
id: TOOL2-002
title: "New plugin-runner crate (sandbox boundary) and the rdp-sidecar are not covered by the no-panic lint"
angle: tooling-coverage
severity: medium
category: static-analysis
is_workaround: false
subsystem: "rust / static-analysis"
evidence:
  - "core/src/lib.rs:6"
  - "agent/src/lib.rs:22"
  - "src-tauri/src/lib.rs:6"
  - "plugin-api/src/lib.rs:100"
  - "plugin-runner/src/lib.rs:21-30"
  - "plugin-runner/src/main.rs:1-20"
  - "rdp-sidecar/src/main.rs:1-20"
  - "rdp-sidecar/src/cert.rs:65"
  - "rdp-sidecar/src/drive.rs:474"
  - "Cargo.toml:workspace.members (plugin-runner)"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: TOOL-010
---

## What

The TOOL-010 fix (#3224) put `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]` on the four crate roots that existed then: core, agent, src-tauri and plugin-api. Since then, the ~11k-line `plugin-runner` crate has been added to the workspace (#4182). It contains the out-of-process native-plugin host binary, the IPC frame decoder and the per-OS sandbox. Neither its lib.rs nor its main.rs carries the attribute (`rg unwrap_used plugin-runner/` returns nothing).

The separately-locked `rdp-sidecar` (~11.5k lines; handles CredSSP credentials and the RDP stream) does not carry it either. It already has production `expect()`s at rdp-sidecar/src/cert.rs:65 and drive.rs:474, before any `#[cfg(test)]`. CI's `clippy -D warnings` covers both crates, but only with the default lint set, so the restriction lints never fire there.

## Why it matters

The project policy is 'no unwrap/expect/panic in production'. The two crates that sit on the untrusted-peer boundary (plugin IPC decode, remote RDP data) are exactly where a panic is a crash or a denial of service. Today nothing stops a new `unwrap()` from landing in them. The lint was meant to cover every first-party crate, and the gate silently stopped short when new crates arrived.

## Evidence

- `core/src/lib.rs:6`
- `agent/src/lib.rs:22`
- `src-tauri/src/lib.rs:6`
- `plugin-api/src/lib.rs:100`
- `plugin-runner/src/lib.rs:21-30`
- `plugin-runner/src/main.rs:1-20`
- `rdp-sidecar/src/main.rs:1-20`
- `rdp-sidecar/src/cert.rs:65`
- `rdp-sidecar/src/drive.rs:474`
- `Cargo.toml:workspace.members (plugin-runner)`

## Recommendation

Add the same `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]` to plugin-runner/src/lib.rs, plugin-runner/src/main.rs and rdp-sidecar/src/main.rs. Fix or locally `#[allow]` (with a justification) the few existing prod sites.

To stop the next crate escaping, move the policy into `[workspace.lints.clippy]` in the root Cargo.toml with `lints.workspace = true` per member (and the equivalent `[lints]` table in rdp-sidecar/Cargo.toml), or add a CI check that every first-party crate root declares the attribute.

## Verification

Confirmed. `rg unwrap_used` finds the deny attribute only in core/lib.rs, agent/lib.rs and main.rs, src-tauri/lib.rs and main.rs, and plugin-api/lib.rs. Neither plugin-runner/src/lib.rs nor main.rs has it, and neither does rdp-sidecar/src/main.rs. There is no [workspace.lints] table and no [lints] table in plugin-runner/Cargo.toml or rdp-sidecar/Cargo.toml. Both production expects exist before the #[cfg(test)] modules: cert.rs:65 `expect("hex is ascii")` (cert.rs tests start at line 94) and drive.rs:474 `expect("listing set above")` (drive.rs tests start at line 939). CI clippy (code-quality.yml:139 and 372) runs only `-D warnings` with the default lint set. Both existing sites are invariant-safe, so this is a gap in the gate, not a live panic. Medium is fair.
