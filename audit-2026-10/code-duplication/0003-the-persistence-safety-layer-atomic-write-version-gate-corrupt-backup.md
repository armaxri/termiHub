---
id: DUP2-003
title: "The persistence-safety layer (atomic write, version gate, corrupt backup) exists separately in desktop, agent and core::plugin, and the core::plugin copies dropped the fsync and version gate"
angle: code-duplication
severity: medium
category: duplication
is_workaround: false
subsystem: "persistence helpers: src-tauri utils/fs + utils/migrate, agent fs + store_version, core::plugin stores"
evidence:
  - src-tauri/src/utils/fs.rs:23-40
  - agent/src/fs.rs:23-40
  - src-tauri/src/utils/migrate.rs:187
  - agent/src/store_version.rs:1-22
  - agent/src/store_version.rs:52-58
  - core/src/plugin/plugin_state.rs:189-194
  - core/src/plugin/plugin_state.rs:226-234
  - core/src/plugin/native_trust.rs:158-163
  - core/src/plugin/native_trust.rs:313-323
  - core/src/plugin/trust_store.rs:368-372
  - core/src/plugin/manager.rs:1460-1468
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`write_atomic` (temp file in the same directory, `sync_all`, then persist) is the same function in `src-tauri/src/utils/fs.rs:23` and `agent/src/fs.rs:23`, apart from error-string casing. The schema-version gate is also duplicated. `agent/src/store_version.rs` says it 'mirrors the desktop's src-tauri/src/utils/migrate.rs layer ... which cannot link against the desktop crate', yet both crates depend on core. A third copy of the flexible `version` reader is in `core::plugin::plugin_state::on_disk_version` (226-234). Meanwhile four core::plugin stores (`plugin_state::write`, `NativeTrustStore::save`, `TrustStore::save`, `manager::write_json_atomic`) each do their own `fs::write(path.with_extension("json.tmp"))` followed by `fs::rename`, with no `sync_all` before the rename. `native_trust` and `trust_store` also have no version gate and no corrupt-file backup: `NativeTrustStore::load` turns an unparseable file into `unwrap_or_default()`, and the next save overwrites it.

## Why it matters

The core::plugin copies lost the property the shared helper exists to provide. #2318/#2366 showed that a rename without a prior fsync can leave a zero-length or garbage file after power loss on filesystems with delayed allocation. For the native-plugin trust store and publisher pins that means silently losing the user's acknowledgments and pinned keys (fail-closed, but data loss). Their missing version gate means an older build also overwrites a newer build's trust document (PER-004 class). Having three copies of the layer is why a new store in a third crate picked up a weaker one.

## Recommendation

Move `write_atomic` and the versioned-store primitives (`read_version`, `check_version`/`guard_not_newer`, `backup_corrupt`, `NewerVersionError`) into `core::util::persist`. Make `src-tauri::utils::fs`, `utils::migrate` and `agent::store_version` thin re-exports or adapters. Switch the four core::plugin writers to the shared `write_atomic`, and have `native_trust`, `trust_store` and `plugin_state` go through the shared version gate and corrupt backup.

## Verification

Confirmed. write_atomic is identical in src-tauri/utils/fs.rs and agent/fs.rs except for error-string casing. agent/store_version.rs says it mirrors migrate.rs. plugin_state::write, NativeTrustStore::save, TrustStore::save and manager::write_json_atomic all do fs::write(tmp) + rename with no sync_all, and core has no shared write_atomic. NativeTrustStore::load turns parse errors into unwrap_or_default (documented as fail-closed, but a later save overwrites the corrupt file with no backup).
