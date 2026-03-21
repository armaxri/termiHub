# Rlogin and RSH Protocol Support

> GitHub Issue: [#523](https://github.com/armaxri/termiHub/issues/523)

## Overview

Add Rlogin (Remote Login) and RSH (Remote Shell) protocol support to termiHub, enabling connections to legacy Unix systems that still rely on these older remote access protocols.

**Motivation**: While largely superseded by SSH, Rlogin and RSH are still encountered in legacy Unix/AIX/HP-UX environments, industrial control systems, older network equipment, and isolated lab networks. MobaXterm supports both protocols. Adding Rlogin and RSH improves termiHub's compatibility with legacy infrastructure, positioning it as a comprehensive terminal hub for heterogeneous environments.

**Key goals**:

- **Legacy compatibility**: Connect to systems that only offer Rlogin or RSH access
- **Familiar workflow**: Same connection editor, tab management, and terminal experience as other protocols
- **Prominent security warnings**: Both protocols transmit credentials in plaintext — the UI must make this risk unmistakable
- **Minimal complexity**: Straightforward TCP-based protocols, similar in implementation effort to the existing Telnet backend

### Protocol Summary

| Aspect           | Rlogin                              | RSH                                                |
| ---------------- | ----------------------------------- | -------------------------------------------------- |
| **RFC**          | RFC 1282                            | Based on BSD rsh/rcmd protocol                     |
| **Default port** | 513                                 | 514                                                |
| **Purpose**      | Interactive remote login (terminal) | Remote command execution                           |
| **Auth model**   | `.rhosts` trust + username          | `.rhosts` trust + username                         |
| **Encryption**   | None — plaintext                    | None — plaintext                                   |
| **Resize**       | Yes (urgent TCP data, 0x80 flag)    | No                                                 |
| **Interactive**  | Yes (full terminal session)         | Primarily command-based, can be used interactively |

## UI Interface

### Connection Editor

Rlogin and RSH appear as new connection types in the Connection Editor's type selector dropdown, alongside Local, SSH, Telnet, Serial, Docker, and WSL.

#### Rlogin Connection Editor

```
┌─────────────────────────────────────────────────────────────────┐
│ Connection Type: [Rlogin ▾]                                     │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ⚠ SECURITY WARNING                                         │ │
│ │ Rlogin transmits all data including credentials in plain-   │ │
│ │ text. Do not use over untrusted networks. Consider SSH      │ │
│ │ as a secure alternative.                                    │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ─── Connection ───                                              │
│ Name:            [Production AIX Server   ]                     │
│ Host:            [aix-prod.internal.local ]                     │
│ Port:            [513      ]                                    │
│                                                                 │
│ ─── Authentication ───                                          │
│ Remote Username: [operator                ]                     │
│ Local Username:  [arne                    ]  (auto-detected)    │
│                                                                 │
│ ─── Terminal ───                                                │
│ Terminal Type:   [xterm-256color ▾]                              │
│ Terminal Speed:  [38400/38400     ]  (baud rate sent to server)  │
│                                                                 │
│                                    [Test Connection]  [Save]    │
└─────────────────────────────────────────────────────────────────┘
```

Fields:

- **Host** (required): Hostname or IP address of the remote system
- **Port** (required, default: 513): TCP port
- **Remote Username** (required): Username to log in as on the remote system
- **Local Username** (optional, auto-detected): Local username sent during handshake; defaults to the current OS user
- **Terminal Type** (optional, default: `xterm-256color`): Terminal emulation type sent to the server
- **Terminal Speed** (optional, default: `38400/38400`): Baud rate string sent during Rlogin handshake

#### RSH Connection Editor

```
┌─────────────────────────────────────────────────────────────────┐
│ Connection Type: [RSH ▾]                                        │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ⚠ SECURITY WARNING                                         │ │
│ │ RSH transmits all data including credentials in plaintext.  │ │
│ │ Do not use over untrusted networks. Consider SSH as a       │ │
│ │ secure alternative.                                         │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ─── Connection ───                                              │
│ Name:            [Legacy Build Server     ]                     │
│ Host:            [build01.lab.internal    ]                     │
│ Port:            [514      ]                                    │
│                                                                 │
│ ─── Authentication ───                                          │
│ Remote Username: [builder                 ]                     │
│ Local Username:  [arne                    ]  (auto-detected)    │
│                                                                 │
│ ─── Execution ───                                               │
│ Command:         [                        ]  (optional)         │
│ ☐ Interactive mode (allocate PTY-like session if no command)    │
│                                                                 │
│                                    [Test Connection]  [Save]    │
└─────────────────────────────────────────────────────────────────┘
```

Fields:

- **Host** (required): Hostname or IP address
- **Port** (required, default: 514): TCP port
- **Remote Username** (required): Username on the remote system
- **Local Username** (optional, auto-detected): Local username for `.rhosts` authentication
- **Command** (optional): Command to execute remotely. If empty, opens an interactive shell (like `rsh host`)
- **Interactive mode** (checkbox, default: checked when no command): When checked and no command is given, RSH attempts to open an interactive shell session

#### Security Warning Banner

Both editors display a prominent warning banner (yellow/orange background) that cannot be dismissed. The warning is always visible when configuring or editing these connection types.

```mermaid
flowchart LR
    A[User selects Rlogin or RSH] --> B[Warning banner displayed]
    B --> C[User configures connection]
    C --> D[Save]
    D --> E[Warning icon on connection in sidebar]
```

### Connection Sidebar

Rlogin and RSH connections appear in the Connections sidebar alongside other connection types, each with a distinct icon:

```
┌─────────────────────────────────┐
│ CONNECTIONS                     │
│                                 │
│ ─── SSH ───                     │
│  🔒 Production Server           │
│  🔒 Staging Server              │
│                                 │
│ ─── Rlogin ───                  │
│  ⚠ AIX Production     (rlogin) │
│  ⚠ HP-UX Legacy       (rlogin) │
│                                 │
│ ─── RSH ───                     │
│  ⚠ Build Server        (rsh)   │
│                                 │
│ ─── Telnet ───                  │
│  ○ Switch Console      (telnet)│
│                                 │
│ [+ New Connection]              │
└─────────────────────────────────┘
```

- Rlogin and RSH connections show a warning icon (⚠) to indicate unencrypted protocols
- The protocol type label appears next to the connection name
- Tooltip on hover: "Unencrypted connection — data is transmitted in plaintext"

### Terminal Tab

Once connected, Rlogin and RSH sessions render in the standard terminal tab, identical to SSH/Telnet/Local sessions. The tab title shows the connection name and a visual indicator of the protocol:

```
┌──────────────────────────────────────────────────┐
│ [⚠ AIX Production] [🔒 Staging] [> Local]        │
├──────────────────────────────────────────────────┤
│ $ hostname                                        │
│ aix-prod.internal.local                           │
│ $ uname -a                                        │
│ AIX aix-prod 7 2 00XXXXXX4C00                     │
│ $                                                 │
│                                                   │
│                                                   │
│                                                   │
│ ──────────────────────────────────────────────────│
│ ⚠ Unencrypted (Rlogin) │ operator@aix-prod │ 80x24│
└──────────────────────────────────────────────────┘
```

The status bar at the bottom of the terminal shows:

- Protocol warning indicator: "⚠ Unencrypted (Rlogin)" or "⚠ Unencrypted (RSH)"
- Username and host
- Terminal dimensions (for Rlogin which supports resize)

### First-Time Connection Warning Dialog

On the first connection attempt for each Rlogin/RSH connection, a modal dialog warns the user:

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠ Insecure Connection Warning                              │
│                                                             │
│ You are about to connect to aix-prod.internal.local         │
│ using Rlogin, which does NOT encrypt any data.              │
│                                                             │
│ • Your username will be sent in plaintext                   │
│ • All terminal input and output will be visible to anyone   │
│   who can observe network traffic                           │
│ • Authentication relies on .rhosts trust, not passwords     │
│                                                             │
│ Only use this on trusted, isolated networks.                │
│                                                             │
│ ☐ Don't show this warning again for this connection         │
│                                                             │
│                          [Cancel]  [Connect Anyway]         │
└─────────────────────────────────────────────────────────────┘
```

## General Handling

### User Journeys

#### Creating an Rlogin Connection

```mermaid
flowchart TD
    A[User clicks '+ New Connection'] --> B[Connection Editor opens]
    B --> C[User selects 'Rlogin' from type dropdown]
    C --> D[Security warning banner appears]
    D --> E[User fills in host, remote username, terminal type]
    E --> F[User clicks 'Test Connection']
    F --> G{Connection successful?}
    G -->|Yes| H[Success indicator shown]
    G -->|No| I[Error message with details]
    I --> E
    H --> J[User clicks 'Save']
    J --> K[Connection appears in sidebar with ⚠ icon]
```

#### Connecting via Rlogin

1. User double-clicks an Rlogin connection in the sidebar (or right-click → Connect)
2. First-time warning dialog appears (if not previously suppressed)
3. User clicks "Connect Anyway"
4. Backend establishes TCP connection to host:513
5. Rlogin handshake: sends `\0`, local username, remote username, terminal type/speed, `\0`
6. Server responds with `\0` (success) or error message
7. Terminal tab opens with interactive session
8. User types commands, output streams back through the terminal emulator
9. Window resize events trigger Rlogin urgent-data resize notification (0x80 prefix)
10. User closes tab or types `~.` to disconnect

#### Executing a Remote Command via RSH

1. User double-clicks an RSH connection configured with a command
2. First-time warning dialog appears (if not previously suppressed)
3. Backend establishes TCP connection to host:514
4. RSH handshake: sends stderr port (or `0\0`), local username, remote username, command
5. Server executes the command
6. Output streams into the terminal tab
7. When the command completes, the tab shows "Process exited" in the status bar
8. User can close the tab or re-run the command

#### RSH Interactive Mode (No Command)

1. User double-clicks an RSH connection with no command and "Interactive mode" checked
2. Backend connects and sends an empty command string, requesting a shell
3. If the server supports it, an interactive shell session opens
4. Behaves like Rlogin but without window resize support
5. If the server rejects interactive mode, an error is displayed suggesting Rlogin instead

### Edge Cases & Error Handling

| Scenario                            | Handling                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Server rejects connection**       | Display server error message (e.g., "Permission denied") with suggestion to check `.rhosts` configuration            |
| **`.rhosts` not configured**        | Show error: "Connection refused — the remote host may not have `.rhosts` trust configured for your user"             |
| **Connection timeout**              | Configurable timeout (default: 10s). Show: "Connection timed out. Verify the host is reachable on port N."           |
| **Server sends error on connect**   | Parse the error text from the server response and display it in the terminal tab                                     |
| **RSH command exits immediately**   | Show exit code in status bar. If exit code is non-zero, highlight in red.                                            |
| **Network drops mid-session**       | Detect broken TCP connection, show "Connection lost" banner with reconnect option                                    |
| **Privileged port requirement**     | Rlogin traditionally requires a source port < 1024. If binding fails, show guidance about privilege needs.           |
| **Server not running rlogind/rshd** | Connection refused error with suggestion: "No Rlogin/RSH service found. Is rlogind/rshd running on the remote host?" |
| **IPv6 address**                    | Support IPv6 addresses in the host field (bracket notation for display)                                              |
| **Window resize (Rlogin)**          | Send urgent TCP data with new dimensions. If urgent data fails, log warning but continue session.                    |
| **Window resize (RSH)**             | Not supported by protocol. Status bar shows fixed dimensions. No resize events sent.                                 |
| **Empty remote username**           | Validation error in connection editor: "Remote username is required"                                                 |

### Reconnection Behavior

```mermaid
flowchart TD
    A[Connection lost detected] --> B[Show 'Connection lost' banner in terminal tab]
    B --> C{User action}
    C -->|Click 'Reconnect'| D[Attempt new TCP connection]
    C -->|Close tab| E[Clean up resources]
    D --> F{Successful?}
    F -->|Yes| G[Resume terminal session]
    F -->|No| H[Show error, offer retry]
    H --> C
```

Rlogin and RSH connections follow the same reconnection pattern as Telnet: a new TCP connection is established from scratch (no session resumption since these protocols are stateless).

### Privileged Source Port Handling

Rlogin (RFC 1282) and RSH traditionally require the client to connect from a privileged source port (512-1023) to prove the client is running as a trusted user. This is enforced by some servers.

```mermaid
flowchart TD
    A[Connection attempt] --> B{Try binding to port 512-1023}
    B -->|Success| C[Connect with privileged source port]
    B -->|Permission denied| D{Platform}
    D -->|macOS/Linux| E[Show: 'Privileged port required. Try running with elevated privileges or configure the server to allow unprivileged connections.']
    D -->|Windows| F[Windows does not enforce source port privileges — try connecting anyway]
    C --> G[Proceed with handshake]
    F --> G
    E --> H[User decides to retry with privileges or cancel]
```

## States & Sequences

### Rlogin Connection Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Disconnected: Connection created

    Disconnected --> Connecting: User initiates connect
    Connecting --> Handshaking: TCP connection established
    Connecting --> Failed: TCP connect error/timeout

    Handshaking --> Connected: Server sends \0 (success)
    Handshaking --> Failed: Server sends error message

    Connected --> Connected: Data exchange (input/output)
    Connected --> Resizing: Window resize event
    Resizing --> Connected: Resize notification sent

    Connected --> Disconnecting: User closes tab / ~.
    Connected --> ConnectionLost: TCP connection broken

    ConnectionLost --> Connecting: User clicks 'Reconnect'
    ConnectionLost --> Disconnected: User closes tab

    Disconnecting --> Disconnected: TCP closed cleanly

    Failed --> Disconnected: User acknowledges error
    Failed --> Connecting: User retries

    Disconnected --> [*]: Connection deleted
```

### RSH Connection Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Disconnected: Connection created

    Disconnected --> Connecting: User initiates connect
    Connecting --> Handshaking: TCP connection established
    Connecting --> Failed: TCP connect error/timeout

    Handshaking --> Running: Server accepts and starts execution
    Handshaking --> Failed: Server rejects (permission denied)

    state Running {
        [*] --> Streaming: Output arriving
        Streaming --> Streaming: More output
        Streaming --> [*]: Command/shell exits
    }

    Running --> Exited: Remote command completed
    Running --> ConnectionLost: TCP connection broken
    Running --> Disconnecting: User closes tab

    Exited --> Disconnected: User closes tab
    Exited --> Running: User re-runs command (RSH reconnects)

    ConnectionLost --> Connecting: User clicks 'Reconnect'
    ConnectionLost --> Disconnected: User closes tab

    Disconnecting --> Disconnected: TCP closed

    Failed --> Disconnected: User acknowledges
    Failed --> Connecting: User retries

    Disconnected --> [*]: Connection deleted
```

### Rlogin Handshake Sequence

```mermaid
sequenceDiagram
    participant C as termiHub Client
    participant S as Rlogin Server (rlogind)

    C->>C: Bind to privileged source port (512-1023)
    C->>S: TCP connect to host:513

    Note over C,S: Rlogin handshake begins

    C->>S: \0 (null byte — start of handshake)
    C->>S: local_username\0
    C->>S: remote_username\0
    C->>S: terminal_type/speed\0

    alt Server accepts
        S->>C: \0 (null byte — success)
        Note over C,S: Interactive session established
        loop Data exchange
            C->>S: User input (keystrokes)
            S->>C: Command output
        end
    else Server rejects
        S->>C: Error message (plaintext)
        S->>S: Close connection
        C->>C: Display error to user
    end

    Note over C,S: Window resize (out-of-band)
    C->>S: TCP urgent data: 0x80
    C->>S: 0xFF 0xFF s s r r c c (magic + rows/cols in network byte order)
    S->>S: Update terminal dimensions
```

### RSH Handshake Sequence

```mermaid
sequenceDiagram
    participant C as termiHub Client
    participant S as RSH Server (rshd)

    C->>C: Bind to privileged source port (512-1023)
    C->>S: TCP connect to host:514

    Note over C,S: RSH handshake begins

    C->>S: 0\0 (stderr port = 0, no secondary channel)
    C->>S: local_username\0
    C->>S: remote_username\0
    C->>S: command\0 (or empty for interactive shell)

    alt Server accepts
        S->>C: \0 (null byte — success)
        alt Command mode
            S->>C: Command output (stdout)
            S->>C: EOF when command completes
            C->>C: Show exit status in tab
        else Interactive mode (empty command)
            loop Shell session
                C->>S: User input
                S->>C: Shell output
            end
        end
    else Server rejects
        S->>C: Error message (e.g., "Permission denied.\n")
        S->>S: Close connection
        C->>C: Display error to user
    end
```

### RSH with Stderr Channel (Optional)

```mermaid
sequenceDiagram
    participant C as termiHub Client
    participant S as RSH Server (rshd)
    participant E as Stderr Channel

    C->>C: Open listening TCP socket on port P
    C->>S: TCP connect to host:514
    C->>S: P\0 (stderr port number as ASCII)
    C->>S: local_username\0
    C->>S: remote_username\0
    C->>S: command\0

    S->>E: TCP connect back to client on port P
    Note over S,E: Secondary channel for stderr

    S->>C: \0 (success)

    par Stdout on primary channel
        S->>C: Command stdout output
    and Stderr on secondary channel
        S->>E: Command stderr output
        E->>C: Render stderr (e.g., in red)
    end

    S->>C: EOF (command complete)
    S->>E: EOF (stderr complete)
```

### Connection Setup Flow (Frontend to Backend)

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend (React)
    participant S as Store (Zustand)
    participant B as Backend (Rust)
    participant N as Network

    U->>F: Double-click Rlogin connection
    F->>F: Check if first-time warning needed
    alt First connection
        F->>U: Show security warning dialog
        U->>F: Click 'Connect Anyway'
    end

    F->>S: dispatch openConnection(connectionId)
    S->>B: invoke("create_session", {connectionId, config})
    B->>B: Create RloginBackend with config

    B->>N: Bind privileged source port
    B->>N: TCP connect to host:port

    alt Connection successful
        B->>N: Send Rlogin handshake bytes
        N-->>B: Server responds with \0
        B-->>F: Session created (sessionId)
        F->>S: Add terminal tab
        S->>F: Render terminal

        loop Terminal session
            U->>F: Type input
            F->>B: invoke("write_to_session", {sessionId, data})
            B->>N: Send data over TCP
            N-->>B: Output data
            B-->>F: emit("session-output", {sessionId, data})
            F->>F: Render in xterm.js
        end
    else Connection failed
        N-->>B: Error
        B-->>F: Error response
        F->>U: Show error notification
    end
```

## Preliminary Implementation Details

> Based on the current project architecture as of the time of concept creation. The codebase may evolve before implementation.

### Backend (Rust) — Core Library

#### New Backend Files

```
core/src/backends/
  rlogin.rs          # Rlogin backend implementation
  rsh.rs             # RSH backend implementation
```

Both backends follow the same pattern as the existing Telnet backend (`core/src/backends/telnet.rs`): simple TCP socket connection, reader thread bridging sync reads to async channels, and `Backend` trait implementation.

#### Rlogin Backend (`core/src/backends/rlogin.rs`)

```rust
pub struct Rlogin {
    stream: Option<TcpStream>,
    alive: Arc<AtomicBool>,
    output_tx: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,
}
```

Key implementation details:

- **`type_id()`**: Returns `"rlogin"`
- **`display_name()`**: Returns `"Rlogin"`
- **`capabilities()`**: `{ monitoring: false, file_browser: false, resize: true, persistent: false }`
- **`settings_schema()`**: Returns schema with fields for host, port, remote_username, local_username, terminal_type, terminal_speed
- **`connect()`**:
  1. Attempt to bind to a privileged source port (512-1023), iterating through available ports
  2. Establish TCP connection with configurable timeout (default: 10s)
  3. Send handshake: `\0` + local_username + `\0` + remote_username + `\0` + terminal_type/speed + `\0`
  4. Read server response — expect `\0` for success, otherwise treat as error message
  5. Spawn reader thread to forward output via `mpsc` channel
- **`resize()`**: Send TCP urgent data with `0x80` flag followed by `0xFF 0xFF` magic bytes and new dimensions (rows, cols as 2 bytes each in network byte order)
- **`write()`**: Write input bytes to TCP stream
- **`disconnect()`**: Set alive flag to false, close TCP stream

#### RSH Backend (`core/src/backends/rsh.rs`)

```rust
pub struct Rsh {
    stream: Option<TcpStream>,
    alive: Arc<AtomicBool>,
    output_tx: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,
    stderr_listener: Option<TcpListener>,  // for optional stderr channel
}
```

Key implementation details:

- **`type_id()`**: Returns `"rsh"`
- **`display_name()`**: Returns `"RSH"`
- **`capabilities()`**: `{ monitoring: false, file_browser: false, resize: false, persistent: false }`
- **`settings_schema()`**: Returns schema with fields for host, port, remote_username, local_username, command, interactive_mode
- **`connect()`**:
  1. Optionally open a listening socket for stderr (if stderr separation is desired)
  2. Bind to privileged source port (512-1023)
  3. Establish TCP connection with configurable timeout
  4. Send handshake: stderr_port + `\0` + local_username + `\0` + remote_username + `\0` + command + `\0`
  5. Read server response — expect `\0` for success
  6. Spawn reader thread(s) for stdout (and optionally stderr)
- **`resize()`**: Not supported — returns `Ok(())` as a no-op
- **`write()`**: Write input bytes to TCP stream (for interactive mode)
- **`disconnect()`**: Clean up TCP streams and optional stderr listener

#### Configuration Types (`core/src/config/mod.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RloginConfig {
    pub host: String,
    #[serde(default = "default_rlogin_port")]
    pub port: u16,                    // default: 513
    pub remote_username: String,
    #[serde(default)]
    pub local_username: String,       // default: current OS user
    #[serde(default = "default_terminal_type")]
    pub terminal_type: String,        // default: "xterm-256color"
    #[serde(default = "default_terminal_speed")]
    pub terminal_speed: String,       // default: "38400/38400"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RshConfig {
    pub host: String,
    #[serde(default = "default_rsh_port")]
    pub port: u16,                    // default: 514
    pub remote_username: String,
    #[serde(default)]
    pub local_username: String,       // default: current OS user
    #[serde(default)]
    pub command: String,              // empty = interactive shell
    #[serde(default = "default_true")]
    pub interactive_mode: bool,       // default: true
}
```

Both configs implement the `.expand()` method for `${env:...}` variable expansion, following the existing pattern.

#### Privileged Port Binding Helper

A shared utility for both Rlogin and RSH to bind to a privileged source port:

```rust
// core/src/backends/privileged_port.rs (or within each backend)
fn bind_privileged_port() -> Result<TcpSocket> {
    for port in (512..=1023).rev() {
        let socket = TcpSocket::new_v4()?;
        if socket.bind(SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), port)).is_ok() {
            return Ok(socket);
        }
    }
    // Fall back to ephemeral port if no privileged port available
    let socket = TcpSocket::new_v4()?;
    socket.bind(SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), 0))?;
    Ok(socket)
}
```

The helper iterates through ports 1023 down to 512. If none are available (due to permissions or exhaustion), it falls back to an ephemeral port with a logged warning.

### Backend (Rust) — Desktop Integration

#### Session Registry (`src-tauri/src/session/registry.rs`)

Register both new backends:

```rust
registry.register(
    "rlogin",
    "Rlogin",
    "rlogin",  // icon ID
    Box::new(|| Box::new(termihub_core::backends::rlogin::Rlogin::new())),
);

