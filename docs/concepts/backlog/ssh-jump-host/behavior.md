# SSH Jump Host — Behavior

Behavior diagrams for the [ssh-jump-host concept](concept.md). State machines, sequences, and
flows live here; visual layout lives in [`mockups/`](mockups/).

---

## Connection Workflow

```mermaid
flowchart TD
    A[User clicks Connect\non jump-host-enabled connection] --> B{Jump host\nconfigured?}
    B -->|No| C[Direct SSH connection\nto target host]
    B -->|Yes| D[Resolve jump host\nconfiguration]
    D --> E{Source type?}
    E -->|Saved connection| F[Load saved SSH\nconnection config]
    E -->|Inline| G[Use inline\nSSH config]
    F --> H{Multi-hop?}
    G --> H
    H -->|Single hop| I[Connect to jump host]
    H -->|Multiple hops| J[Connect to first hop]
    J --> K[Forward through\neach intermediate hop]
    K --> I
    I --> L[Open direct-tcpip channel\nto target host:port]
    L --> M[Run SSH handshake\nthrough forwarded channel]
    M --> N{Auth on target?}
    N -->|Success| O[Open shell channel\non target session]
    N -->|Failure| P[Show auth error\nfor target hop]
    O --> Q[Terminal session active]

    style D fill:#2d6a4f,stroke:#333,color:#fff
    style L fill:#2d6a4f,stroke:#333,color:#fff
```

## Authentication Flow Per Hop

Each hop in the chain may use a different authentication method. The credential store resolves
credentials independently per hop:

```mermaid
sequenceDiagram
    participant User
    participant UI as Connection Editor
    participant CM as ConnectionManager
    participant CS as CredentialStore
    participant SSH1 as Jump Host SSH
    participant SSH2 as Target SSH

    User->>UI: Click Connect
    UI->>CM: connect(connectionId)
    CM->>CM: Resolve jump host chain

    Note over CM,CS: Hop 1: Jump Host
    CM->>CS: getCredential(jumpHostId)
    alt Password saved
        CS-->>CM: Return saved password
    else Password not saved
        CS-->>CM: No password
        CM-->>User: Prompt for jump host password
        User-->>CM: Enter password
    end
    CM->>SSH1: Connect & authenticate to jump host

    Note over CM,SSH2: Hop 2: Target Host
    CM->>SSH1: direct_tcpip(targetHost, targetPort)
    SSH1-->>CM: Forwarded channel
    CM->>CS: getCredential(targetId)
    alt Password saved
        CS-->>CM: Return saved password
    else Password not saved
        CS-->>CM: No password
        CM-->>User: Prompt for target password
        User-->>CM: Enter password
    end
    CM->>SSH2: Authenticate over forwarded channel

    SSH2-->>CM: Session ready
    CM-->>User: Terminal connected
```

## Session Pooling

When multiple connections share the same jump host, the gateway SSH session is pooled (reused) to
avoid redundant connections. This extends the existing `SshSessionPool` pattern used by SSH tunnels:

```mermaid
flowchart LR
    subgraph "User's Connections"
        C1[app-server-01\nvia bastion]
        C2[app-server-02\nvia bastion]
        C3[db-server\nvia bastion]
    end

    subgraph "Session Pool"
        P1[bastion session\nref_count: 3]
    end

    subgraph "Targets"
        T1[app-server-01:22]
        T2[app-server-02:22]
        T3[db-server:5432]
    end

    C1 --> P1
    C2 --> P1
    C3 --> P1
    P1 -->|direct-tcpip| T1
    P1 -->|direct-tcpip| T2
    P1 -->|direct-tcpip| T3

    style P1 fill:#e87d0d,stroke:#333,color:#fff
```

## Tunnel Compatibility

SSH tunnels (local forward, remote forward, dynamic/SOCKS) should work through jump hosts. The
tunnel's SSH session is established over the forwarded channel, just like a terminal session:

```mermaid
flowchart TD
    A[User creates tunnel\nthrough jump-host connection] --> B[Resolve jump host chain]
    B --> C[Get or create pooled\njump host session]
    C --> D[Open direct-tcpip channel\nto target host]
    D --> E[Establish SSH session\non target]
    E --> F{Tunnel type?}
    F -->|Local forward| G[Bind local port\nforward via target SSH]
    F -->|Remote forward| H[Request remote forward\non target SSH]
    F -->|Dynamic/SOCKS| I[Bind local SOCKS port\nforward via target SSH]
```

## Jump Host Connection State Machine

