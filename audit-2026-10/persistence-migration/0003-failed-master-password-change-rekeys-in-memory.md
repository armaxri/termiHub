---
id: PER2-003
title: "Failed master-password change leaves the vault re-keyed in memory, so the next credential save silently switches to the 'failed' password"
angle: persistence-migration
severity: medium
category: data-safety
is_workaround: false
subsystem: src-tauri/src/credential/master_password.rs
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src-tauri/src/credential/master_password.rs:417
  - src-tauri/src/credential/master_password.rs:431
  - src-tauri/src/credential/master_password.rs:442
  - src-tauri/src/credential/master_password.rs:449
  - src-tauri/src/credential/master_password.rs:560
  - src-tauri/src/credential/manager.rs:486
---

## What

`change_password` swaps the in-memory salt, derived key and KDF cost to the new password (lines 431-446) BEFORE calling `save_to_disk()` (line 449). If that write fails (disk full, permissions, AV lock), the error goes to the UI as 'Failed to re-encrypt credentials' and nothing is rolled back. The store stays unlocked with the NEW key while credentials.enc is still sealed with the OLD one. The next `set` or `remove` (line 560) calls save_to_disk and seals the vault under the new password. Biometric enrollment is only disabled on success (manager.rs:486-495), so it still wraps the old key.

## Why it matters

The user was told the password change failed and keeps using the old password. The next time they save a connection password, the vault is re-encrypted under a password they believe was rejected. At the next unlock the old password fails ('wrong password') and biometric unlock fails too. This is an effective lockout of every stored credential, triggered by a transient I/O error on a flow the project already knows is disk-pressure sensitive.

## Recommendation

Build the new salt, key and cost locally and seal and write the envelope from those values first, for example by factoring out `save_with(salt, key, cost)`. Swap the in-memory salt, key and cost only after write_atomic succeeds, and zeroize the new key on failure. Add a test: make the directory read-only, then check that change_password returns Err, that a following set() still writes with the old password, and that unlock(old) works.

## Verification

Confirmed at master_password.rs:417-450. The salt, derived key and kdf_cost are swapped in memory before save_to_disk(), and there is no rollback on Err. A later set() or remove() calls save_to_disk and seals the vault under the new key. manager.rs change_master_password returns early on the error (`?`), so biometric.disable() is skipped and the enrollment still wraps the old key. That leads to lockout after an I/O failure the user was told about as a failure.
