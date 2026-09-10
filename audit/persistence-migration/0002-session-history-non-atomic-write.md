---
id: PER-002
title: session-history.json is written non-atomically (torn write → total history loss)
angle: persistence-migration
severity: medium
category: bug
is_workaround: false
subsystem: src-tauri/src/session_history
evidence:
  - src-tauri/src/session_history/storage.rs:90
  - src-tauri/src/session_history/storage.rs:49
  - src-tauri/src/utils/fs.rs:23
status: open
---

## What

`SessionHistoryStorage::save` writes with a plain `fs::write`, **not** the atomic temp-file+rename
`write_atomic` helper that every other config store uses:

```rust
// src-tauri/src/session_history/storage.rs:86-92
pub fn save(&self, store: &SessionHistoryStore) -> Result<()> {
    let data = serde_json::to_string_pretty(store)...;
    fs::write(&self.file_path, data)...;   // <-- non-atomic, O_TRUNC in place
    Ok(())
}
```

`fs::write` opens the destination with `O_TRUNC`, truncating it to zero **before** writing. A crash,
power loss, or full disk mid-write leaves a truncated/partial file that is invalid JSON.

## Why it matters

The load path (`storage.rs:49`) is "parse or reset": on any parse failure it backs the file up to
`.bak` and **resets session history to empty defaults**. So a torn write is not a partial loss — it
is a **total** loss of the browsable session history on next startup. This is exactly the data-loss
class that #2318/#2320/#2366 fixed for connections, workspaces, last-session, settings, and agent
state by routing them through `write_atomic` — this store (and workflows, PER-003) was simply
missed. `write_atomic` already exists and is documented (`utils/fs.rs:23`) precisely to prevent this.

Severity is medium rather than high only because session history is convenience/recall data (not
credentials or user-authored automation) and the loss requires a crash mid-write.

## Evidence

- `session_history/storage.rs:90` — `fs::write(&self.file_path, data)`.
- Contrast `workspace/storage.rs:89`, `connection/storage.rs:172`, `connection/settings.rs:496`,
  `workspace/last_session.rs:96`, `agent/src/state/persistence.rs:119` — all use `write_atomic`.
- `session_history/storage.rs:56-77` — parse failure resets to `SessionHistoryStore::default()`
  (empty entries), so a torn write wipes all history.

## Recommendation

Replace the `fs::write` with `write_atomic(&self.file_path, &data)` (add
`use crate::utils::fs::write_atomic;`), matching the other stores. Add the same
`failed_save_preserves_previous_store` regression test the sibling stores already carry (see
`workspace/storage.rs:180`).
</content>
