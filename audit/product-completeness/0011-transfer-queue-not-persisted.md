---
id: PROD-011
title: Transfer queue is not persisted across app restart
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/files/transfer
evidence:
  - src-tauri/src/lib.rs:371
  - src-tauri/src/files/transfer/registry.rs:279
status: open
---

## What
The transfer registry is created fresh in memory each launch with only a TTL retention
window; there is no load/save to disk. Queued/failed transfers do not survive a restart.

## Why it matters
Users expect an interrupted or queued transfer to be remembered (to resume or retry) after a
crash or restart. Combined with SFTP having no resume at all (PROD-012), a dropped large
transfer is lost work.

## Evidence
- `src-tauri/src/lib.rs:371` — `TransferRegistry::new()` with no load-from-disk.
- `src-tauri/src/files/transfer/registry.rs:279-333, 421-451` — in-memory maps + TTL only; no serde persistence.

## Recommendation
Persist queue entries (at least failed/incomplete) to app-data and reload on startup, marking
them resumable/retryable.
