---
id: PER-003
title: workflows.json (macros/workflows) is written non-atomically (torn write → total loss)
angle: persistence-migration
severity: high
category: bug
is_workaround: false
subsystem: src-tauri/src/workflows
evidence:
  - src-tauri/src/workflows/storage.rs:85
  - src-tauri/src/utils/fs.rs:23
status: in-progress
resolution: "#2737 — +4 more stores incl ssh/rdp trust also made atomic"
---

## What

`WorkflowStorage::save` writes user-authored macros/workflows with a plain, non-atomic `fs::write`
rather than the `write_atomic` temp-file+rename helper:

```rust
// src-tauri/src/workflows/storage.rs:82-86
pub fn save(&self, store: &WorkflowStore) -> Result<()> {
    let data = serde_json::to_string_pretty(store)...;
    fs::write(&self.file_path, data)...;   // <-- non-atomic, truncates in place
    Ok(())
}
```

`fs::write` truncates the file to zero (`O_TRUNC`) before writing the new bytes, so an interrupted
write (crash, power loss, full disk) leaves invalid/partial JSON on disk.

## Why it matters

Like the other stores, workflows load-with-recovery treats an unparseable file as corrupt and resets
it to defaults. A torn write therefore **destroys the user's entire macro/workflow library** on next
startup. Unlike session history, workflows/macros are **user-created content** — potentially hours of
hand-authored automation — so the blast radius is high. This is the same defect and fix as
#2318/#2320/#2366; this store was missed alongside session history (PER-002). The atomic helper
already exists (`utils/fs.rs:23`); the fix is a one-line swap.

## Evidence

- `workflows/storage.rs:85` — `fs::write(&self.file_path, data)`.
- `workflows/config.rs:130-141` — `WorkflowStore` with an unused `version: "1"` field; the load path
  resets to `Default` (empty) on parse failure.
- Every peer store uses `write_atomic` (see the list in PER-002).

## Recommendation

Route the save through `write_atomic(&self.file_path, &data)` and add a
`failed_save_preserves_previous_store` regression test mirroring `workspace/storage.rs:180`. Sweep
for any remaining production `fs::write` on a config file at the same time — after this and PER-002,
grep confirms these two are the only non-atomic config writes left outside test code.
</content>
