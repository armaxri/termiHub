---
id: PER-009
title: Dangling workspace→connection references are silently preserved, never validated
angle: persistence-migration
severity: low
category: reliability
is_workaround: false
subsystem: src-tauri/src/workspace
evidence:
  - src-tauri/src/workspace/manager.rs:300
  - src-tauri/src/workspace/manager.rs:309
  - src-tauri/src/workspace/manager.rs:267
status: open
---

## What

Workspaces persist each tab's `connection_ref`. On save, refs are translated from connection **id**
to connection **name** (`replace_connection_ids_with_names`, `manager.rs:267`); on load they are
translated back name→id (`resolve_connection_names_to_ids`, `manager.rs:300`). When the referenced
connection no longer exists, the name→id lookup falls back to keeping the raw string:

```rust
// manager.rs:309-314
connection_ref: tab.connection_ref.as_ref().map(|name| {
    name_to_id.get(name).cloned().unwrap_or_else(|| name.clone())
}),
```

So a workspace that references a connection the user has since **deleted** (or that lived in an
external connection file that is now absent) keeps a **dangling reference** — no warning, no
validation, no cleanup. There is no referential-integrity pass across the persisted stores.

## Why it matters

Restoring such a workspace tries to open a connection that does not exist. Behaviour then depends on
the restore/open path (best case: an empty/errored tab; worse: the raw name is treated as an id
downstream). It is not data-*loss*, but it is a silent integrity drift that accumulates as users
delete connections, and it gives the user no signal that a saved workspace is now partially broken.
Referential consistency between the workspace store and the connection store is simply not checked.

## Evidence

- `manager.rs:309-314` — missing name silently retained as the ref (`unwrap_or_else(|| name.clone())`).
- No validation/warning is emitted for a ref that resolves to nothing; contrast the recovery-warning
  machinery that exists for corrupt entries elsewhere.

## Recommendation

On workspace load (and/or on connection delete), validate `connection_ref`s against the live
connection set: either mark the tab as "connection missing" with a visible warning (the restore-mode
types already carry an `unreachable`/reason concept, `core/src/restore_mode.rs:250`), or offer to
prune the dead reference. At minimum, surface a recovery-style warning rather than silently carrying
a dangling id/name.
</content>
