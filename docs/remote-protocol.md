# Remote Session Management Protocol

Protocol specification for communication between the termiHub desktop app and remote Raspberry Pi agents.

**Version**: 0.1.0
**Status**: Draft
**Issue**: #17

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Transport Layer](#transport-layer)
4. [Message Format](#message-format)
5. [Protocol Versioning](#protocol-versioning)
6. [Methods](#methods)
7. [Notifications](#notifications)
8. [Session State Schema](#session-state-schema)
9. [Error Codes](#error-codes)
10. [Examples](#examples)
11. [Security Considerations](#security-considerations)

---

## Overview

The remote session management protocol enables the termiHub desktop app to manage persistent terminal sessions on a remote Raspberry Pi agent. Sessions survive desktop disconnects, allowing users to reconnect to long-running processes (overnight test runs, serial monitoring) without losing state.

### Goals

- **Persistent sessions**: Shell and serial sessions run on the agent and survive desktop disconnects
- **Transparent proxying**: The `RemoteBackend` implements `TerminalBackend`, so remote sessions behave identically to local ones from the UI's perspective
- **Simple framing**: Newline-delimited JSON over an SSH channel — no custom TCP listeners or TLS setup
- **Reconnect support**: Attach to existing sessions after a disconnect, receiving buffered or live output

### Non-Goals

- File transfer (handled by existing SFTP infrastructure)
- Agent discovery (the user configures the SSH host manually)
- Multi-user access to the same agent (single-user assumed)

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Desktop App                     │
│                                                  │
│  ┌──────────────┐     ┌──────────────────────┐  │
│  │ Terminal UI   │────▶│ RemoteBackend        │  │
│  │ (xterm.js)   │◀────│ (TerminalBackend)    │  │
│  └──────────────┘     └──────────┬───────────┘  │
│                                  │               │
│                          JSON-RPC messages        │
│                                  │               │
│                       ┌──────────▼───────────┐   │
│                       │ SSH Channel          │   │
│                       │ (ssh2 crate)         │   │
│                       └──────────┬───────────┘   │
└──────────────────────────────────┼───────────────┘
                                   │ SSH tunnel
                                   │
┌──────────────────────────────────┼───────────────┐
│               Raspberry Pi Agent │               │
│                       ┌──────────▼───────────┐   │
│                       │ Protocol Handler     │   │
│                       │ (JSON-RPC dispatch)  │   │
│                       └──────────┬───────────┘   │
│                                  │               │
│                  ┌───────────────┼────────────┐  │
│                  │               │            │  │
│          ┌───────▼──┐   ┌───────▼──┐  ┌──────▼─┐│
│          │ PTY      │   │ PTY      │  │ Serial ││
│          │ Session 1│   │ Session 2│  │ Proxy  ││
│          └──────────┘   └──────────┘  └────────┘│
│                                                  │
│                  ┌──────────────────┐            │
│                  │ SQLite DB        │            │
│                  │ (session state)  │            │
│                  └──────────────────┘            │
└──────────────────────────────────────────────────┘
```

### Component Roles

| Component | Role |
|-----------|------|
| **RemoteBackend** | Desktop-side `TerminalBackend` implementation that translates trait calls into JSON-RPC requests |
| **SSH Channel** | Transport layer — the desktop opens an SSH exec channel to the agent binary |
| **Protocol Handler** | Agent-side dispatcher that parses JSON-RPC messages and routes to session manager |
| **Session Manager** | Creates/destroys PTY and serial sessions, manages attach/detach |
| **SQLite DB** | Persists session metadata so sessions survive agent restarts |

---

## Transport Layer

### Connection Setup

1. The desktop opens an SSH connection to the Raspberry Pi using the configured credentials (reusing the existing `ssh2` crate infrastructure)
2. The desktop opens an exec channel running the agent binary: `termihub-agent --stdio`
3. The agent reads JSON-RPC messages from **stdin** and writes responses/notifications to **stdout**
4. The agent writes diagnostic logs to **stderr** (not part of the protocol)

### Framing

Messages are **newline-delimited JSON** (NDJSON). Each message is a single line of valid JSON terminated by `\n` (0x0A).

```
{"jsonrpc":"2.0","method":"initialize","params":{...},"id":1}\n
{"jsonrpc":"2.0","result":{...},"id":1}\n
{"jsonrpc":"2.0","method":"session.output","params":{...}}\n
```

**Rules:**
- Messages MUST NOT contain unescaped newlines within the JSON
- Messages MUST be valid UTF-8
- Binary data (terminal output) MUST be base64-encoded
- The maximum message size is 1 MiB (1,048,576 bytes)

### Connection Lifecycle

1. **Connect**: Desktop opens SSH exec channel
2. **Initialize**: Desktop sends `initialize` request; agent responds with capabilities
3. **Operate**: Desktop sends requests; agent sends responses and notifications
4. **Disconnect**: Desktop closes the SSH channel (sessions keep running on agent)
5. **Reconnect**: Desktop opens a new channel, sends `initialize`, then `session.list` + `session.attach`

---

## Message Format

The protocol uses [JSON-RPC 2.0](https://www.jsonrpc.org/specification).

### Request (Desktop → Agent)

```json
{
  "jsonrpc": "2.0",
  "method": "session.create",
  "params": { ... },
  "id": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `jsonrpc` | `"2.0"` | Protocol version (always `"2.0"`) |
| `method` | `string` | Method name |
| `params` | `object` | Method parameters |
| `id` | `integer` | Request identifier (monotonically increasing per connection) |

### Response (Agent → Desktop)

**Success:**
```json
{
  "jsonrpc": "2.0",
  "result": { ... },
  "id": 1
}
```

**Error:**
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32001,
    "message": "Session not found",
    "data": { "session_id": "abc-123" }
  },
  "id": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `result` | `any` | Success payload (mutually exclusive with `error`) |
| `error.code` | `integer` | Error code (see [Error Codes](#error-codes)) |
| `error.message` | `string` | Human-readable error description |
| `error.data` | `object?` | Optional structured error context |

### Notification (Agent → Desktop)

Notifications have **no `id` field** and do not expect a response.

```json
{
  "jsonrpc": "2.0",
  "method": "session.output",
  "params": { ... }
}
```

---

## Protocol Versioning

### Version Negotiation

The desktop sends its supported protocol version in the `initialize` request. The agent responds with the version it will use.

**Rules:**
- Protocol versions follow [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`)
- **Major** version changes indicate breaking changes — the agent MUST reject incompatible major versions
- **Minor** version changes add new methods or optional fields — backwards compatible
- **Patch** version changes are bug fixes — no protocol impact
- The agent selects the highest compatible version it supports (matching major, up to its minor)

### Compatibility Matrix

| Desktop Version | Agent Version | Compatible? |
|----------------|---------------|-------------|
| 0.1.0 | 0.1.0 | Yes |
| 0.1.0 | 0.2.0 | Yes (agent uses 0.1.x features only) |
| 0.2.0 | 0.1.0 | Yes (desktop degrades gracefully) |
| 1.0.0 | 0.1.0 | No (major mismatch) |

---

## Methods

### `initialize`

Handshake that establishes the protocol version and exchanges capabilities.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "protocol_version": "0.1.0",
    "client": "termihub-desktop",
    "client_version": "0.1.0"
  },
  "id": 1
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "protocol_version": "0.1.0",
    "agent_version": "0.1.0",
    "capabilities": {
      "session_types": ["shell", "serial"],
      "max_sessions": 20
    }
  },
  "id": 1
}
```

| Param | Type | Description |
|-------|------|-------------|
| `protocol_version` | `string` | Requested protocol version |
| `client` | `string` | Client identifier |
| `client_version` | `string` | Client application version |

| Result Field | Type | Description |
|-------------|------|-------------|
| `protocol_version` | `string` | Negotiated protocol version |
| `agent_version` | `string` | Agent binary version |
| `capabilities.session_types` | `string[]` | Supported session types |
| `capabilities.max_sessions` | `integer` | Maximum concurrent sessions |

**Errors:**
- `-32002` Version not supported

---

### `session.create`

Create a new persistent session on the agent.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "session.create",
  "params": {
    "type": "shell",
    "config": {
      "shell": "/bin/bash",
      "cols": 80,
      "rows": 24,
      "env": {
        "TERM": "xterm-256color"
      }
    },
    "title": "Build session"
  },
  "id": 2
}
```

For serial sessions:
```json
{
  "jsonrpc": "2.0",
  "method": "session.create",
  "params": {
    "type": "serial",
    "config": {
      "port": "/dev/ttyUSB0",
      "baud_rate": 115200,
      "data_bits": 8,
      "stop_bits": 1,
      "parity": "none",
      "flow_control": "none"
    },
    "title": "Serial monitor"
  },
  "id": 2
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "title": "Build session",
    "type": "shell",
    "status": "running",
    "created_at": "2026-02-14T10:30:00Z"
  },
  "id": 2
}
```

| Param | Type | Description |
|-------|------|-------------|
| `type` | `"shell" \| "serial"` | Session type |
| `config` | `object` | Type-specific configuration (see below) |
| `title` | `string?` | Optional display title |

**Shell config fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `shell` | `string?` | Agent default | Shell binary path |
| `cols` | `integer` | `80` | Initial column count |
| `rows` | `integer` | `24` | Initial row count |
| `env` | `object?` | `{}` | Additional environment variables |

**Serial config fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | `string` | *(required)* | Serial port path |
| `baud_rate` | `integer` | `115200` | Baud rate |
| `data_bits` | `integer` | `8` | Data bits (5, 6, 7, or 8) |
| `stop_bits` | `integer` | `1` | Stop bits (1 or 2) |
| `parity` | `string` | `"none"` | Parity (`"none"`, `"odd"`, `"even"`) |
| `flow_control` | `string` | `"none"` | Flow control (`"none"`, `"software"`, `"hardware"`) |

**Errors:**
- `-32003` Session creation failed
- `-32004` Session limit reached
- `-32005` Invalid configuration

---

### `session.list`

List all sessions on the agent.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "session.list",
  "params": {},
  "id": 3
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "sessions": [
      {
        "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        "title": "Build session",
        "type": "shell",
        "status": "running",
        "created_at": "2026-02-14T10:30:00Z",
        "last_activity": "2026-02-14T12:45:30Z",
        "attached": false
      }
    ]
  },
  "id": 3
}
```

| Result Field | Type | Description |
|-------------|------|-------------|
| `sessions` | `SessionInfo[]` | List of all sessions |
| `sessions[].session_id` | `string` | UUID session identifier |
| `sessions[].title` | `string` | Display title |
| `sessions[].type` | `string` | `"shell"` or `"serial"` |
| `sessions[].status` | `string` | `"running"` or `"exited"` |
| `sessions[].created_at` | `string` | ISO 8601 creation timestamp |
| `sessions[].last_activity` | `string` | ISO 8601 last I/O timestamp |
| `sessions[].attached` | `boolean` | Whether a client is currently attached |

---

### `session.attach`

Attach to a session to receive its output stream. The agent begins sending `session.output` notifications for this session.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "session.attach",
  "params": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
  },
  "id": 4
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "status": "running"
  },
  "id": 4
}
```

After a successful attach, the agent immediately begins streaming output via `session.output` notifications.

**Errors:**
- `-32001` Session not found

---

### `session.detach`

Stop receiving output for a session without closing it. The session keeps running.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "session.detach",
  "params": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
  },
  "id": 5
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {},
  "id": 5
}
```

**Errors:**
- `-32001` Session not found

---

### `session.input`

Send input data to a session (keystrokes, pasted text).

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "session.input",
  "params": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "data": "bHMgLWxhCg=="
  },
  "id": 6
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {},
  "id": 6
}
```

| Param | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Target session UUID |
| `data` | `string` | Base64-encoded input bytes |

**Errors:**
- `-32001` Session not found
- `-32006` Session not running

---

### `session.resize`

Resize the PTY for a shell session.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "session.resize",
  "params": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "cols": 120,
    "rows": 40
  },
  "id": 7
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {},
  "id": 7
}
```

| Param | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Target session UUID |
| `cols` | `integer` | New column count (1–500) |
| `rows` | `integer` | New row count (1–500) |

**Errors:**
- `-32001` Session not found
- `-32006` Session not running
- `-32005` Invalid configuration (for serial sessions, which have no PTY)

---

### `session.close`

Terminate a session and release its resources.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "session.close",
  "params": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
  },
  "id": 8
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {},
  "id": 8
}
```

The agent sends a `session.exit` notification before the response if the session was still running.

**Errors:**
- `-32001` Session not found

---

### `health.check`

Check agent health and connectivity. Can be used as a keepalive.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "health.check",
  "params": {},
  "id": 9
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "status": "ok",
    "uptime_secs": 86400,
    "active_sessions": 3
  },
  "id": 9
}
```

| Result Field | Type | Description |
|-------------|------|-------------|
| `status` | `string` | Always `"ok"` if the agent is responsive |
| `uptime_secs` | `integer` | Agent process uptime in seconds |
| `active_sessions` | `integer` | Number of running sessions |

---

### `connections.list`

List all saved connections and folders.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "connections.list",
  "params": {},
  "id": 10
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "connections": [
      {
        "id": "conn-a1b2c3d4",
        "name": "Build Shell",
        "session_type": "shell",
        "config": { "shell": "/bin/bash" },
        "persistent": true,
        "folder_id": "folder-x1y2z3"
      }
    ],
    "folders": [
      {
        "id": "folder-x1y2z3",
        "name": "Project A",
        "parent_id": null,
        "is_expanded": true
      }
    ]
  },
  "id": 10
}
```

| Result Field | Type | Description |
|-------------|------|-------------|
| `connections` | `Connection[]` | All saved connections |
| `connections[].id` | `string` | Connection identifier |
| `connections[].name` | `string` | Display name |
| `connections[].session_type` | `string` | `"shell"`, `"serial"`, `"docker"`, or `"ssh"` |
| `connections[].config` | `object` | Type-specific configuration |
| `connections[].persistent` | `boolean` | Whether sessions are persistent |
| `connections[].folder_id` | `string?` | Parent folder ID, or `null` for root |
| `folders` | `Folder[]` | All folders |
| `folders[].id` | `string` | Folder identifier |
| `folders[].name` | `string` | Display name |
| `folders[].parent_id` | `string?` | Parent folder ID, or `null` for root |
| `folders[].is_expanded` | `boolean` | Whether expanded in UI |

---

### `connections.create`

Create a new saved connection.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "connections.create",
  "params": {
    "name": "Build Shell",
    "type": "shell",
    "config": { "shell": "/bin/bash" },
    "persistent": true,
    "folder_id": "folder-x1y2z3"
  },
  "id": 11
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "id": "conn-a1b2c3d4",
    "name": "Build Shell",
    "session_type": "shell",
    "config": { "shell": "/bin/bash" },
    "persistent": true,
    "folder_id": "folder-x1y2z3"
  },
  "id": 11
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | *(required)* | Display name |
| `type` | `string` | *(required)* | Session type |
| `config` | `object` | `{}` | Type-specific configuration |
| `persistent` | `boolean` | `false` | Whether sessions are persistent |
| `folder_id` | `string?` | `null` | Parent folder ID |

---

### `connections.update`

Update an existing connection's properties. Only provided fields are changed.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "connections.update",
  "params": {
    "id": "conn-a1b2c3d4",
    "name": "Renamed Shell",
    "folder_id": null
  },
  "id": 12
}
```

**Response:** Same shape as `connections.create` response, with updated values.

| Param | Type | Description |
|-------|------|-------------|
| `id` | `string` | *(required)* Connection ID to update |
| `name` | `string?` | New display name |
| `type` | `string?` | New session type |
| `config` | `object?` | New configuration |
| `persistent` | `boolean?` | New persistent flag |
| `folder_id` | `value?` | New folder ID. Explicit `null` moves to root; omit to leave unchanged |

**Errors:**
- `-32008` Connection not found

---

### `connections.delete`

Delete a saved connection.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "connections.delete",
  "params": {
    "id": "conn-a1b2c3d4"
  },
  "id": 13
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {},
  "id": 13
}
```

**Errors:**
- `-32008` Connection not found

---

### `connections.folders.create`

Create a new folder for organizing connections.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "connections.folders.create",
  "params": {
    "name": "Project A",
    "parent_id": null
  },
  "id": 14
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "id": "folder-x1y2z3",
    "name": "Project A",
    "parent_id": null,
    "is_expanded": false
  },
  "id": 14
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | *(required)* | Folder name |
| `parent_id` | `string?` | `null` | Parent folder ID for nesting |

---

### `connections.folders.update`

Update a folder's properties. Only provided fields are changed.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "connections.folders.update",
  "params": {
    "id": "folder-x1y2z3",
    "name": "Renamed Folder",
    "is_expanded": true
  },
  "id": 15
}
```

