---
id: PROD-048
title: Plugins have no in-app marketplace/discovery; install is local-file only
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/commands/plugin, src/components/Plugins
evidence:
  - src-tauri/src/commands/plugin.rs:42
  - src-tauri/src/commands/plugin.rs:114
status: open
---

## What
Plugins can only be installed by picking a `.termihub-plugin` file from disk. There is no
registry, browse, search, or download in-app.

## Why it matters
Without discovery, the plugin ecosystem is effectively invisible to users — they must find and
download plugin files out of band. This limits adoption of an otherwise real plugin system.

## Evidence
- `src-tauri/src/commands/plugin.rs:42, 114` — install/validate take a filesystem path.
- No marketplace/registry/discover/browse in `src/components/Plugins/`.

## Recommendation
Add a plugin registry/browse view (even a curated static index initially) with install-from-URL.
