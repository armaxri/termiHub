---
id: PER2-005
title: "connections.json and external connection files drop unknown top-level fields on save; external files are rewritten on load with no version gate"
angle: persistence-migration
severity: low
category: migration
is_workaround: false
subsystem: src-tauri/src/connection
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: previous-incomplete
previous_id: PER-010
evidence:
  - src-tauri/src/connection/config.rs:278
  - src-tauri/src/connection/config.rs:389
  - src-tauri/src/connection/storage.rs:245
  - src-tauri/src/connection/manager.rs:1593
  - src-tauri/src/connection/manager.rs:1622
  - src-tauri/src/connection/manager.rs:1741
  - src-tauri/src/connection/credential_scope.rs:338
---

## What

`ConnectionStore` (config.rs:278) and `ExternalConnectionStore` (config.rs:389) have no top-level `#[serde(flatten)] extra`. Node and agent entries got one (#2311/#3947), but `save_flat` rebuilds the top level from scratch (storage.rs:245-252). External connection files are never version-checked: they parse straight into ExternalConnectionStore (manager.rs:1593). Several paths rewrite them as hard-coded `version: "2"`: type-id migration and password stripping (manager.rs:1622-1626), every place/remove (manager.rs:1741), and `stamp_file_id`, which runs merely on resolving the file's credential scope (credential_scope.rs:338-347).

## Why it matters

External files are the team-sharing mechanism, so they are the most likely to be opened by mixed termiHub versions. Any additive top-level field a newer build writes to them is silently erased the first time an older build stamps a fileId or saves a connection. A file a newer build marks with a higher version is downgraded to "2" without any refusal. connections.json is gated, but its additive top-level keys are erased the same way by a same-version save. This is the PER-010 gap left at the store's top level.

## Recommendation

Add `#[serde(flatten, default, skip_serializing_if = "Map::is_empty")] extra` to ConnectionStore and ExternalConnectionStore. Carry it through FlatConnectionStore, or use `read_unknown_fields` in save_flat as wol_storage does. Before any external-file rewrite, read the version and refuse (keep it read-only, as for connections.json) when it is newer than the current external format. Preserve the file's own version string instead of hard-coding "2".

## Verification

Confirmed. ConnectionStore (config.rs:278) and ExternalConnectionStore (config.rs:389) have no top-level flatten extra. save_flat rebuilds the top level. The external-file load path parses with no version check and rewrites with a hard-coded version "2" on type-id or password migration. One correction: stamp_file_id round-trips the file's own version string rather than hard-coding "2", but it still drops unknown top-level fields. The impact is mostly limited to additive top-level fields.
