# Phase 4: Prepared Connections & Folders

**Status: Planned**

---

## Summary

Implement the full prepared connections and folder model on the agent — persistent, reusable connection configurations organized in a folder hierarchy. The agent already has basic `session.define` / `session.definitions.list` / `session.definitions.delete` methods (see `agent/src/session/definitions.rs`), but the full concept calls for a richer model matching the desktop's connection store: named connections, folder hierarchy, and the ability to create sessions from saved definitions.

## Current State

The agent already has:
- `SessionDefinition` struct in `agent/src/session/definitions.rs`
- `DefinitionStore` for persistence to `sessions.json`
- `session.define`, `session.definitions.list`, `session.definitions.delete` JSON-RPC methods
- Basic fields: `id`, `name`, `session_type`, `config`, `persistent`

## What's Needed

### Folder Support
- Add folder model: `id`, `name`, `parent_id`, `is_expanded`
- Folder CRUD methods: `connections.folders.create`, `connections.folders.update`, `connections.folders.delete`
- Store folders alongside connections in `connections.json`

### Enhanced Connection Model
- Add `folder_id` field to connect definitions to folders
- Add terminal options (font, colors, etc.) per connection
- Rename methods to `connections.*` namespace (from `session.definitions.*`)

### Default Shell Connection
- On first run, auto-create a "Default Shell" prepared connection
- Uses the host's default shell

### Protocol Methods

```
connections.list           → List all connections and folders
connections.create         → Create a prepared connection
connections.update         → Update a connection's config
connections.delete         → Delete a connection
connections.folders.create → Create a folder
connections.folders.update → Rename/move a folder
connections.folders.delete → Delete a folder
```

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `agent/src/session/definitions.rs` | Edit | Add folder model, folder_id, rename to connections |
| `agent/src/protocol/methods.rs` | Edit | Add `connections.*` method types |
| `agent/src/handler/dispatch.rs` | Edit | Wire new `connections.*` handlers |
| `docs/remote-protocol.md` | Edit | Document new methods |

## Dependencies

- Phases 1-3 for the session types that connections reference
- Desktop sidebar refactor (separate sections per agent) — desktop-side work
