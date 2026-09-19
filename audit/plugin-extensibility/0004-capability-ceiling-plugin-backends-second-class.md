---
id: PLG-004
title: Capability ceiling — plugin backends cannot reach built-in parity (no file browser, monitoring, graphical, persistent)
angle: plugin-extensibility
severity: high
category: arch
is_workaround: false
subsystem: core/src/plugin/connection.rs
evidence:
  - core/src/plugin/connection.rs:298
  - plugin-api/src/backend.rs:62
  - core/src/plugin/connection.rs:394
status: open
---

## What
The extension seam a third party gets — the native `terminalBackend` — exposes only
a strict *subset* of what a built-in `ConnectionType` can do. `PluginConnectionType`
hardcodes its capabilities:

```rust
// core/src/plugin/connection.rs:298
fn capabilities(&self) -> Capabilities {
    Capabilities { monitoring: false, file_browser: false, graphical: false,
                   resize: true, persistent: false, terminal: true }
}
fn monitoring(&self) -> Option<&dyn MonitoringProvider> { None }  // :394
fn file_browser(&self) -> Option<&dyn FileBrowser> { None }        // :398
```

and the ABI vtable a plugin implements has exactly four methods — `write_input`,
`resize`, `close`, `is_alive` (`plugin-api/src/backend.rs:62-74`). There is **no**
ABI surface for a plugin to provide SFTP-style file browsing, system monitoring, a
graphical/RDP-style surface, or persistent/reconnectable sessions.

## Why it matters
- **Third-party backends are structurally second-class.** A built-in SSH backend
  offers `file_browser` (the SFTP panel) and `monitoring` (the system-stats panel);
  a plugin that connects to, say, a cloud shell or a Kubernetes pod can *never*
  offer those, no matter how capable the underlying protocol is. The seam caps the
  ecosystem below the built-ins.
- **`persistent: false` means plugin sessions can't participate in the
  reconnect/reattach machinery** that is a headline feature (stateless-UI reattach).
  A plugin backend is a plain terminal that dies with the app.
- **`graphical: false`** rules out the entire class of non-text backends (VNC/RDP-
  like) via plugins, even though the app already has graphical connection types on
  the roadmap.

This is the difference between "you can add a niche text terminal" and "you can
extend termiHub to parity." For a plugin *ecosystem* the latter is the point.

## Evidence
- `core/src/plugin/connection.rs:298-307` — all non-terminal capabilities hardcoded
  `false`.
- `core/src/plugin/connection.rs:394-400` — `monitoring()`/`file_browser()` return
  `None` unconditionally.
- `plugin-api/src/backend.rs:35-47` (`PluginTerminalBackend` trait) and `:62-74`
  (`PluginBackendVTable`) — four methods only; no file/monitor/graphical hooks.

## Recommendation
Decide deliberately what the seam's ceiling is and document it. If parity is a
goal, grow the ABI (append-only, per PLG-003) with optional capability vtables — a
`PluginFileBrowserVTable`, a `PluginMonitoringVTable` — that a backend can opt into,
and surface real `Capabilities` from what the plugin declares/exports rather than a
hardcoded struct. If parity is explicitly *not* a v0.1 goal, say so in
`plugin-authoring.md` ("plugin backends are text-only terminal sessions; file
browsing, monitoring, graphical surfaces and reconnect are not available to
plugins") so authors don't discover the ceiling by hitting it.
