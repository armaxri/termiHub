---
id: ARCH-008
title: Native backend plugins run in-process with full app privileges and no OS sandbox, while frontend plugins are sandboxed — an inverted trust model
angle: architecture-overall
severity: medium
category: security
is_workaround: false
subsystem: core/src/plugin, plugin-api
evidence:
  - core/src/plugin/host.rs:258
  - core/src/plugin/capabilities.rs:12
  - src/plugins/sandbox/pluginSandboxWorker.ts:1
status: open
---

## What

termiHub's plugin system has two plugin classes with **opposite isolation
strength relative to their privilege**:

- **Native backend plugins** (`terminalBackend`) ship as a Rust dynamic library
  loaded via `dlopen`/`libloading` into the host process. They run with the
  **full privileges of the app** and there is **no OS sandbox**. The capability
  bridge (`PluginHostBridge`) mediates network/filesystem access *only for
  plugins that cooperate*; the code explicitly documents that a malicious plugin
  "could still call `std::net::TcpStream::connect` or `std::fs::read` directly
  and bypass the bridge entirely; stopping that needs OS-level process isolation
  termiHub does not have" (`core/src/plugin/capabilities.rs:12-19`,
  `plugin-api/src/capabilities.rs:43-53`). Loading is itself irreducibly unsafe:
  "opening an arbitrary library runs its initializers" (`host.rs:258-264`).
- **Frontend plugins** (`protocolParser`, `statusBarWidget`) run in a
  least-privilege Web Worker — no DOM, no `window`, no Tauri IPC, `postMessage`
  only (`src/plugins/sandbox/pluginSandboxWorker.ts:1-21`) — and are **gated off
  by default** behind an experimental opt-in (`pluginsSlice.ts:175`).

So the *more* privileged plugin type (native, arbitrary in-process code) is the
*less* isolated one, and it is not gated behind the experimental flag the way
the weaker frontend type is.

## Why it matters

- For a security-conscious release, "install a plugin" for the native path means
  "run arbitrary native code with the app's full authority," mitigated only by
  provenance (Ed25519 signature + trust store + TOFU pinning) — not by
  containment. A signed-but-malicious or compromised plugin has no runtime
  boundary.
- The asymmetry is easy to misread: a user who sees the sandboxed, default-off
  frontend plugins may reasonably assume backend plugins are at least as
  contained; they are far less so.

This is a *documented, deliberate* boundary (OS process isolation is called
"future work"), so it is not a hidden defect — but for a ventilator-grade bar it
should be an explicit, surfaced release decision, not a default capability.

## Evidence

- `core/src/plugin/host.rs:258-264` — dlopen runs plugin initializers; "the
  irreducible unsafety of a plugin host."
- `core/src/plugin/capabilities.rs:12-19` — bridge is not a sandbox; direct
  syscalls bypass it.
- `src/plugins/sandbox/pluginSandboxWorker.ts:1-21` — frontend Worker sandbox;
  `src/store/slices/pluginsSlice.ts:175` — frontend plugins default-off.

## Recommendation

Make the native-plugin trust model an explicit, surfaced decision for v0.1.0:
either (a) gate native-backend plugins behind the same explicit opt-in as
frontend plugins (they are the higher-risk class), with an unambiguous
"runs unsandboxed with full app privileges" consent, or (b) ship v0.1.0 with the
native-plugin *loading* path disabled and only the sandboxed frontend + signed
theme/parser extensions enabled, deferring native backends until OS process
isolation lands. Document the chosen stance in ADR form alongside the existing
plugin concept.