**Response:** Same shape as `connections.folders.create` response, with updated values.

| Param | Type | Description |
|-------|------|-------------|
| `id` | `string` | *(required)* Folder ID to update |
| `name` | `string?` | New folder name |
| `parent_id` | `value?` | New parent. Explicit `null` moves to root; omit to leave unchanged |
| `is_expanded` | `boolean?` | New expanded state |

**Errors:**
- `-32009` Folder not found

---

### `connections.folders.delete`

Delete a folder. Connections and subfolders inside it are moved to the root level.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "connections.folders.delete",
  "params": {
    "id": "folder-x1y2z3"
  },
  "id": 16
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {},
  "id": 16
}
```

**Errors:**
- `-32009` Folder not found

---

## Notifications

Notifications are messages from the agent to the desktop with **no `id` field**. The desktop MUST NOT send a response.

### `session.output`

Terminal output data from a session the desktop is attached to.

```json
{
  "jsonrpc": "2.0",
  "method": "session.output",
  "params": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "data": "dG90YWwgMTYKZHJ3eHIteHIteCA..."
  }
}
```

| Param | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Source session UUID |
| `data` | `string` | Base64-encoded output bytes |

**Delivery semantics:**
- Output is streamed as it arrives — no batching guarantees
- If the desktop disconnects while a session produces output, that output is lost (the agent does not buffer indefinitely)
- A future protocol version may add a scrollback buffer or replay mechanism

### `session.exit`

A session's process has exited.

```json
{
  "jsonrpc": "2.0",
  "method": "session.exit",
  "params": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "exit_code": 0
  }
}
```

| Param | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Exited session UUID |
| `exit_code` | `integer?` | Exit code if available (`null` for signals or serial disconnects) |

### `session.error`

A session-level error that does not necessarily terminate the session.

```json
{
  "jsonrpc": "2.0",
  "method": "session.error",
  "params": {
    "session_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "message": "Serial port /dev/ttyUSB0 temporarily unavailable"
  }
}
```

| Param | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Affected session UUID |
| `message` | `string` | Human-readable error description |

---

## Session State Schema

The agent persists session metadata in a SQLite database so sessions survive agent restarts. The process state itself (PTY, serial port) cannot survive a restart — only the metadata is preserved to allow the UI to show what was running.

### `sessions` Table

```sql
CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,           -- UUID v4
    type        TEXT NOT NULL,              -- "shell" or "serial"
    title       TEXT NOT NULL,              -- Display title
    status      TEXT NOT NULL DEFAULT 'running', -- "running" or "exited"
    config      TEXT NOT NULL,              -- JSON blob of session config
    exit_code   INTEGER,                   -- Exit code (NULL if still running or unknown)
    created_at  TEXT NOT NULL,             -- ISO 8601 timestamp
    last_activity TEXT NOT NULL            -- ISO 8601 timestamp, updated on I/O
);
```

### Session State JSON (in `config` column)

For shell sessions:
```json
{
  "shell": "/bin/bash",
  "cols": 120,
  "rows": 40,
  "env": {
    "TERM": "xterm-256color"
  }
}
```

For serial sessions:
```json
{
  "port": "/dev/ttyUSB0",
  "baud_rate": 115200,
  "data_bits": 8,
  "stop_bits": 1,
  "parity": "none",
  "flow_control": "none"
}
```

### Lifecycle

1. **On `session.create`**: Insert row with `status = "running"`
2. **On I/O activity**: Update `last_activity` timestamp
3. **On process exit**: Update `status = "exited"`, set `exit_code`
4. **On `session.close`**: Delete the row
5. **On agent restart**: Mark all `status = "running"` rows as `status = "exited"` (processes were lost), then report them in `session.list` so the desktop can show what happened

---

## Error Codes

### Standard JSON-RPC Errors

| Code | Message | Description |
|------|---------|-------------|
| `-32700` | Parse error | Invalid JSON |
| `-32600` | Invalid request | Not a valid JSON-RPC request |
| `-32601` | Method not found | Unknown method name |
| `-32602` | Invalid params | Invalid method parameters |
| `-32603` | Internal error | Unexpected agent error |

### Application Errors

| Code | Message | Description |
|------|---------|-------------|
| `-32001` | Session not found | No session with the given ID |
| `-32002` | Version not supported | Protocol version mismatch |
| `-32003` | Session creation failed | Could not create the session (e.g., shell binary not found, serial port open failed) |
| `-32004` | Session limit reached | Agent has reached `max_sessions` |
| `-32005` | Invalid configuration | Invalid config values (e.g., invalid baud rate, negative cols/rows) |
| `-32006` | Session not running | Session exists but has exited |
| `-32008` | Connection not found | No connection with the given ID |
| `-32009` | Folder not found | No folder with the given ID |

---

## Examples

### Workflow: Create and Use a Shell Session

```
Desktop → Agent:
{"jsonrpc":"2.0","method":"initialize","params":{"protocol_version":"0.1.0","client":"termihub-desktop","client_version":"0.1.0"},"id":1}

