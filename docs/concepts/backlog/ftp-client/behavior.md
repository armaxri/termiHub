# FTP Client — Behavior

Behavior diagrams for the [ftp-client concept](concept.md). State machines, sequences, and flows
live here; visual layout lives in [`mockups/`](mockups/).

---

## Connection State Machine

```mermaid
stateDiagram-v2
    [*] --> Disconnected

    Disconnected --> Connecting: connect()
    Connecting --> TlsNegotiating: TLS mode != None
    Connecting --> Authenticating: TLS mode == None
    TlsNegotiating --> Authenticating: TLS established
    TlsNegotiating --> Error: TLS failed
    Authenticating --> Connected: auth success
    Authenticating --> Error: auth failed

    Connected --> Browsing: list_dir()
    Browsing --> Connected: listing received
    Connected --> Transferring: upload/download
    Transferring --> Connected: transfer complete
    Transferring --> Error: transfer failed

    Connected --> Reconnecting: connection lost
    Reconnecting --> Authenticating: reconnect success
    Reconnecting --> Error: max retries exceeded

    Connected --> Disconnecting: disconnect()
    Disconnecting --> Disconnected: QUIT sent
    Error --> Disconnected: user dismisses
    Error --> Connecting: user retries
```

## Connection Sequence

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Backend as FTP Backend
    participant Server as FTP Server

    User->>Frontend: Open FTP connection
    Frontend->>Backend: connect(settings)

    alt Plain FTP
        Frontend->>User: Show security warning
        User->>Frontend: Confirm "Connect Anyway"
    end

    Backend->>Server: TCP connect (port 21/990)
    Server-->>Backend: 220 Welcome

    alt Explicit FTPS
        Backend->>Server: AUTH TLS
        Server-->>Backend: 234 TLS OK
        Backend->>Server: TLS handshake
    end

    Backend->>Server: USER username
    Server-->>Backend: 331 Need password
    Backend->>Server: PASS ****
    Server-->>Backend: 230 Login OK

    Backend->>Server: PASV (or EPSV)
    Server-->>Backend: 227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)

    Backend->>Server: LIST /
    Server-->>Backend: Directory listing
    Backend-->>Frontend: Vec<FileEntry>
    Frontend-->>User: Show file browser
```

## File Transfer Sequence

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Queue as Transfer Queue
    participant Backend as FTP Backend
    participant Server as FTP Server

    User->>Frontend: Download file
    Frontend->>Queue: Enqueue transfer
    Queue->>Backend: Start download

    Backend->>Server: TYPE I (binary)
    Server-->>Backend: 200 OK
    Backend->>Server: PASV
    Server-->>Backend: 227 Passive mode

    alt Resume supported
        Backend->>Server: REST <offset>
        Server-->>Backend: 350 Restarting
    end

    Backend->>Server: RETR /path/to/file
    Server-->>Backend: 150 Opening data connection

    loop Data transfer
        Server-->>Backend: Data chunk
        Backend-->>Queue: Progress update
        Queue-->>Frontend: Update progress bar
    end

    Server-->>Backend: 226 Transfer complete
    Queue-->>Frontend: Transfer completed
    Frontend-->>User: Show completion
```

## Transfer Queue State Machine

```mermaid
stateDiagram-v2
    [*] --> Queued

    Queued --> Active: slot available
    Active --> Completed: transfer done
    Active --> Failed: error
    Active --> Paused: user pause
    Active --> Cancelled: user cancel

    Paused --> Active: user resume
    Paused --> Cancelled: user cancel

    Failed --> Queued: retry (auto/manual)
    Failed --> Cancelled: user cancel

    Completed --> [*]
    Cancelled --> [*]
```

## FTP Session Lifecycle (Frontend)

```mermaid
flowchart TD
    A[User selects FTP connection] --> B{TLS Mode?}
    B -->|None| C[Show security warning]
    B -->|Explicit/Implicit| D[Connect]
    C --> E{User confirms?}
    E -->|Yes| D
    E -->|No| F[Cancel]
    D --> G[Authenticate]
    G --> H{Auth OK?}
    H -->|Yes| I[Open file browser sidebar]
    H -->|No| J[Show error, offer retry]
    I --> K[List initial directory]
    K --> L[User browses / transfers files]
    L --> M{Connection lost?}
    M -->|Yes| N[Auto-reconnect]
    N -->|Success| L
    N -->|Failed| J
    M -->|No| O{User disconnects?}
    O -->|Yes| P[Send QUIT, close session]
    O -->|No| L
```

## Integration Overview

```mermaid
flowchart TB
    subgraph Frontend
        CE[ConnectionEditor] -->|schema-driven| DS[DynamicField]
        FB[FileBrowser Sidebar] -->|list_dir, read, write| API[api.ts]
        TQ[TransferQueue Panel] -->|progress events| EV[events.ts]
        ST[appStore] -->|transfers state| TQ
    end

    subgraph Tauri Commands
        API --> CMD[commands/ftp.rs]
        CMD --> SM[SessionManager]
    end

    subgraph Core
        SM --> FTP[FtpBackend]
        FTP -->|implements| CT[ConnectionType trait]
        FTP -->|provides| FFB[FtpFileBrowser]
        FFB -->|implements| FBT[FileBrowser trait]
        FTP -->|manages| TQB[TransferQueue]
    end

    subgraph External
        FTP -->|suppaftp| SRV[FTP Server]
    end
```

## Agent Support

FTP connections are **desktop-only** in the initial implementation. The remote agent does not need
FTP support because:

- FTP is a direct client-to-server protocol (no SSH tunneling involved)
- The desktop app connects directly to FTP servers
- Agent-side FTP could be added later if there's demand for FTP access through SSH jump hosts

```mermaid
flowchart LR
    Desktop[termiHub Desktop] -->|FtpBackend / suppaftp| Server[FTP Server]
    Agent[Remote Agent] -. not involved .- Server
    style Agent stroke-dasharray: 5 5
```
