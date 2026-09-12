---
id: PARITY-009
title: mock-remote-desktop backend ships in default build features
angle: connection-parity
severity: medium
category: workaround
is_workaround: true
subsystem: src-tauri/Cargo.toml
evidence:
  - src-tauri/Cargo.toml:18
  - src-tauri/src/session/registry.rs:81
  - core/src/backends/mock_remote_desktop.rs:258
status: open
---

## What

`mock-remote-desktop` — a protocol-less, test/dev graphical backend that paints synthetic frames
with no real server — is in the desktop crate's **default** feature set, so it is compiled into and
registered by default release builds. It is reachable by any user who enables experimental features
(the same `#1705` gate that surfaces VNC/RDP), where it appears as a selectable
"Mock Remote Desktop — Experimental" connection type.

## Why it matters

- It is a scaffolding artifact ("so the shared remote-desktop layer works with no real VNC/RDP
  server"), not a product feature. Shipping it in release builds exposes a meaningless connection
  type to users and enlarges the release surface with dev-only code.
- It is exactly the class of thing the audit's workaround mandate targets: a feature flag left on
  that ships non-product code into the release build.

## Evidence

- `src-tauri/Cargo.toml:18` — `default = ["ftp", "mock-remote-desktop", "vnc", "rdp-sidecar"]`.
- `src-tauri/src/session/registry.rs:81` — registered under
  `#[cfg(feature = "mock-remote-desktop")]` as `"Mock Remote Desktop"`.
- `core/src/backends/mock_remote_desktop.rs:258` — `capabilities()` `graphical: true`, so the
  experimental gate (`isExperimentalConnectionType`) shows it in the picker when experimental
  features are on.

## Recommendation

Remove `mock-remote-desktop` from the `default` features and keep it as an explicit dev/test-only
feature (enabled by the test harness / `--features mock-remote-desktop`), so release builds never
register it. VNC and RDP are the real graphical backends and remain in `default` behind the
experimental UI gate; the mock should not.