registry.register(
    "rsh",
    "RSH",
    "rsh",    // icon ID
    Box::new(|| Box::new(termihub_core::backends::rsh::Rsh::new())),
);
```

No new Tauri commands are needed — the existing `create_session`, `write_to_session`, `resize_session`, and `close_session` commands work with any registered backend.

### Frontend (React/TypeScript)

#### Connection Type Update (`src/types/terminal.ts`)

Add `"rlogin"` and `"rsh"` to the `ConnectionType` union:

```typescript
export type ConnectionType =
  | "local"
  | "ssh"
  | "telnet"
  | "serial"
  | "remote"
  | "remote-session"
  | "docker"
  | "rlogin"
  | "rsh"
  | (string & {});
```

#### Security Warning Component

Create a reusable security warning banner component used by the Connection Editor when the selected type is `"rlogin"` or `"rsh"`:

```
src/components/ConnectionEditor/
  InsecureProtocolWarning.tsx   # Reusable warning banner
```

This component can also be retroactively applied to Telnet connections (which are also unencrypted).

#### First-Connection Warning Dialog

Add a confirmation dialog that appears on the first connection attempt for insecure protocols. The suppression state ("Don't show again for this connection") is stored in the connection's metadata.

#### Status Bar Protocol Indicator

Extend the terminal status bar to show protocol security status:

- Encrypted protocols (SSH): lock icon
- Unencrypted protocols (Rlogin, RSH, Telnet): warning icon with "Unencrypted" label

#### Connection Sidebar Icons

Add icons for Rlogin and RSH in the connection sidebar. Both should use a warning-styled icon to visually distinguish them from encrypted protocols.

### Cross-Platform Considerations

```mermaid
flowchart TD
    A[Privileged port binding] --> B{Platform}
    B -->|Linux| C["Requires CAP_NET_BIND_SERVICE or root<br/>Fall back to ephemeral port with warning"]
    B -->|macOS| D["Requires root for ports < 1024<br/>Fall back to ephemeral port with warning"]
    B -->|Windows| E["No special privileges needed for port binding<br/>Bind directly to privileged port"]

    F[TCP urgent data for Rlogin resize] --> G{Platform}
    G -->|Linux| H["send() with MSG_OOB flag — standard"]
    G -->|macOS| I["send() with MSG_OOB flag — standard"]
    G -->|Windows| J["send() with MSG_OOB flag via windows-sys"]