```mermaid
stateDiagram-v2
    [*] --> Idle: Connection created

    Idle --> ResolvingChain: User clicks Connect
    ResolvingChain --> ConnectingHop: Chain resolved

    state "Connecting Through Hops" as ConnectingHop {
        [*] --> AuthenticatingHop
        AuthenticatingHop --> ForwardingChannel: Hop authenticated
        ForwardingChannel --> AuthenticatingHop: More hops remaining
        ForwardingChannel --> ConnectingTarget: Last hop reached
        AuthenticatingHop --> HopFailed: Auth/network error
    }

    ConnectingTarget --> AuthenticatingTarget: Channel forwarded
    AuthenticatingTarget --> Connected: Target authenticated
    AuthenticatingTarget --> TargetAuthFailed: Auth failed

    Connected --> Disconnected: Connection dropped
    Connected --> Idle: User disconnects

    Disconnected --> ResolvingChain: Reconnect
    Disconnected --> Idle: User cancels

    HopFailed --> Idle: User cancels
    HopFailed --> ResolvingChain: Retry
    TargetAuthFailed --> Idle: User cancels
    TargetAuthFailed --> ConnectingTarget: Retry with new credentials
```

## Connection Establishment Sequence (Single Hop)

```mermaid
sequenceDiagram
    participant User
    participant FE as Frontend
    participant CM as ConnectionManager
    participant Pool as SshSessionPool
    participant JH as Jump Host (bastion)
    participant TGT as Target (app-server)

    User->>FE: Connect to app-server
    FE->>CM: connect("app-server-id")
    CM->>CM: Load connection config
    CM->>CM: Detect jump host configured

    Note over CM,JH: Phase 1: Gateway Connection
    CM->>Pool: get_or_create("bastion-id", bastionConfig)
    alt Session exists in pool
        Pool-->>CM: Existing session (ref_count++)
    else New connection needed
        Pool->>JH: TCP connect + SSH handshake
        JH-->>Pool: Authenticated session
        Pool-->>CM: New session (ref_count=1)
    end

    Note over CM,TGT: Phase 2: Channel Forwarding
    CM->>JH: session.channel_direct_tcpip("app-server", 22)
    JH-->>CM: Forwarded TCP channel

    Note over CM,TGT: Phase 3: Target Authentication
    CM->>TGT: SSH handshake over forwarded channel
    TGT-->>CM: Handshake complete
    CM->>TGT: Authenticate (key/password/agent)
    TGT-->>CM: Auth success

    Note over CM,TGT: Phase 4: Shell Session
    CM->>TGT: Open shell channel + request PTY
    TGT-->>CM: Shell ready
    CM-->>FE: Session connected
    FE-->>User: Terminal active
```

## Multi-Hop Connection Sequence

```mermaid
sequenceDiagram
    participant CM as ConnectionManager
    participant H1 as Hop 1 (edge-gw)
    participant H2 as Hop 2 (bastion)
    participant TGT as Target (db-server)

    Note over CM,H1: Hop 1: Connect to edge gateway
    CM->>H1: TCP connect + SSH handshake + auth
    H1-->>CM: Authenticated session

    Note over CM,H2: Hop 2: Forward to bastion through edge
    CM->>H1: channel_direct_tcpip("bastion", 22)
    H1-->>CM: Forwarded channel to bastion
    CM->>H2: SSH handshake + auth over channel
    H2-->>CM: Authenticated session on bastion

    Note over CM,TGT: Final: Forward to target through bastion
    CM->>H2: channel_direct_tcpip("db-server", 22)
    H2-->>CM: Forwarded channel to target
    CM->>TGT: SSH handshake + auth over channel
    TGT-->>CM: Authenticated session on target

    Note over CM,TGT: Connection path established:<br/>You → edge-gw → bastion → db-server
```

## Session Pool Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Empty: Pool created

    Empty --> HasSessions: First connection\nuses jump host

    state HasSessions {
        [*] --> Active
        Active --> Active: New connection\nref_count++
        Active --> Active: Connection closed\nref_count--
        Active --> Draining: ref_count == 0
        Draining --> Active: New connection\nbefore cleanup
    }

    HasSessions --> Empty: All sessions\nreleased
    Active --> Reconnecting: Gateway drops
    Reconnecting --> Active: Reconnect success
    Reconnecting --> Empty: Reconnect failed\n+ all refs released
```

## Validation Flow (On Save)

```mermaid
flowchart TD
    A[User clicks Save\non connection with jump host] --> B{Jump host\nenabled?}
    B -->|No| C[Save normally]
    B -->|Yes| D{Source type?}
    D -->|Saved connection| E{Referenced connection\nexists?}
    D -->|Inline| F{Inline config\nvalid?}
    E -->|Yes| G{Circular\nreference?}
    E -->|No| H[Error: Referenced\nconnection not found]
    G -->|No| I{Chain depth\n> 5?}
    G -->|Yes| J[Error: Circular\njump host chain detected]
    I -->|No| C
    I -->|Yes| K[Warning: Deep chain\nmay cause latency]
    K --> C
    F -->|Valid| G
    F -->|Invalid| L[Error: Missing required\njump host fields]
```
