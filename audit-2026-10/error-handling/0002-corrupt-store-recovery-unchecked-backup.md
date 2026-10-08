---
id: ERR2-002
title: "Corrupt-store recovery ignores a failed .bak copy, still logs 'backed up to', then overwrites the only copy"
angle: error-handling
severity: low
category: data-loss
is_workaround: false
subsystem: "src-tauri persistence (utils/migrate, connection/tunnel/macros/embedded_servers storage)"
evidence:
  - src-tauri/src/utils/migrate.rs:390
  - src-tauri/src/utils/migrate.rs:396
  - src-tauri/src/utils/migrate.rs:414
  - src-tauri/src/connection/storage.rs:103
  - src-tauri/src/connection/storage.rs:104
  - src-tauri/src/tunnel/storage.rs:55
  - src-tauri/src/tunnel/storage.rs:68
  - src-tauri/src/macros/storage.rs:55
  - src-tauri/src/embedded_servers/storage.rs:105
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
---

## What

Every corrupt-file recovery path backs up with `let _ = fs::copy(path, path.with_extension("json.bak"))` and ignores the result. It then logs that the file was 'backed up to <path>'. After that it overwrites the live file with either the salvaged subset or the defaults. The paths are the shared load_store_with_recovery (migrate.rs:390) and the hand-rolled copies in connection/storage.rs:103, tunnel/storage.rs:55, macros/storage.rs:55 and embedded_servers/storage.rs:105.
If the copy fails, the overwrite still happens and the original bytes are gone. The copy can fail because the disk is full (a likely cause of the corruption in the first place), the directory is read-only or locked, or a .json.bak directory or locked file already exists.
There is also a single fixed .bak slot. A second corruption event overwrites the earlier backup, which may have been the only copy of entries that salvage dropped the first time.

## Why it matters

Salvage deliberately drops individually-corrupt entries, and reset drops everything. The .bak is the only way for the user (or support) to get that data back. connections.json holds the user's entire connection tree. When the backup step fails silently and the log and warning still claim the data was backed up, that is permanent, unacknowledged data loss in the one path built to prevent it. This is distinct from PER-004, which is about whether to reset; this finding is about the backup step being unchecked.

## Recommendation

1. Make the backup a checked precondition. If fs::copy fails, do not rewrite the live file: run on the salvaged or default data in memory only. Return a RecoveryWarning that says the backup failed and the original was left untouched, and arm the existing save guard so later saves do not clobber it.
2. Use a unique, timestamped backup name (e.g. connections.json.<ts>.bak, keeping the last N) so a later corruption cannot overwrite an earlier backup.
3. Fold the four hand-rolled copies into the shared load_store_with_recovery helper so the rule lives in one place.

## Verification

Confirmed. migrate.rs:390 and all four hand-rolled copies use `let _ = fs::copy(..)` and then log 'backed up to'. The worst cases are weaker than claimed. On a full disk or read-only directory, write_atomic fails as well, so the live file usually survives. What remains: the misleading log, the failure modes where the copy fails but the write succeeds (for example a directory or locked file at .json.bak), and the single fixed .bak slot that a second corruption overwrites. Real gap, but it needs a corruption event plus a second failure, so low.
