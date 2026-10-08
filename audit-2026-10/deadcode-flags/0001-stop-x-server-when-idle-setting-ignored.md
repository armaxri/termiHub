---
id: DEAD2-001
title: "The 'Stop X Server When Idle' setting does nothing: the backend hard-codes stop-when-idle to true"
angle: deadcode-flags
severity: medium
category: dead-flag
is_workaround: false
subsystem: "src-tauri/terminal/xserver + Settings UI"
evidence:
  - src-tauri/src/lib.rs:182
  - src-tauri/src/lib.rs:188
  - src-tauri/src/connection/settings.rs:460
  - src-tauri/src/connection/settings.rs:464
  - src-tauri/src/terminal/xserver/manager.rs:180
  - src-tauri/src/terminal/xserver/manager.rs:259
  - src/components/Settings/XServerSettings.tsx:44
  - src/components/Settings/XServerSettings.tsx:50
  - src/components/Settings/settingsRegistry.ts:814
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

AppSettings.stop_x_server_when_idle is persisted (settings.rs:464) and shown as a toggle in Settings > X Server ('Shut the managed X server down once no connection is using it', XServerSettings.tsx:44-55). No backend code ever reads it. build_xserver_manager() builds the one XServerManager with a literal `true` for stop_when_idle (lib.rs:188), and nothing changes it afterwards (there is no setter). manager.rs:259 always stops the server when refcount reaches 0. Across all AppSettings fields this is the only one with no backend reader and no frontend reader outside the settings UI. Its sibling provide_x_server_automatically is wired correctly through resolve_provide_automatically.

## Why it matters

The flag is visible to users and has no effect. A Windows user who turns it off to keep VcXsrv running between X11 sessions still has the managed server killed after every last session. That defeats the reason for the setting and costs a full VcXsrv cold start on the next X11 connect. A safety-minded release should not ship a toggle that silently does nothing.

## Evidence

- `src-tauri/src/lib.rs:182`
- `src-tauri/src/lib.rs:188`
- `src-tauri/src/connection/settings.rs:460`
- `src-tauri/src/connection/settings.rs:464`
- `src-tauri/src/terminal/xserver/manager.rs:180`
- `src-tauri/src/terminal/xserver/manager.rs:259`
- `src/components/Settings/XServerSettings.tsx:44`
- `src/components/Settings/XServerSettings.tsx:50`
- `src/components/Settings/settingsRegistry.ts:814`

## Recommendation

Wire the setting in. Give XServerManager a `set_stop_when_idle(bool)` (or read it through a closure the way resolve_provide_automatically does), seed it from connections.get_settings().stop_x_server_when_idle at boot, and update it in the settings-save path. Then add a test that turning it off keeps the server running at refcount 0. If you decide not to support the option, remove the field, the registry entry and the toggle instead.

## Verification

Confirmed. lib.rs build_xserver_manager passes a literal `true` for stop_when_idle. The only uses of stop_x_server_when_idle in Rust are the field, its default and serde tests in settings.rs. manager.rs:259 checks only inner.stop_when_idle, and there is no setter. The toggle is shown in XServerSettings.tsx and listed in architecture.md:2413, so users can see it but it has no effect (Windows-only path).
