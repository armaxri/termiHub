---
id: TAURI-011
title: switch_credential_store silently skips unreadable credentials → apparent credential loss on mode switch
angle: backend-tauri-rust
severity: medium
category: bug
is_workaround: false
subsystem: commands/credential
evidence:
  - src-tauri/src/commands/credential.rs:253
  - src-tauri/src/commands/credential.rs:256
  - src-tauri/src/commands/credential.rs:267
status: open
---

## What

`switch_credential_store` migrates existing credentials from the current store to the new one
by reading them all, switching the backend, then re-writing them. The read step is
best-effort and silently drops anything it cannot read:

```rust
let keys_to_migrate = manager.list_keys().unwrap_or_default();      // :253  errors → empty
let mut credentials_to_migrate = Vec::new();
for key in &keys_to_migrate {
    if let Ok(Some(value)) = manager.get(key) {                      // :256  Err/None → skipped
        credentials_to_migrate.push((key.clone(), value));
    }
}
…
manager.switch_store(target_mode.clone())?;                          // :267  point of no return
```

If the source store is momentarily unreadable — e.g. `list_keys()` errors (→ `unwrap_or_default`
yields an empty list), or a master-password store that is *locked* or transiently erroring so
`get()` returns `Err`/`None` for entries — the migration collects **zero (or a subset of)**
credentials, then proceeds to switch the backend anyway. The result reported to the user is a
successful switch with `migrated_count: 0` and no warnings (warnings are only pushed on
*write* failures, `:302`, never on *read* skips). The credentials still exist in the old
store's file, but the active mode has moved on and they appear lost.

## Why it matters

Credentials are the highest-stakes user data in the app. A switch that silently migrates a
subset (or none) while reporting success is a data-loss-shaped bug: the user believes their
saved passwords/passphrases moved, reconnects fail, and there is no warning pointing at what
happened. The failure is most likely exactly when it matters — a store that is locked or having
trouble is precisely when you should *not* silently proceed.

## Evidence

- `commands/credential.rs:253` — `list_keys().unwrap_or_default()` turns a read error into "no
  keys to migrate".
- `commands/credential.rs:256` — `if let Ok(Some(value))` silently skips any key that errors or
  returns `None`.
- `commands/credential.rs:294-306` — warnings are collected only for write (`set`) failures;
  read skips are invisible.
- `commands/credential.rs:267` — `switch_store` runs regardless of how many creds were collected.

## Recommendation

Make migration all-or-nothing and loud about read failures:

- Require the source store to be unlocked/healthy before switching; if `list_keys()` errors or
  any `get()` returns `Err`, abort the switch with a clear error rather than proceeding.
- Distinguish "no credentials to migrate" (genuinely empty) from "could not read source" and
  refuse the latter.
- Only delete/abandon the old store's data after the new store confirms every credential was
  written; on any per-key write failure, surface it *and* keep the old store intact so the user
  can retry. Include read-skip counts in the returned `warnings`.
</content>