```

All three platforms support standard TCP socket operations. The main platform difference is privileged port binding:

- **Linux/macOS**: Ports below 1024 require root or `CAP_NET_BIND_SERVICE`. The backend falls back gracefully to ephemeral ports.
- **Windows**: No restriction on binding to ports below 1024.

TCP urgent (out-of-band) data for Rlogin window resize is supported on all platforms via the `MSG_OOB` socket flag.

### Testing Strategy

#### Unit Tests

- **Handshake construction**: Verify Rlogin and RSH handshake byte sequences are correctly formed for various input combinations
- **Config serialization**: Roundtrip serialization/deserialization of `RloginConfig` and `RshConfig`
- **Config defaults**: Verify default port, terminal type, speed values
- **Schema validation**: Ensure `settings_schema()` returns correct fields with proper types and defaults
- **Privileged port binding**: Test fallback behavior when privileged ports are unavailable
- **Resize message**: Verify Rlogin urgent data format (0x80, 0xFF 0xFF, dimensions)
- **Error parsing**: Test server error message extraction from handshake response

#### Integration Tests

- **Docker test containers**: Add `rlogind` and `rshd` containers to `tests/docker/` for full connection testing
- **End-to-end handshake**: Connect to test server, verify handshake completes, send a command, verify output
- **Connection failure**: Test timeout, connection refused, and permission denied scenarios
- **RSH command execution**: Verify command output is received and exit status is reported

#### Manual Tests

- **Visual verification**: Security warning banners, icons, status bar indicators display correctly
- **Legacy system compatibility**: Test with actual AIX/HP-UX systems if available
- **Window resize**: Verify Rlogin terminal resize works with a real server

### Implementation Phases

```mermaid
gantt
    title Rlogin & RSH Implementation Phases
    dateFormat X
    axisFormat %s

    section Phase 1 — Core Backends
    RloginConfig & RshConfig types           :a1, 0, 1
    Rlogin backend (connect, handshake, I/O) :a2, 1, 3
    RSH backend (connect, handshake, I/O)    :a3, 1, 3
    Privileged port binding utility           :a4, 1, 1
    Unit tests for both backends             :a5, 4, 2

    section Phase 2 — Desktop Integration
    Register backends in session registry    :b1, 6, 1
    Rlogin window resize (urgent data)       :b2, 6, 2
    RSH stderr channel (optional)            :b3, 7, 2

    section Phase 3 — Frontend
    Connection type & schema integration     :c1, 9, 1
    Security warning banner component        :c2, 9, 2
    First-connection warning dialog          :c3, 10, 1
    Status bar protocol indicator            :c4, 10, 1
    Sidebar icons                            :c5, 11, 1

    section Phase 4 — Testing & Polish
    Docker test containers                   :d1, 12, 2
    Integration tests                        :d2, 14, 2
    Manual test documentation                :d3, 14, 1
    Cross-platform verification              :d4, 15, 2
```

### Security Considerations

- **No password authentication**: Rlogin and RSH rely on `.rhosts` trust, not passwords. termiHub does not implement password prompting for these protocols — if the server requires a password (e.g., modified rlogind), the password prompt appears in the terminal output and the user types it directly (plaintext).
- **Plaintext warning everywhere**: The security risk is surfaced at every touchpoint — connection editor, sidebar, tab title, status bar, and first-connection dialog.
- **No credential storage**: Unlike SSH connections, Rlogin/RSH connections do not store passwords in the credential store (since authentication is `.rhosts`-based). Only the username is stored in the connection config.
- **Network isolation recommendation**: Documentation should recommend using these protocols only on isolated/air-gapped networks.
- **Audit logging**: Log all Rlogin/RSH connection attempts (including failures) at INFO level for security auditing.
