---
id: PLG-008
title: Plugin-declared manifest `settings` are persisted but never delivered to the native backend
angle: plugin-extensibility
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/src/plugin, plugin-api
evidence:
  - plugin-api/src/info.rs:64
  - core/src/plugin/manager.rs:643
  - core/src/plugin/connection.rs:309
status: open
---

## What
A manifest can declare plugin-level `settings` (e.g. `defaultNamespace`), which the
docs describe as "User-configurable settings" and which `PluginManager` faithfully
stores and edits in `plugin-settings.json` (`get_settings`/`update_settings`). But
there is **no path that hands those settings to a native backend.** The only thing a
backend receives at session creation is `PluginSessionConfig { config_json }` — the
per-connection config derived from `configSchema` (`plugin-api/src/info.rs:64-68`).
The manifest-level `settings` never reach `create_backend`.

## Why it matters
Authors are invited (by the manifest schema and the docs table) to declare plugin
settings, and users can edit them, but for a **native** backend those values are
inert — the plugin code has no way to read them. A `defaultNamespace` a user sets in
the plugin settings UI simply does nothing unless the author *also* threads it
through every connection's `configSchema`, which defeats the point of plugin-level
settings. It is a declared feature with no runtime effect on the primary (native)
extension point.

## Evidence
- `plugin-api/src/info.rs:64-68` — `PluginSessionConfig` carries only `config_json`;
  no settings channel.
- `core/src/plugin/connection.rs:309-336` — `connect()` builds `config_json` from the
  per-connection settings and the bridge; it never reads
  `PluginManager::get_settings` for the plugin.
- `core/src/plugin/manager.rs:643-666` — settings are read/written by the manager but
  only surfaced to the frontend, never to the backend.
- `docs/plugin-authoring.md:121-129` — documents `settings` as a first-class,
  user-configurable feature.

## Recommendation
Either wire plugin `settings` into session creation (extend `PluginSessionConfig`
with a `settings_json` field the host fills from `plugin-settings.json` — an
append-only ABI change), or, if plugin-level settings are intended only for
frontend/JS extensions, document that native backends cannot read manifest
`settings` and must take all configuration through `configSchema`. As written it is a
half-wired feature.
