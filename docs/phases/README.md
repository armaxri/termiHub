# Agent Implementation Phases

The remote agent is being implemented incrementally. Each phase adds a major capability to the agent, building on the daemon architecture established in Phase 1.

See [docs/concepts/agent.md](../concepts/agent.md) for the full design concept.

---

## Phase Overview

| Phase | Name | Status | PR | Description |
|-------|------|--------|----|-------------|
| 1 | [Shell Sessions](phase-1-shell-sessions.md) | **Completed** | [#209](https://github.com/armaxri/termiHub/pull/209) | PTY-backed shell sessions via session daemon architecture |
| 2 | [Docker Container Sessions](phase-2-docker-sessions.md) | **Next** | — | Docker container sessions reusing daemon infrastructure |
| 3 | [SSH Jump Host Sessions](phase-3-ssh-jump-host.md) | Planned | — | SSH connections from agent to other hosts |
| 4 | [Prepared Connections & Folders](phase-4-prepared-connections.md) | Planned | — | Persistent connection definitions and folder organization |
| 5 | [File Browsing](phase-5-file-browsing.md) | Planned | — | Connection-scoped file browsing via RPC |
| 6 | [Monitoring](phase-6-monitoring.md) | Planned | — | CPU/memory/disk/network stats for agent host and jump targets |
| 7 | [Agent Deployment & Updates](phase-7-deployment.md) | Planned | — | Auto-deploy agent binary, version check, update flow |

---

## Architecture Foundation

All session types (shell, Docker, SSH) share the **session daemon architecture** built in Phase 1:

```
Agent Process                    Session Daemon (per session)
┌──────────────┐                ┌──────────────────────────┐
│ JSON-RPC     │  Unix Socket   │ PTY Master               │
│ Transport    │◄──────────────►│ Ring Buffer (1 MiB)      │
│              │  Binary Frame  │ Child Process (shell/     │
│ Session      │  Protocol      │   docker exec/ssh)       │
│ Manager      │                └──────────────────────────┘
└──────────────┘
```

Each daemon is a separate `termihub-agent --daemon <session-id>` process that:
- Allocates a PTY and spawns a child process
- Communicates with the agent via a Unix domain socket using a binary frame protocol
- Maintains a ring buffer for output replay on reattach
- Survives agent restarts (sessions are recovered from `state.json` + socket scan)

## Key Files (Current State)

```
agent/src/
├── buffer/ring_buffer.rs    # Shared ring buffer (used by daemon + serial)
├── daemon/
│   ├── protocol.rs          # Binary frame protocol (agent ↔ daemon IPC)
│   └── process.rs           # Session daemon main loop (PTY, poll, socket)
├── shell/backend.rs         # ShellBackend (agent-side daemon client)
├── session/
│   ├── manager.rs           # SessionManager (create, attach, close, recover)
│   ├── types.rs             # SessionInfo, SessionType, SessionSnapshot
│   └── definitions.rs       # Prepared connection definitions (basic)
├── serial/backend.rs        # SerialBackend (direct serial port access)
├── handler/dispatch.rs      # JSON-RPC method dispatcher
├── protocol/methods.rs      # Protocol types (ShellConfig, Capabilities, etc.)
├── state/persistence.rs     # AgentState for session recovery (state.json)
├── io/
│   ├── stdio.rs             # Stdio transport (SSH mode)
│   └── tcp.rs               # TCP transport (dev/test mode)
└── main.rs                  # Entry point (--stdio, --listen, --daemon)
```
