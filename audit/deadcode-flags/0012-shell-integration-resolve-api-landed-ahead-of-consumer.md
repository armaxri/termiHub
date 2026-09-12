---
id: DEAD-012
title: shell_integration connection-resolution API landed ahead of a never-shipped consumer
angle: deadcode-flags
severity: medium
category: arch
is_workaround: false
subsystem: src-tauri/src/connection/shell_integration.rs
evidence:
  - src-tauri/src/connection/shell_integration.rs:257
  - src-tauri/src/connection/shell_integration.rs:282
  - src-tauri/src/connection/shell_integration.rs:315
status: open
---

## What
`ResolvedConnection` (enum), `resolve_connection()`, and `resolve_entry()` are a
complete, unit-tested connection-selector resolution API that has **no runtime
caller**. Each is `#[allow(dead_code)]` with a comment that its consumer — the
CLI-spawn handler — "lands in a later epic #1363 issue". That consumer has not shipped,
so this is a feature-model built without its feature.

## Why it matters
A whole config-resolution API compiled into the release binary with no path that
reaches it. It is not accidental residue — it is deliberately-landed-ahead-of-consumer
code — but for a workaround-free release it is dead weight until #1363's handler exists.
The `#[allow(dead_code)]` is the tell that it was known-dead at merge time.

## Evidence
- `shell_integration.rs:257` `#[allow(dead_code)] pub enum ResolvedConnection`
- `shell_integration.rs:282` `#[allow(dead_code)] pub fn resolve_connection(...)`
- `shell_integration.rs:315` `#[allow(dead_code)] fn resolve_entry(...)`
- Comments explicitly: "its runtime consumer (the CLI-spawn handler) lands in a later
  epic #1363 issue. It is fully exercised by the unit tests below."

## Recommendation
Decide per the release scope: if the CLI-spawn feature (#1363) is in v0.1.0, land its
handler so the API becomes live; if it is deferred, either remove this code until the
consumer is ready or accept it as tracked-dead and ensure #1363 is the single owning
issue. Do not leave it as an untracked `#[allow(dead_code)]` island. (This is the most
significant of several "stored for future" dead items — see DEAD-013 for the inventory.)
