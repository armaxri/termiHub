---
id: OBS-007
title: Credential-store migration failures are logged only at DEBUG, or not at all
angle: observability
severity: medium
category: bug
is_workaround: false
subsystem: src-tauri/src/commands/credential.rs
evidence:
  - src-tauri/src/commands/credential.rs:298
  - src-tauri/src/commands/credential.rs:308
status: fixed
resolution: "#2838 — per-credential migration failures now logged at WARN (key-only, no value); unconditional INFO summary already landed via TAURI-011 #2760. Return-status change → #2839"
---

## What
When switching credential-storage modes, per-credential migration failures are pushed into
a `warnings` Vec that is returned to the frontend, but they are **never logged** to the
tracing pipeline, and the only summary line is at **DEBUG** and gated on
`migrated_count > 0`:
```rust
for (key, value) in &credentials_to_migrate {
    match manager.set(key, value) {
        Ok(()) => migrated_count += 1,
        Err(e) => warnings.push(format!("Failed to migrate {}: {}", key, e)),  // not logged
    }
}
if migrated_count > 0 {
    debug!(migrated_count, warning_count = warnings.len(), "Credential migration complete"); // DEBUG, below file threshold
}
```
Consequences:
- The durable file log filters at **INFO+** (`file_log.rs` `FILE_LOG_DIRECTIVE = "info,..."`),
  so this `debug!` line **never reaches `termihub.log`** — a migration leaves no durable trace.
- If **every** credential fails to migrate (`migrated_count == 0` but `warnings` non-empty),
  **nothing at all** is logged — the worst case (total migration failure) is the most silent.
- The individual failure reasons live only in the returned `warnings` strings; once the
  frontend surfaces (or discards) them they are gone. This is exactly the "partial migration
  reports success" shape another expert flagged: the command returns `Ok(SwitchResult{ … })`
  with the mode persisted regardless of how many credentials were actually migrated.

## Why it matters
Credential migration touches secrets a user is relying on. A silent partial/total failure
means the next connection prompts for a password the user thought was saved, and there is no
durable log to explain that credentials were left behind in the old store. For a
safety-critical tool this failure must be reconstructable after the fact.

## Evidence
`credential.rs:298-306` — failures collected into `warnings`, never logged.
`credential.rs:308-314` — summary at `debug!` (below the INFO file threshold) and gated on
`migrated_count > 0`.

## Recommendation
Log each migration failure at **WARN** (`warn!(key = %key, error = %e, "credential migration
failed")` — key/type only, never the value, keeping the existing secret hygiene), and emit
an **INFO** summary unconditionally (`info!(migrated_count, warning_count, "credential
migration complete")`) so both success and any shortfall land in the durable file. Consider
returning a distinct non-success status when `warnings` is non-empty so the UI (and OBS-008
debug bundle) can reflect a partial migration rather than a bare success.