Agent → Desktop:
{"jsonrpc":"2.0","result":{"protocol_version":"0.1.0","agent_version":"0.1.0","capabilities":{"session_types":["shell","serial"],"max_sessions":20}},"id":1}

Desktop → Agent:
{"jsonrpc":"2.0","method":"session.create","params":{"type":"shell","config":{"shell":"/bin/bash","cols":80,"rows":24,"env":{"TERM":"xterm-256color"}},"title":"Build session"},"id":2}

Agent → Desktop:
{"jsonrpc":"2.0","result":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","title":"Build session","type":"shell","status":"running","created_at":"2026-02-14T10:30:00Z"},"id":2}

Desktop → Agent:
{"jsonrpc":"2.0","method":"session.attach","params":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"},"id":3}

Agent → Desktop:
{"jsonrpc":"2.0","result":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","status":"running"},"id":3}

Agent → Desktop (notification — shell prompt):
{"jsonrpc":"2.0","method":"session.output","params":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","data":"dXNlckBwaSA6fiAkIA=="}}

Desktop → Agent (user types "ls -la\n"):
{"jsonrpc":"2.0","method":"session.input","params":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","data":"bHMgLWxhCg=="},"id":4}

Agent → Desktop:
{"jsonrpc":"2.0","result":{},"id":4}

Agent → Desktop (notification — command output):
{"jsonrpc":"2.0","method":"session.output","params":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","data":"dG90YWwgMTYKZHJ3eHIteHIteCAyIHVzZXIgdXNlciA0MDk2IEZlYiAxNCAxMDozMCAuCg=="}}
```

### Workflow: Reconnect After Disconnect

```
Desktop → Agent (new SSH channel):
{"jsonrpc":"2.0","method":"initialize","params":{"protocol_version":"0.1.0","client":"termihub-desktop","client_version":"0.1.0"},"id":1}

Agent → Desktop:
{"jsonrpc":"2.0","result":{"protocol_version":"0.1.0","agent_version":"0.1.0","capabilities":{"session_types":["shell","serial"],"max_sessions":20}},"id":1}

Desktop → Agent:
{"jsonrpc":"2.0","method":"session.list","params":{},"id":2}

Agent → Desktop:
{"jsonrpc":"2.0","result":{"sessions":[{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","title":"Build session","type":"shell","status":"running","created_at":"2026-02-14T10:30:00Z","last_activity":"2026-02-14T12:45:30Z","attached":false}]},"id":2}

Desktop → Agent (reattach to existing session):
{"jsonrpc":"2.0","method":"session.attach","params":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"},"id":3}

Agent → Desktop:
{"jsonrpc":"2.0","result":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","status":"running"},"id":3}

Agent → Desktop (notification — live output resumes):
{"jsonrpc":"2.0","method":"session.output","params":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","data":"dXNlckBwaSA6fiAkIA=="}}
```

### Workflow: Session Process Exits

```
Agent → Desktop (notification — process exited):
{"jsonrpc":"2.0","method":"session.exit","params":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","exit_code":0}}

Desktop → Agent (clean up):
{"jsonrpc":"2.0","method":"session.close","params":{"session_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"},"id":10}

Agent → Desktop:
{"jsonrpc":"2.0","result":{},"id":10}
```

---

## Security Considerations

### Transport Security

The protocol relies entirely on the SSH transport for encryption and authentication. No additional encryption or authentication layer is implemented at the protocol level.

- **Encryption**: All messages are encrypted by the SSH channel
- **Authentication**: SSH key-based or password authentication (same as existing SSH connections in termiHub)
- **Authorization**: The agent trusts any client that successfully authenticates over SSH — no additional authorization model

### Agent Security

- The agent binary runs as a regular user (not root)
- Sessions run with the agent user's permissions
- Serial port access requires appropriate group membership (e.g., `dialout` on Linux)
- The SQLite database should be readable only by the agent user (`chmod 600`)
- The agent MUST validate all input parameters (session IDs, config values, PTY sizes) before acting on them

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Eavesdropping | SSH encryption |
| MITM attack | SSH host key verification (handled by `ssh2` crate) |
| Unauthorized access | SSH authentication |
| Malicious input | Input validation on agent side |
| Resource exhaustion | `max_sessions` limit, message size limit |
