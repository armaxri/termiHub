---
id: PER2-006
title: "Backup restore imports credentials immediately; if the startup swap later fails and rolls back, credentials stay changed although the UI says 'previous data was kept unchanged'"
angle: persistence-migration
severity: low
category: data-safety
is_workaround: false
subsystem: src-tauri/src/backup
status: fixed
resolution: "#4295 — a failed startup swap restores the pre-import vault copy; keychain stores get an accurate warning (#4414)"
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src-tauri/src/backup/commit.rs:304
  - src-tauri/src/backup/commit.rs:307
  - src-tauri/src/backup/commit.rs:323
  - src-tauri/src/backup/pending.rs:59
  - src-tauri/src/backup/pending.rs:316
---

## What

`restore::apply` writes the vault import and the legacy plaintext secrets into the live credential store (commit.rs:304-307), then commits the staged store files (commit.rs:323). Those files are applied only at the next start by `apply_pending_restore`. If that swap fails (manifest invalid, a write error) it rolls back every store file and reports 'Restoring the backup failed. Your previous data was kept unchanged.' (pending.rs:59, 316). The credential snapshots taken in `apply` are gone by then, so the credential changes are never reverted.

## Why it matters

The module promises a restore that is all-or-nothing across every chosen section. With the Overwrite strategy, a failed startup swap leaves current connections paired with the backup's passwords, or with extra orphaned credentials, while the user is told nothing changed. The window is narrow because it needs a failure at swap time, but the message is wrong.

## Recommendation

Either persist the credential snapshot, encrypted or as key-ids plus a sealed blob, into the pending dir so `apply_pending_restore` can revert it on rollback. Or defer the vault import until after a successful swap by sealing it into the pending dir and importing at next unlock. At minimum, change the failure warning to say that credentials from the backup were already imported.

## Verification

Confirmed. commit.rs applies the vault import and legacy secrets with in-memory CredentialSnapshot rollback only until staged.commit(). pending.rs apply_pending_restore at next start rolls back store files only, and failure_warning says 'Your previous data was kept unchanged.' Nothing there touches credentials. The window is narrow, but the message is inaccurate and the restore is not atomic across sections.
