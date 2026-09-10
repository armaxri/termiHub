---
id: DUP-008
title: Saved-connection / folder definitions modeled separately in agent, desktop, and TS
angle: code-duplication
severity: medium
category: arch
is_workaround: false
subsystem: agent/session/definitions.rs vs src-tauri/connection/config.rs vs src/types/connection.ts
evidence:
  - agent/src/session/definitions.rs:10
  - agent/src/session/definitions.rs:69
  - src-tauri/src/connection/config.rs:248
  - src-tauri/src/connection/config.rs:274
  - src/types/connection.ts:37
status: open
---

## What

The "saved connections + folders + on-disk JSON store" domain is modeled independently in three
places:

- Agent: `Connection` (`session_type`, untyped `config: Value`, `persistent`, `folder_id`,
  `terminal_options: Option<Value>`, `icon`), `Folder`, `ConnectionSnapshot`/`FolderSnapshot`,
  `ConnectionStore` + `ConnectionStoreApi` — `agent/src/session/definitions.rs`.
- Desktop: `SavedConnection` (typed `ConnectionConfig`, typed `TerminalOptions`, `folder_id`,
  `icon`), `ConnectionFolder`, `ConnectionStore`, `FlatConnectionStore` —
  `src-tauri/src/connection/config.rs`.
- Frontend: `SavedConnection`, `ConnectionFolder` — `src/types/connection.ts`.

`Folder` / `ConnectionFolder` are **field-for-field identical** (`id`, `name`, `parent_id`,
`is_expanded`). `Connection` / `SavedConnection` have **already diverged**: the agent keeps
`config` untyped and calls the discriminator `session_type`, while the desktop uses a typed
`ConnectionConfig` enum and (elsewhere) `type_id` / `connection_type` (see DUP-014 for the
field-name drift).

## Why it matters

Both Rust stores serialize connections/folders to JSON on disk and both exchange them over the
protocol (`connection.create`/`connection.list`, agent connection sync). The folder shape in
particular must round-trip between desktop and agent. Three hand-maintained models of one user
concept is a standing drift surface; the config/discriminator split already differs.

Note the agent's choice to keep `config: serde_json::Value` untyped is actually *good* — it avoids
duplicating the whole typed `ConnectionConfig` enum and defers typing to the shared
`core::connection` registry. The duplication is in the *envelope* (connection/folder/store), not the
per-type config.

## Evidence

- `agent/src/session/definitions.rs:10` (`Connection`), `:69` (`Folder`), `:169`
  (`ConnectionStore`), `:34`/`:82` (snapshots).
- `src-tauri/src/connection/config.rs:248` (`SavedConnection`), `:274` (`ConnectionFolder`), `:178`
  (`ConnectionStore`), `:285` (`FlatConnectionStore`).
- `src/types/connection.ts:37` (`SavedConnection`), `:48` (`ConnectionFolder`).

## Recommendation

Define the connection/folder envelope + snapshots + a generic JSON `ConnectionStore` once in
`core::connection` (e.g. `core::connection::definition`). The desktop keeps its typed
`ConnectionConfig` as the `config` payload; the agent keeps it as `Value`. The TS mirror is the
frontend contract — best addressed by the codegen recommendation in DUP-030.
