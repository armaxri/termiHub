# Phase 1: Shell Sessions

**Status: Completed**
**PR: [#209](https://github.com/armaxri/termiHub/pull/209) (merged)**
**Branch: `feature/agent-shell-sessions`**

---

## Summary

Implemented PTY-backed shell sessions in the remote agent using a session daemon architecture. Each shell session runs as an independent daemon process (`termihub-agent --daemon <session-id>`) that manages a PTY, ring buffer, and Unix domain socket. The agent connects to daemons as a client, forwarding I/O between the desktop (JSON-RPC) and the daemon (binary frame protocol).

## What Was Built

### 1. Shared Ring Buffer (`agent/src/buffer/ring_buffer.rs`)
- Moved from `serial/ring_buffer.rs` to shared `buffer/` module
- Used by both the session daemon and serial backend

### 2. Binary Frame Protocol (`agent/src/daemon/protocol.rs`)
- Length-prefixed frames: `[type: 1B][length: 4B BE][payload]`
- Message types: Input, Resize, Detach, Kill (agent→daemon), Output, BufferReplay, Exited, Error, Ready (daemon→agent)
- Both blocking (daemon) and async (agent) read/write functions

### 3. Session Daemon Process (`agent/src/daemon/process.rs`)
- Runs as `termihub-agent --daemon <session-id>`
- Config via environment variables: `TERMIHUB_SOCKET_PATH`, `TERMIHUB_SHELL`, `TERMIHUB_COLS`, `TERMIHUB_ROWS`, `TERMIHUB_ENV`
- Allocates PTY via `nix::pty::openpty`, spawns shell with `setsid()` + `TIOCSCTTY`
- Poll-based event loop: PTY master, socket listener, agent connection, child waitpid
- Sends BufferReplay + Ready on each new connection
- Handles Input, Resize, Detach, Kill frames from agent

### 4. ShellBackend (`agent/src/shell/backend.rs`)
- Agent-side daemon client
- `new()` — spawns daemon, waits for socket, connects, starts reader task
- `reconnect()` — connects to existing daemon (for recovery)
- `write_input()`, `resize()`, `attach()`, `detach()`, `close()`
- Background tokio reader task converts daemon frames to JSON-RPC notifications

### 5. State Persistence (`agent/src/state/persistence.rs`)
- `AgentState` / `PersistedSession` structs saved to `~/.config/termihub-agent/state.json`
- Tracks session type, title, daemon socket path, config
- Used for session recovery after agent restart

### 6. SessionManager Integration (`agent/src/session/manager.rs`)
- Shell session creation: parses `ShellConfig`, spawns `ShellBackend`, persists to state
- All operations wired: attach, detach, write_input, resize, close
- `recover_sessions()` on startup: loads state.json, reconnects to living daemons
- Platform-gated with `#[cfg(unix)]`

### 7. Integration Tests (`agent/tests/shell_integration.rs`)
- End-to-end tests via TCP transport
- Tests: create session, write input, verify output, resize, attach/detach, close, session recovery

## Commits

1. `4e09ba4` — refactor(backend): move ring buffer to shared buffer module
2. `2ac033a` — feat(backend): add daemon socket protocol for agent-daemon IPC
3. `62e8d16` — feat(backend): implement session daemon process for PTY management
4. `cfcd5bf` — feat(backend): implement ShellBackend as agent-side daemon client
5. `497cb47` — feat(backend): add agent state persistence for session recovery
6. `1ffbd17` — feat(backend): integrate ShellBackend into SessionManager
7. `5e4742a` — test(backend): add shell session integration tests
8. `37c3afe` — style(agent): fix clippy warnings and formatting
9. `7e3a3ce` — docs(agent): update CHANGELOG and manual tests for shell sessions

## Dependencies Added

```toml
nix = { version = "0.29", features = ["pty", "signal", "process", "term", "poll"] }
libc = "0.2"
```

## Platform Support

- Unix only (`#[cfg(unix)]`) — the daemon architecture uses PTY, Unix sockets, and POSIX process APIs
- Windows support would require ConPTY + named pipes (noted for future)
