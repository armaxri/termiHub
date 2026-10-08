---
id: PROD2-002
title: "Restart, Revoke and the global native-plugin toggle end a plugin's open sessions without confirmation"
angle: product-completeness
severity: low
category: ux
is_workaround: false
subsystem: "src/components/Settings (native plugins)"
evidence:
  - src/components/Settings/NativePluginRow.tsx:101
  - src/components/Settings/NativePluginRow.tsx:106
  - src/components/Settings/NativePluginRow.tsx:114
  - src/components/Settings/NativePluginRow.tsx:119
  - src/components/Settings/NativePluginGateSettings.tsx:74
  - src/components/Settings/NativePluginGateSettings.tsx:121
  - src/components/Settings/NativePluginGateSettings.tsx:140
  - src/components/Settings/NativePluginGateSettings.tsx:182
  - docs/concepts/implemented/plugin-os-sandbox.html:2440
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The sandboxed-plugin Settings row shows "Running · N sessions" next to a one-click **Restart** button. handleRestart calls `enablePlugin`, which reloads the runner, and per the concept sync ledger (row 6) that "restarts the whole plugin and ends its open sessions". **Revoke** ("unloads it immediately") and switching off **Enable Native Plugins** likewise end every live session of the plugin or plugins. None of the three asks first. The only ConfirmDialog in the row is for reduced isolation.

## Why it matters

A single misclick in Settings kills every live terminal on that plugin's backend, for example a set of serial/Modbus sessions, and the user loses in-flight work. Elsewhere the app confirms destructive actions that affect many targets (process kill, multi-target macro playback, broadcast paste, connection delete). Here the row even knows the session count and still does not warn.

## Evidence

- `src/components/Settings/NativePluginRow.tsx:101`
- `src/components/Settings/NativePluginRow.tsx:106`
- `src/components/Settings/NativePluginRow.tsx:114`
- `src/components/Settings/NativePluginRow.tsx:119`
- `src/components/Settings/NativePluginGateSettings.tsx:74`
- `src/components/Settings/NativePluginGateSettings.tsx:121`
- `src/components/Settings/NativePluginGateSettings.tsx:140`
- `src/components/Settings/NativePluginGateSettings.tsx:182`
- `docs/concepts/implemented/plugin-os-sandbox.html:2440`

## Recommendation

When `status.process.sessions > 0`, open a ConfirmDialog (variant warn) before Restart and Revoke, e.g. "Restart <name>? This ends its N open sessions." Do the same for the global toggle when any native plugin has live sessions, summing the counts from the plugin-sandbox region. Skip the dialog when the plugin has no sessions, and for Re-enable of an auto-disabled plugin, which has none.

## Verification

Confirmed. In NativePluginRow, Restart and Revoke call onRestart/onRevoke directly, and the only ConfirmDialog is the reduced-isolation one. In NativePluginGateSettings, handleRestart (enablePlugin), handleRevoke and handleToggleGlobal (setNativePluginsEnabled) run with no confirmation. Concept sync-ledger row 6 confirms that Restart ends open sessions, and nothing documents the missing confirm as a deliberate choice. I lowered the severity to low: these are explicit, clearly labelled Settings actions (Restart, Revoke, a global toggle), the ended sessions show an overlay rather than vanishing silently, and the plugin is presumably reconnectable.
