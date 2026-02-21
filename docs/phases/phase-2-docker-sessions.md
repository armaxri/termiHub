# Phase 2: Docker Container Sessions

**Status: Not Started (next up)**
**Branch: TBD** (will be `feature/agent-docker-sessions`)

---

## Summary

Add Docker container sessions to the agent, reusing the session daemon architecture from Phase 1. The desktop already has `SessionType::Docker` with Docker-specific config fields (`docker_image`, `docker_env_vars`, `docker_volumes`, etc.) in `RemoteSessionConfig`, and the agent has `SessionType::Docker` defined as a stub. This phase implements real Docker container sessions.

## Architecture

Docker sessions use a **two-phase container + daemon** approach:

1. **Container creation**: Agent runs `docker run -d --init --name termihub-<session-id> [options] <image> tail -f /dev/null` to create a persistent detached container
2. **Interactive session**: Agent spawns a session daemon that runs `docker exec -it termihub-<session-id> <shell>` on its PTY instead of a login shell
3. **Container outlives daemon**: The container's main process is `tail -f /dev/null`, so it keeps running even if the daemon dies or the agent restarts
4. **Recovery**: On agent restart, check if container is still running via `docker inspect`, spawn a new daemon with a fresh `docker exec`
5. **Close**: Kill daemon + `docker stop` + optionally `docker rm` (based on `remove_on_exit`)

```
Desktop                        Agent                          Docker
┌──────────┐  JSON-RPC   ┌──────────────┐              ┌───────────────┐
│ termiHub │◄────────────►│ DockerBackend│              │ Container     │
│ Desktop  │  session.*   │              │──docker run──►│ (detached,   │
└──────────┘              │              │              │  tail -f)     │
                          │              │              └───────────────┘
                          └──────┬───────┘
                                 │ spawns
                          ┌──────▼───────┐  Unix Socket  ┌──────────────┐
                          │ Session      │◄─────────────►│ docker exec  │
                          │ Daemon       │  binary frame  │ -it <shell>  │
                          │ (same as     │               │ (on PTY)     │
                          │  Phase 1)    │               └──────────────┘
                          └──────────────┘
```

### Key Design Decision: Why Two Phases?

Running `docker run -it` directly through the daemon would kill the container when the daemon dies (PTY closes -> SIGHUP). By separating the container lifecycle (`docker run -d ... tail -f /dev/null`) from the interactive session (`docker exec -it`), the container survives daemon death. Recovery is just spawning a new daemon with a new `docker exec`.

## Implementation Plan

### Step 1: Generalize Daemon for Arbitrary Commands

Currently `DaemonConfig` has a `shell: String` field and `spawn_shell()` runs a login shell. Generalize to support running any command (e.g., `docker exec -it <container> <shell>`).

**Changes to `agent/src/daemon/process.rs`:**
- Add `command: Option<String>` and `command_args: Vec<String>` to `DaemonConfig`
- Read from `TERMIHUB_COMMAND` and `TERMIHUB_COMMAND_ARGS` env vars
- Add `spawn_command()` function that runs an arbitrary command on the PTY (instead of a login shell)
- When `command` is set, use `spawn_command()` instead of `spawn_shell()`
- When `command` is not set, fall back to existing `spawn_shell()` behavior (backward compatible)

### Step 2: Add DockerConfig to Protocol

**New structs in `agent/src/protocol/methods.rs`:**

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct DockerConfig {
    pub image: String,
    pub shell: Option<String>,           // default: /bin/sh
    pub cols: u16,                       // default: 80
    pub rows: u16,                       // default: 24
    pub env_vars: Vec<DockerEnvVar>,     // default: []
    pub volumes: Vec<DockerVolumeMount>, // default: []
    pub working_directory: Option<String>,
    pub remove_on_exit: bool,            // default: true
    pub env: HashMap<String, String>,    // terminal env (TERM, etc.)
}

#[derive(Debug, Clone, Deserialize)]
pub struct DockerEnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DockerVolumeMount {
    pub host_path: String,
    pub container_path: String,
    pub read_only: bool,
}
```

### Step 3: Create DockerBackend

**New file: `agent/src/docker/backend.rs`**

```rust
pub struct DockerBackend {
    session_id: String,
    container_name: String,
    remove_on_exit: bool,
    // Embeds or delegates to a daemon client (same pattern as ShellBackend)
    socket_path: PathBuf,
    writer: Arc<Mutex<Option<OwnedWriteHalf>>>,
    reader_task: Option<tokio::task::JoinHandle<()>>,
    alive: Arc<AtomicBool>,
    notification_tx: NotificationSender,
}
```

Key methods:
- `new(session_id, config: &DockerConfig, notification_tx)` — Create container via `docker run -d`, spawn daemon with `TERMIHUB_COMMAND=docker`, connect
- `reconnect(session_id, container_name, socket_path, notification_tx)` — Check container via `docker inspect`, spawn new daemon, connect
- `write_input()`, `resize()`, `attach()`, `detach()`, `close()` — Same interface as ShellBackend
- `close()` — Kill daemon + `docker stop` + optionally `docker rm`

**Container creation command:**
```bash
docker run -d --init \
  --name termihub-<session-id> \
  -e KEY=VALUE ...           # from env_vars
  -v /host:/container:ro ... # from volumes
  -w /workdir               # from working_directory
  <image> \
  tail -f /dev/null
