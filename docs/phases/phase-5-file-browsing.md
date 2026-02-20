# Phase 5: File Browsing

**Status: Implemented**

---

## Summary

Add connection-scoped file browsing through the agent via JSON-RPC. The agent resolves which filesystem to browse based on the connection type:

| Connection Type | Method |
|----------------|--------|
| Local shell | Agent reads local filesystem directly |
| SSH to target | Agent SFTPs to target, relays results via RPC |
| Docker | Agent execs into container to list/read files |
| Serial | Not applicable |

## Why RPC Over Direct SFTP

- **Uniform protocol** — All agent communication uses the same JSON-RPC channel
- **Jump host support** — Desktop can't SFTP to a target behind the agent; the agent relays
- **Security model** — File access inherits the agent's per-user isolation

## Protocol Methods

```
files.list    → List directory contents (scoped to a connection)
files.read    → Read file content
files.write   → Write file content
files.delete  → Delete a file or directory
files.rename  → Rename/move a file or directory
files.stat    → Get file metadata (size, permissions, modified time)
```

Each method takes a `connection_id` parameter to scope the operation.

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `agent/src/files/mod.rs` | New | File browsing module |
| `agent/src/files/local.rs` | New | Local filesystem operations |
| `agent/src/files/docker.rs` | New | Docker container filesystem (via docker exec) |
| `agent/src/files/ssh.rs` | New | SFTP relay for jump targets |
| `agent/src/protocol/methods.rs` | Edit | Add `files.*` method types |
| `agent/src/handler/dispatch.rs` | Edit | Wire file browsing handlers |

## Dependencies

- Phase 3 (SSH) for SFTP relay to jump targets
- Phase 4 (Prepared Connections) for connection_id scoping
- Desktop file browser UI needs adaptation to work through RPC
