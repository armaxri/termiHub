---
id: AGT-001
title: Remote file rename is broken — desktop sends {from,to}, agent requires {old_path,new_path}
angle: agent-protocol
severity: high
category: bug
is_workaround: false
subsystem: agent/src/handler/dispatch.rs, src-tauri/src/session/remote_proxy.rs
evidence:
  - agent/src/protocol/methods.rs:401
  - agent/src/handler/dispatch.rs:1239
  - src-tauri/src/session/remote_proxy.rs:598
status: open
---

## What
The `connection.files.rename` wire contract is mismatched between the two hand-maintained
sides. The agent's `FilesRenameParams` requires two **non-optional** snake_case fields
`old_path` and `new_path`; the desktop proxy sends `from` and `to`. Because the agent
parses with `params.parse::<FilesRenameParams>()` into required `String` fields, every
remote rename fails at deserialization with `-32602 Invalid params`. This is a **live**
bug, not a latent one — remote (agent-hosted) file rename never works.

## Why it matters
Renaming a file in the file browser of any agent-hosted connection silently fails for the
user. It is a functional break on a shipped feature path, and it is the canonical example
of the deeper structural risk: the ~70 RPC DTOs and ~40 method names have **no shared
crate and no compiler linkage** between agent and desktop, so this class of drift is
invisible to the build and only surfaces at runtime (see the wire-drift findings and the
code-duplication expert's report). On a ventilator-grade release, a whole family of these
can be latent.

## Evidence
Agent (authoritative), `agent/src/protocol/methods.rs:401`:
```rust
pub struct FilesRenameParams {
    pub connection_id: Option<String>,
    pub old_path: String,
    pub new_path: String,
}
```
Parsed unconditionally in `agent/src/handler/dispatch.rs:1239`:
```rust
module.register_async_method("connection.files.rename", |params, ctx, _ext| async move {
    let p: FilesRenameParams = params.parse()
        .map_err(|e| invalid_params("connection.files.rename", e))?;
```
Desktop (`src-tauri/src/session/remote_proxy.rs:598`):
```rust
async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
    ... "connection.files.rename", json!({ "from": from, "to": to, ... })
```
`from`/`to` never populate `old_path`/`new_path`; the required fields are absent → the
parse errors before any rename is attempted.

## Recommendation
Introduce a single shared protocol crate (or at minimum a shared serde-typed DTO module)
so the request/response types are defined once and both sides fail to compile on drift.
As an immediate fix, align the desktop to send `old_path`/`new_path` (or add
`#[serde(alias = "from")]`/`alias = "to"` on the agent as a stopgap while the shared crate
lands). Add a round-trip contract test that serializes the desktop request and deserializes
it with the agent DTO for every method.