```

**Daemon invocation:**
```bash
TERMIHUB_COMMAND=docker \
TERMIHUB_COMMAND_ARGS='["exec","-it","termihub-<session-id>","/bin/sh"]' \
termihub-agent --daemon <session-id>
```

### Step 4: Wire into SessionManager

**Changes to `agent/src/session/types.rs`:**
- Add `#[cfg(unix)] pub docker_backend: Option<DockerBackend>` to `SessionInfo`

**Changes to `agent/src/session/manager.rs`:**
- In `create()`: add Docker branch — parse `DockerConfig`, create `DockerBackend`
- Wire `docker_backend` into `attach()`, `detach()`, `write_input()`, `resize()`, `close()`

### Step 5: State Persistence for Docker

**Changes to `agent/src/state/persistence.rs`:**
- Add `container_name: Option<String>` to `PersistedSession`
- Add `remove_on_exit: Option<bool>` to `PersistedSession`

**Recovery logic in `recover_sessions()`:**
- For Docker sessions: check if container still running via `docker inspect`
- If running: spawn new daemon with `docker exec`, reconnect
- If stopped: mark session as dead, optionally `docker rm`

### Step 6: Desktop-Side Config Forwarding

**Changes to `src-tauri/src/terminal/remote_session.rs`:**
- Add `"docker"` arm in the match statement (currently falls through to `_ =>` shell default)
- Forward `docker_image`, `docker_env_vars`, `docker_volumes`, `docker_working_directory`, `docker_remove_on_exit` from `RemoteSessionConfig` to the agent's `session.create` config

### Step 7: Refactor Shared Daemon Client Code (Optional)

Extract shared code between `ShellBackend` and `DockerBackend`:
- `connect_and_start_reader()` — already a free function in `shell/backend.rs`
- `wait_for_socket()` — same
- `send_output_notification()` — same
- Reader loop logic — same

Could move to `agent/src/daemon/client.rs` as a reusable `DaemonClient` struct.

### Step 8: Tests

- Unit tests for `DockerConfig` deserialization
- Integration tests (require Docker): create Docker session, write input, verify output, close
- Recovery tests: create session, kill daemon, verify container still running, recover

## Desktop-Side Types (Already Exist)

These types in `src-tauri/src/terminal/backend.rs` already define the Docker config model:

```rust
// RemoteSessionConfig fields:
pub docker_image: Option<String>,
pub docker_env_vars: Option<Vec<EnvVar>>,
pub docker_volumes: Option<Vec<VolumeMount>>,
pub docker_working_directory: Option<String>,
pub docker_remove_on_exit: Option<bool>,

// Supporting types:
pub struct EnvVar { pub key: String, pub value: String }
pub struct VolumeMount { pub host_path: String, pub container_path: String, pub read_only: bool }
```

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `agent/src/daemon/process.rs` | Edit | Add `command`/`command_args` to DaemonConfig, add `spawn_command()` |
| `agent/src/protocol/methods.rs` | Edit | Add `DockerConfig`, `DockerEnvVar`, `DockerVolumeMount` |
| `agent/src/docker/mod.rs` | New | `pub mod backend;` |
| `agent/src/docker/backend.rs` | New | `DockerBackend` struct |
| `agent/src/session/types.rs` | Edit | Add `docker_backend` field |
| `agent/src/session/manager.rs` | Edit | Wire DockerBackend into create/attach/close/etc. |
| `agent/src/state/persistence.rs` | Edit | Add `container_name`, `remove_on_exit` fields |
| `agent/src/main.rs` | Edit | Add `mod docker;` |
| `agent/src/handler/dispatch.rs` | Edit | (if any Docker-specific dispatch needed) |
| `src-tauri/src/terminal/remote_session.rs` | Edit | Add `"docker"` config forwarding arm |
| `agent/src/daemon/client.rs` | New (optional) | Shared daemon client extracted from ShellBackend |

## Verification

```bash
# Unit tests
cd agent && cargo test

# Clippy
cd agent && cargo clippy --all-targets --all-features -- -D warnings

# Full project checks
./scripts/test.sh
./scripts/check.sh

# Manual test (requires Docker)
cd agent && cargo run -- --listen 127.0.0.1:7685
# Send JSON-RPC:
# session.create {"type":"docker","config":{"image":"ubuntu:22.04","shell":"/bin/bash","cols":80,"rows":24}}
# session.attach {"session_id":"<id>"}
# session.input {"session_id":"<id>","data":"<base64 of 'echo hello\n'>"}
# Expect session.output with shell output from inside container
```

## Platform

- Unix only (`#[cfg(unix)]`) — same as Phase 1
- Requires Docker to be installed and accessible on the agent host
- Agent reports `docker_available: bool` in capabilities (already implemented)
