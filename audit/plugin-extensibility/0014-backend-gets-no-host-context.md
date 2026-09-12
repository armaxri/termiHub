---
id: PLG-014
title: Native backend receives no host context (data dir, logger, own settings, app version, cancellation)
angle: plugin-extensibility
severity: low
category: missing-feature
is_workaround: false
subsystem: plugin-api
evidence:
  - plugin-api/src/symbols.rs:81
  - plugin-api/src/capabilities.rs:175
status: open
---

## What
`plugin_create_backend` hands the plugin exactly three things: the borrowed
`config_json`, a `PluginOutputSender`, and the `PluginHostBridge` (permission-checked
network + scoped filesystem). It gets **no** other host context:
- no per-plugin data/cache directory it may own outright,
- no host logger — a plugin's only output channel is the terminal stream itself
  (there is no way to emit a diagnostic that lands in the app's LogViewer),
- no access to its own persisted `settings` (PLG-008),
- no host/app version or feature flags,
- no cancellation/shutdown signal beyond `close()` on the backend.

## Why it matters
Real backends need somewhere to cache state, a way to surface diagnostics that a
user or the maintainer can see, and awareness of the host version to adapt. Routing
*everything* through the scoped-filesystem bridge (for storage) and the terminal
stream (for logs) is awkward and conflates plugin diagnostics with session output.
This raises the effort of writing anything beyond the echo example and makes plugin
failures hard to diagnose (a plugin that fails silently has no channel to say why
except polluting the terminal).

## Evidence
- `plugin-api/src/symbols.rs:81-86` — `PluginCreateBackendFn` signature: `config`,
  `output`, `bridge`, `out_backend`. Nothing else.
- `plugin-api/src/capabilities.rs:175-183` — the bridge exposes network + filesystem
  only; no logging or context surface.

## Recommendation
When the ABI is next revised (append-only), consider adding a small host-context
struct to `create_backend`: a plugin-scoped data directory, a host log callback
(target-tagged so it lands in the LogViewer), the host version, and the plugin's own
settings JSON (PLG-008). These are the affordances that move the SDK from "toy echo"
to "someone can build a real backend."
