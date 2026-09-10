---
id: PKG-002
title: Mock remote-desktop test backend is a default feature and ships (registered + user-reachable) in the release build
angle: packaging-release
severity: medium
category: workaround
is_workaround: true
subsystem: src-tauri/src/session/registry.rs
evidence:
  - src-tauri/Cargo.toml:18
  - src-tauri/src/session/registry.rs:81
  - src/utils/experimentalTypes.ts:11
status: open
---

## What
`mock-remote-desktop` is in the crate's `default` feature set
(`default = ["ftp", "mock-remote-desktop", "vnc", "rdp-sidecar"]`) and the release
pipeline builds with default features (release.yml passes no `--no-default-features`
and no `--features` override). The backend is therefore compiled in and
**registered as a real connection type** ("Mock Remote Desktop", icon `monitor`) in
the shipped app.

It is hidden from the connection picker *by default* because it reports
`capabilities.graphical: true` and the frontend treats all graphical types as
experimental (`src/utils/experimentalTypes.ts`). But the moment a user enables
"experimental features" (the documented path to try the real VNC/RDP backends), a
fake, non-functional "Mock Remote Desktop" backend appears alongside them in the
production UI.

## Why it matters
A mock/test backend is a dev-and-E2E scaffold (it exists so the shared
remote-desktop layer is testable with no real server). Shipping it in a public beta
means a user who turns on experimental features to try VNC/RDP is offered a
connection type that does nothing real — confusing and unprofessional, and it
enlarges the release attack/registration surface for no user benefit. Several audit
angles independently flagged the mock backend shipping in the default build.

## Evidence
- `src-tauri/Cargo.toml:18` — `mock-remote-desktop` in `default`.
- `src-tauri/src/session/registry.rs:81-89` — `#[cfg(feature = "mock-remote-desktop")]`
  registers it in `build_desktop_registry()`.
- release.yml `build-and-upload` (args line ~203) builds with default features, so
  the mock ships in every desktop artifact.
- Unlike VNC/RDP, the registry comment for mock does **not** mark it experimental —
  it is only hidden via the frontend's graphical-type heuristic.

## Recommendation
Remove `mock-remote-desktop` from `default`. Keep it as an opt-in feature enabled
only by the test/dev builds (system-integration lane, dev-build.yml) that actually
exercise the shared remote-desktop layer. The release build then never registers it.
If a shipped remote-desktop demo is desired, it should be a real protocol, not a
mock. This is the same fix class as PKG-001 (dev/test scaffolding gated out of
release via features rather than shipped-and-hidden).
