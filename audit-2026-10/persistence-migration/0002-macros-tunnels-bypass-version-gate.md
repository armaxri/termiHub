---
id: PER2-002
title: "macros.json and tunnels.json bypass the version gate, guard_not_newer and unknown-field preservation"
angle: persistence-migration
severity: medium
category: migration
is_workaround: false
subsystem: src-tauri/src/macros, src-tauri/src/tunnel, src-tauri/src/backup
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: previous-incomplete
previous_id: PER-001
evidence:
  - src-tauri/src/macros/storage.rs:35
  - src-tauri/src/macros/storage.rs:46
  - src-tauri/src/macros/storage.rs:54
  - src-tauri/src/macros/storage.rs:103
  - src-tauri/src/tunnel/storage.rs:35
  - src-tauri/src/tunnel/storage.rs:103
  - src-tauri/src/macros/config.rs:52
  - src-tauri/src/tunnel/config.rs:228
  - src-tauri/src/backup/sections.rs:246
  - src-tauri/src/backup/sections.rs:252
  - src-tauri/src/connection/credential_scope.rs:141
  - src-tauri/src/connection/credential_scope.rs:171
---

## What

Every other JSON store goes through `VersionedStore` with load_store_with_recovery and calls guard_not_newer on save. MacroStorage and TunnelStorage still use the pre-PER-001 hand-rolled loader. They parse straight into the typed struct with no version read (macros/storage.rs:46). Any parse failure counts as corruption: the file is backed up to `.json.bak`, salvaged or reset, and the result is written back (storage.rs:54-95). `save` (storage.rs:103) has no guard_not_newer. `MacroStore` and `TunnelStore` have no `#[serde(flatten)] extra` (config.rs:52, tunnel/config.rs:228). In backup, both are 'plain stores' (sections.rs:246) normalized through a typed round-trip, so a restore drops their unknown fields too. connection-file-scopes.json does the same thing more mildly: it ignores a newer-version state (credential_scope.rs:141), and its next `save` re-stamps v1 over it (:171).

## Why it matters

Both files existed before #2746 but were never wired in, so for user-authored macros and tunnels PER-001/004/010 are still unfixed. A future schema bump for either store gets no downgrade protection: an older build sees a v2 file as 'corrupt', salvages or resets it, and overwrites the newer file. The `.bak` is replaced on the next corruption. Even same-version additive fields written by a newer build are erased by any older-build save or by a backup restore. These stores carry `CURRENT_VERSION` consts only for the backup, which gives a false impression of being version-safe.

## Recommendation

Implement `VersionedStore` for MacroStore and TunnelStore, with STORE_NAME, CURRENT_VERSION and `salvage` delegating to salvage_list_store. Replace the bespoke load_with_recovery with `load_store_with_recovery`. Call `guard_not_newer` at the top of `save`. Add `#[serde(flatten, default)] extra: Map<String, Value>` to both store structs. Move them from `plain_store!` to `normalize_versioned` in backup/sections.rs. For FileScopes, make `save` refuse when the on-disk version is newer. Add the standard newer_version_file_is_left_intact and unknown-field round-trip tests.

## Verification

Confirmed. macros/storage.rs and tunnel/storage.rs still use a hand-rolled load_with_recovery: a direct typed parse with no version read, and any parse failure goes to .bak, then salvage or reset, then write-back. save() calls write_atomic with no guard_not_newer. MacroStore and TunnelStore have no flatten extra. backup/sections.rs lists both in plain_store! (normalize_plain refuses a newer version on restore, but the typed round-trip drops unknown fields). FileScopes::load ignores a newer state, and save() re-stamps STATE_VERSION. I found no ADR excluding these stores. Today it is latent because both are v1 and additive fields still parse, but the unknown-field loss is real now.
