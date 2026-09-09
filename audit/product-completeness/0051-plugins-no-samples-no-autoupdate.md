---
id: PROD-051
title: No sample protocol-parser/status-bar-widget plugin and no plugin auto-update
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: examples/plugins, src-tauri/src/commands/plugin
evidence:
  - src-tauri/src/commands/plugin.rs:1
status: open
---

## What
Only an `echo-backend` and a theme example exist; there is no sample JS protocol-parser or
status-bar-widget plugin, and no plugin update path.

## Why it matters
Plugin authors have no reference for two of the four extension points, and installed plugins
cannot be updated in-app (must uninstall/reinstall).

## Evidence
- `examples/plugins/` — only `echo-backend` + a theme.
- No update command in `src-tauri/src/commands/plugin.rs`.

## Recommendation
Ship a sample parser plugin and a sample status-bar-widget plugin; add an update path (paired
with PROD-048 discovery).
