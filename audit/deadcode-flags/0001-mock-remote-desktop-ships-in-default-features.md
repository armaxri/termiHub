---
id: DEAD-001
title: Mock remote-desktop test backend ships in the default build
angle: deadcode-flags
severity: high
category: workaround
is_workaround: true
subsystem: src-tauri/Cargo.toml, src-tauri/src/session/registry.rs
evidence:
  - src-tauri/Cargo.toml:18
  - src-tauri/src/session/registry.rs:81
  - core/Cargo.toml
  - core/src/backends/mock_remote_desktop.rs
status: open
---

## What
`mock-remote-desktop` is in the **default** feature set of the desktop crate
(`default = ["ftp", "mock-remote-desktop", "vnc", "rdp-sidecar"]`), so a shipping
release compiles and registers a **protocol-less test backend** — a moving test
pattern with no real VNC/RDP server behind it — as a user-selectable connection
type named "Mock Remote Desktop".

## Why it matters
This is test/E2E scaffolding reachable in the released product. It is only hidden
by the experimental-features toggle (`isExperimentalConnectionType` → `graphical`),
so a user who enables experimental features sees a "Mock Remote Desktop" entry that
connects to nothing real. For a workaround-free release, demo/test backends should
not be in the default build.

## Evidence
- `src-tauri/Cargo.toml:18`: `default = ["ftp", "mock-remote-desktop", "vnc", "rdp-sidecar"]`
- `src-tauri/src/session/registry.rs:81-88`: `#[cfg(feature = "mock-remote-desktop")] registry.register("mock-remote-desktop", "Mock Remote Desktop", …)`
- The feature exists purely so "the shared remote-desktop layer (#1680) merges and
  is E2E-testable with no real VNC/RDP server" (`core/Cargo.toml` comment).

## Recommendation
Remove `mock-remote-desktop` from `src-tauri`'s `default` features. Keep the feature
defined so E2E/integration builds can opt in explicitly
(`cargo build --features mock-remote-desktop`) and the CI graphical-layer tests keep
working. No production code change is needed — the registration is already
`#[cfg(feature = …)]`-gated, so dropping it from `default` removes the shipped entry
cleanly. Verify the E2E harness passes the feature explicitly before removing.
