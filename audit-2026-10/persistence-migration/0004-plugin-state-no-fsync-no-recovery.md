---
id: PER2-004
title: "plugin-state.json (and plugin settings) written without fsync via a shared fixed temp name; a corrupt file bricks all plugin management with no recovery"
angle: persistence-migration
severity: low
category: durability
is_workaround: false
subsystem: core/src/plugin
status: fixed
resolution: "#4334 — plugin stores write via unique fsynced temp files; corrupt plugin-state.json is backed up and rebuilt (all disabled, native trust revoked); state updates share one lock"
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - core/src/plugin/plugin_state.rs:165
  - core/src/plugin/plugin_state.rs:191
  - core/src/plugin/plugin_state.rs:192
  - core/src/plugin/plugin_state.rs:204
  - core/src/plugin/manager.rs:338
  - core/src/plugin/manager.rs:672
  - core/src/plugin/manager.rs:1076
  - core/src/plugin/manager.rs:1465
  - core/src/plugin/host.rs:1201
---

## What

`plugin_state::write` uses a hand-rolled `std::fs::write(path.json.tmp)` followed by `rename`. There is no `sync_all` and the temp name is fixed (plugin_state.rs:191-193); `write_json_atomic` for plugin settings is the same (manager.rs:1465). `record_auto_disable` (plugin_state.rs:204) runs from the host's crash handler outside the manager lock, and its own comment admits a race window. Two writers then truncate and write the SAME tmp path concurrently and can rename interleaved bytes into place. On read, any parse error is a hard `StateError::Invalid` (plugin_state.rs:165). There is no .bak, salvage or reset.

## Why it matters

This is the durability class fixed for credentials.enc in #2324 (missing fsync before rename), and the store bypasses the project's write_atomic rule. A crash or power loss after the rename can leave a zero-length or garbage plugin-state.json. Then `list()` (manager.rs:338-342), `install`, `uninstall` (manager.rs:692) and `set_enabled` all fail on `read_state_store()?`. Every plugin also fails to load, because load_binding fails closed (host.rs:1201). The user cannot even uninstall and reinstall to repair it from the UI. The only fix is hand-deleting files in the config directory.

## Recommendation

Give core a shared `write_atomic` (NamedTempFile::new_in(parent), write, sync_all, persist), or move the agent and desktop helper into core, and use it for plugin-state.json, the plugin settings store, the native trust file and trust_store.rs. On an unparseable plugin-state.json, back it up to `.bak` and rebuild records from the installed plugin directories. Native plugins must stay disabled and need re-acknowledgment, so this fails safe. Do not hard-fail list and uninstall. Serialize record_auto_disable with the manager's lock, or use a FileLock.

## Verification

Confirmed. plugin_state::write and manager.rs write_json_atomic do fs::write to a fixed `.json.tmp` and then rename, with no sync_all. record_auto_disable runs outside the manager lock, and its own doc comment admits the race. parse() maps any error to a hard StateError::Invalid with no .bak or rebuild. list() propagates read_state_store()?, and load_binding fails closed. It is real, but it needs power loss or a narrow concurrent crash-handler race, and it fails safe (plugins disabled, nothing leaked), so I rate it low rather than medium.
