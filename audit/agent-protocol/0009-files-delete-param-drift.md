---
id: AGT-009
title: Remote file delete is broken — desktop omits the required isDirectory field and sends connection_id where the agent expects connectionId
angle: agent-protocol
severity: high
category: bug
is_workaround: false
subsystem: agent/src/protocol/methods.rs, src-tauri/src/session/remote_proxy.rs
evidence:
  - agent/src/protocol/methods.rs:392
  - agent/src/handler/dispatch.rs:1231
  - src-tauri/src/session/remote_proxy.rs:586
status: fixed
resolution: "#2752 — delete params aligned"
---

## What
`connection.files.delete` has two independent wire drifts in one message:

1. **Missing required field (LIVE break).** `FilesDeleteParams`
   (`agent/src/protocol/methods.rs:392`) requires `isDirectory: bool` with no
   `#[serde(default)]`. The desktop's `delete()` (`src-tauri/src/session/remote_proxy.rs:586`)
   sends only `{connection_id, path}`. `isDirectory` is absent → `params.parse()` fails →
   `-32602 Invalid params`. Remote file delete always errors. Ironically the handler
   discards the value (`let _ = p.is_directory;`, `dispatch.rs:1231`) — it needs the field
   to *parse* but not its value, so `#[serde(default)]` would have hidden this.

2. **Casing asymmetry (LATENT).** `FilesDeleteParams` is the **only** files DTO carrying
   `#[serde(rename_all = "camelCase")]`, so it expects `connectionId`. The desktop sends
   `connection_id` (snake), matching its five sibling methods
   (`list`/`read`/`write`/`stat`/`mkdir`) which all use snake on both sides. Here the
   connection scope silently deserializes to `None` — masked only because the field is
   `Option`.

## Why it matters
A second confirmed live break on the `connection.files.*` family, same root cause as
AGT-001: hand-rebuilt params drifting from required snake_case agent fields with no
compiler linkage. Two of the six file operations are broken; the pattern says more may be.

## Evidence
- `agent/src/protocol/methods.rs:392` — `#[serde(rename_all="camelCase")]` +
  `is_directory: bool` (required).
- `agent/src/handler/dispatch.rs:1231` — `let _ = p.is_directory;` (value discarded).
- `src-tauri/src/session/remote_proxy.rs:586` — sends `{connection_id, path}` only.

## Recommendation
Have the desktop send `isDirectory` and `connectionId` (or drop the lone
`#[serde(rename_all="camelCase")]` on `FilesDeleteParams` so it matches its siblings, and
add the missing field). Add a serialize→deserialize round-trip contract test per method,
and move to a shared DTO crate so this class of drift breaks the build (see AGT-001).
