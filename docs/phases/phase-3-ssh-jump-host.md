# Phase 3: SSH Jump Host Sessions

**Status: Planned**

---

## Summary

Enable the agent to open SSH connections from its host to other targets, acting as a jump host. The desktop sends `session.create` with `type: "ssh"` and the agent establishes the SSH connection locally, running `ssh user@host` through a session daemon on a PTY.

This is a key capability from the agent concept — a developer can SSH into a build server with an agent, and from there reach internal hosts that aren't directly accessible from the desktop.

## Architecture

Same daemon architecture as shell/Docker sessions:
- Agent spawns a session daemon with `TERMIHUB_COMMAND=ssh` and appropriate args
- The daemon runs `ssh user@host` on a PTY
- Ring buffer captures output, Unix socket for IPC

## Key Design Points

- **No agent-on-agent**: The SSH target does NOT get its own agent deployed. The session is a plain SSH session managed by the originating agent.
- **Session persistence**: The SSH session survives desktop disconnect (daemon keeps running). It does NOT survive target host reboot (SSH connection drops).
- **Agent restart recovery**: The SSH session daemon survives, but the SSH connection may have timed out. Recovery is best-effort.
- **Monitoring**: When monitoring is subscribed for an SSH jump target, the agent runs monitoring commands (`top`, `free`, `df`) over the SSH connection and parses results locally.

## Protocol Types Needed

```rust
pub struct SshSessionConfig {
    pub host: String,
    pub port: Option<u16>,       // default: 22
    pub username: String,
    pub auth_method: String,     // "key", "password", "agent"
    pub key_path: Option<String>,
    pub shell: Option<String>,   // default: user's login shell on target
    pub cols: u16,
    pub rows: u16,
    pub env: HashMap<String, String>,
}
```

## Desktop-Side

The desktop already has SSH connection types. For agent SSH sessions, `remote_session.rs` needs an `"ssh"` arm that forwards SSH config fields to the agent.

## Dependencies

- Relies on daemon generalization from Phase 2 (Step 1: `TERMIHUB_COMMAND` support)
- May need SSH key forwarding or agent-local key management

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `agent/src/protocol/methods.rs` | Edit | Add `SshSessionConfig` |
| `agent/src/ssh/mod.rs` | New | SSH session module |
| `agent/src/ssh/backend.rs` | New | `SshBackend` (similar to DockerBackend) |
| `agent/src/session/types.rs` | Edit | Add `ssh_backend` field |
| `agent/src/session/manager.rs` | Edit | Wire SshBackend |
| `agent/src/state/persistence.rs` | Edit | Add SSH-specific persisted fields |
| `src-tauri/src/terminal/remote_session.rs` | Edit | Add `"ssh"` config forwarding |
