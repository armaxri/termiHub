---
id: PER2-007
title: "Per-entry salvage runs on un-migrated raw JSON; the 'all stores are v1 identity' assumption is now false"
angle: persistence-migration
severity: low
category: migration
is_workaround: false
subsystem: src-tauri/src/utils/migrate.rs
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src-tauri/src/utils/migrate.rs:275
  - src-tauri/src/utils/migrate.rs:394
  - src-tauri/src/schedules/config.rs:294
  - src-tauri/src/schedules/config.rs:296
  - src-tauri/src/schedules/history.rs:33
  - src-tauri/src/workflows/config.rs:506
  - src-tauri/src/workspace/config.rs:246
---

## What

On `LoadOutcome::Corrupt`, `load_store_with_recovery` calls `T::salvage(&raw, …)` with the ORIGINAL file text (migrate.rs:394). `salvage_list_store` validates entries against the CURRENT entry type and rebuilds the store from that un-migrated value. Its doc relies on 'all wired stores are schema v1 with identity migration' (migrate.rs:275). That is no longer true: schedules (v2, a real `migrate_v1_to_v2` that seeds `history`), workflows (v2) and workspaces (v2) all salvage.

## Why it matters

Today the concrete effect is small. A v1 schedules.json with one corrupt entry is salvaged without the v1→v2 step, so the surviving schedules lose their seeded attempt history; the next save stamps v2, so the seeding never runs. It is a latent trap, though: the first non-additive migration of a list store will make salvage drop EVERY old-shape entry as 'corrupt' (and persist that), which is the total-loss behavior PER-004 was meant to remove.

## Recommendation

In the Corrupt branch, when the raw JSON parses as an object with a readable version below CURRENT_VERSION, run `T::migrate(value, version)` first. Pass the migrated value to salvage, for example by changing `salvage` to take a `Value`. Update the stale doc comment, and add a test that salvages a v1 schedules.json with one corrupt entry and checks the survivors' history is seeded.

## Verification

Confirmed. load_store_with_recovery passes the raw text to T::salvage, and the doc comment on salvage_list_store still claims all wired stores are v1 identity, which is stale because ScheduleStore is v2 with a real migrate_v1_to_v2. A mitigating detail: the salvaged file is persisted with its original version ("1"), so the next launch does migrate and seed history, unless a save in the same session (which stamps v2) happens first. The concrete effect is minor. The main issue is the latent trap for a future non-additive list-store migration.
