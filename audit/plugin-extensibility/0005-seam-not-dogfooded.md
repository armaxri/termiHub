---
id: PLG-005
title: The native-plugin seam is not dogfooded — no built-in backend uses the plugin ABI
angle: plugin-extensibility
severity: medium
category: arch
is_workaround: false
subsystem: core/src/plugin
evidence:
  - core/src/plugin/connection.rs:283
  - examples/plugins/echo-backend/src/lib.rs:1
status: open
---

## What
Built-in backends (local shell, SSH, telnet, serial, Docker, WSL) implement the
`ConnectionType` trait directly, in-crate, as ordinary Rust — they never cross the
plugin ABI. The FFI `PluginConnectionType` adapter and the whole opaque-handle
vtable path are exercised in production only by the `echo-backend` **example** and
by unit tests. No real, shipped backend is delivered through the plugin ABI.

## Why it matters
- **The richest, most dangerous extension path is the least exercised by real
  usage.** The FFI boundary (double-boxing, panic-guarded `extern "C"` dispatch,
  destructor-carrying owned types, the host-mediated capability bridge) is
  precisely the code where a mistake is undefined behavior — and the only thing
  driving it hard is a toy echo plugin. A backend that termiHub itself relied on
  through the ABI would keep the seam honest (surface missing capabilities, ergonomics
  gaps, and lifecycle bugs the way PLG-004 describes).
- **The seam and the built-in trait can drift.** Because built-ins take a separate,
  richer in-crate path, the plugin path can silently fall behind the trait's real
  contract (it already has: capabilities are hardcoded, PLG-004). Nothing forces the
  two to stay at parity.

This is not a soundness bug — the FFI engineering itself is careful — but it is an
architectural smell for an extension point being promoted as a stable contract.

## Evidence
- `core/src/plugin/connection.rs:283` onward — `PluginConnectionType` is the *only*
  `ConnectionType` impl that goes through the ABI; every built-in lives in
  `core/src/backends/*` as a native trait impl.
- `examples/plugins/echo-backend/src/lib.rs` — the sole end-to-end user of the four
  ABI symbols.

## Recommendation
Consider delivering at least one real, non-trivial built-in through the plugin ABI
(or a first-party plugin shipped in-box built exactly as a third party would build
it) so the seam is dogfooded on a production workload. At minimum, add an
integration test that loads a *packaged* `.termihub-plugin` `cdylib` through the
real `PluginHost` (not just the in-process `LoadedBackend` wrapper) so the
dlopen→ABI-check→register→connect→I/O→unload path is covered end to end on each
platform.
