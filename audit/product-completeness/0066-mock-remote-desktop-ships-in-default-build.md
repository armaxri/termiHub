---
id: PROD-066
title: "Mock Remote Desktop" test backend is registered in the default (shipping) build
angle: product-completeness
severity: medium
category: workaround
is_workaround: true
subsystem: src-tauri/src/session/registry, core/backends/mock_remote_desktop
evidence:
  - src-tauri/Cargo.toml:18
  - src-tauri/src/session/registry.rs:81
  - core/src/backends/mock_remote_desktop.rs:1
status: open
---

## What
`mock-remote-desktop` is in the default Cargo feature set, so the test-pattern "Mock Remote
Desktop" connection type is registered in production builds. It appears as a selectable
connection type ("Mock Remote Desktop — Experimental") whenever experimental features are on,
alongside real VNC/RDP.

## Why it matters
A test/demo backend (moving test pattern, echoed clipboard) is exposed to end users. It exists
only to make the shared remote-desktop layer testable without a real server; shipping it as a
user-selectable connection type is a stopgap that should not be in release builds.

## Evidence
- `src-tauri/Cargo.toml:18` — `default = ["ftp", "mock-remote-desktop", "vnc", "rdp-sidecar"]`.
- `src-tauri/src/session/registry.rs:81-89` — registered when the feature is on.
- `core/src/backends/mock_remote_desktop.rs:1` — "protocol-less test pattern".
- Gated as experimental (graphical) via `src/utils/experimentalTypes.ts:22`.

## Recommendation
Drop `mock-remote-desktop` from the default feature set (keep it for tests only) so it is not
registered in shipping builds.
