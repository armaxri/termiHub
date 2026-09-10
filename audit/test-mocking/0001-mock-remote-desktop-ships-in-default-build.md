---
id: MOCK-001
title: Mock remote-desktop test backend ships in the DEFAULT build and is a user-selectable connection type
angle: test-mocking
severity: high
category: workaround
is_workaround: true
subsystem: core/backends/mock_remote_desktop, src-tauri/src/session/registry
evidence:
  - src-tauri/Cargo.toml:18
  - core/Cargo.toml:283
  - core/src/backends/mock_remote_desktop.rs:77
  - src-tauri/src/session/registry.rs:81
  - src/utils/experimentalTypes.ts:9
status: open
---

## What
`MockRemoteDesktop` is a pure **test double** — a protocol-less generator that emits a
moving checkerboard test pattern, echoes the clipboard, and counts input events. It exists
so the shared remote-desktop layer (#1680) can be exercised "with no real VNC/RDP server"
(its own module doc). Yet it is compiled into the **default** feature set of the shipping
desktop app, registered into the live connection-type registry, and exposed to end users as
a selectable connection type ("Mock Remote Desktop — Experimental").

```
# src-tauri/Cargo.toml:18
default = ["ftp", "mock-remote-desktop", "vnc", "rdp-sidecar"]
```

```
# src-tauri/src/session/registry.rs:81
#[cfg(feature = "mock-remote-desktop")]
register("mock-remote-desktop", "Mock Remote Desktop", … MockRemoteDesktop::new())
```

It is hidden only behind the runtime `experimentalFeaturesEnabled` toggle
(`src/utils/experimentalTypes.ts`), not behind a build flag — so any user who turns on
experimental features gets a fake connection type that produces a synthetic animation.

## Why it matters
- A test double in the production binary is dead weight and a support-surface hazard: a user
  can create and "connect" a Mock Remote Desktop and see a bouncing block, with no indication
  it is a diagnostic stub. For a safety-critical, pre-release product this is exactly the kind
  of test scaffolding that must not ship.
- It also **masks** the fidelity gap: because the mock is the graphical backend that the
  default build and every unit test in `graphical_manager.rs` exercise, the shared graphical
  pipeline is validated end-to-end against an idealized, bounded generator rather than against
  a real protocol backend (see MOCK-011 / TBE-003 for the concrete unbounded-alloc path the
  mock cannot reproduce).

## Evidence
- Feature is in `default` for `src-tauri` (evidence above) and pulled through to core
  (`src-tauri/Cargo.toml:23` → `termihub-core/mock-remote-desktop`).
- Registered unconditionally when the feature is on: `src-tauri/src/session/registry.rs:81-88`.
- Frontend surfaces it as an experimental-but-real type: `experimentalTypeIds` /
  `buildGatedTypeOptions` (`src/utils/experimentalTypes.ts`), and the gating tests assert it
  is offered when experimental is on (`src/utils/experimentalTypes.test.ts:70`).

## Recommendation
Remove `mock-remote-desktop` from the `default` feature list in `src-tauri/Cargo.toml` (and
from any release profile). Keep it as a `#[cfg(feature = "mock-remote-desktop")]` /
`dev-dependencies`-style feature enabled only for `cargo test` and the E2E harness build, so
the shared graphical layer stays testable without a real server while the released binary
ships **no** mock connection type. Once removed, the experimental-gating logic still cleanly
covers the real `vnc`/`rdp` types (it keys off `capabilities.graphical`, not the type id).
