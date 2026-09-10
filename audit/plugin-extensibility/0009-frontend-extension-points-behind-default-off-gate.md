---
id: PLG-009
title: Two of four extension points (protocolParser, statusBarWidget) work only behind a default-off gate with no permission enforcement
angle: plugin-extensibility
severity: medium
category: missing-feature
is_workaround: true
subsystem: src/plugins
evidence:
  - src/plugins/frontendPlugins.ts:111
  - src/components/Settings/FrontendPluginGateSettings.tsx:11
  - core/src/plugin/manifest.rs:92
status: open
---

## What
Of the four declared extension points (`terminalBackend`, `theme`, `protocolParser`,
`statusBarWidget`), the two JavaScript ones only take effect when the user turns on
the **experimental, default-off** frontend-plugin gate (`frontendPluginsEnabled ??
false`). And even when enabled, the sandbox has **no per-plugin permission
enforcement** — the gate's own comment points at #2001 as the open work: "run with
full IPC/command access and no per-plugin permission enforcement (weak isolation)."

So for a default install: `theme` works, `terminalBackend` works (behind an install
ack), and `protocolParser` + `statusBarWidget` do nothing. The `permissions` model
(`ui`, `settings`, `network`, `filesystem`) is not applied to frontend plugins at
all — the manifest can declare them but they are not enforced on the JS side.

## Why it matters
- Half the advertised extension surface is inert by default and experimental when
  enabled. An author building a status-bar widget or an output parser ships against a
  contract that most users will never have active.
- The `permissions` declared in a manifest are enforced (cooperatively) for native
  backends but **not** for frontend plugins, so the same manifest field means
  different things depending on extension type — a coherence gap in the model.

## Evidence
- `src/plugins/frontendPlugins.ts:111-124` — `reconcileFrontendPlugins(plugins,
  enabled=…)`; when the gate is off it loads nothing and tears down live.
- `src/store/slices/pluginsSlice.ts:175` — `frontendPluginsEnabled ?? false`.
- `src/components/Settings/FrontendPluginGateSettings.tsx:11-15` — documents "full
  IPC/command access and no per-plugin permission enforcement (…#2001)".
- `core/src/plugin/manifest.rs:92-108` — protocolParser/statusBarWidget are validated
  for presence; the JS `permissions` are not enforced.

## Recommendation
This is a legitimate safety stopgap (`is_workaround: true`) — don't ship untrusted
in-WebView JS without isolation. But it should be tracked as such: either land the
per-plugin permission enforcement (#2001) so the gate can eventually default on, or
document these two extension points as experimental in `plugin-authoring.md` (today
the doc presents all four as equal). Make the `permissions` semantics consistent
across native and frontend plugins, or document that frontend plugins ignore them.
