# Remote Client Mode — Behavior

Behavior diagrams for the [remote-client-mode concept](concept.md). Architecture, state machines,
and sequences live here; visual layout lives in [`mockups/`](mockups/).

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph Clients
        A[Desktop App\nTauri IPC]
        B[Browser\nWebSocket]
        C[iPad App\nWebSocket]
    end
    subgraph Agent["termiHub Agent (server / desktop / RPi)"]
        D[HTTP Server\nstatic assets + /api]
        E[WebSocket Endpoint\n/ws]
        F[JSON-RPC Dispatcher]
        G[Terminal Backends\nSSH · Docker · Serial · Telnet]
    end
    A -->|Tauri IPC| F
    B -->|WSS /ws| E
    C -->|WSS /ws| E
    E --> F
    F --> G
    B -->|HTTPS| D
    C -->|HTTPS| D
```

## Client Connection Flow

```mermaid
sequenceDiagram
    participant Client as Browser / iPad
    participant Agent as termiHub Agent
    participant Auth as Auth Middleware

    Client->>Agent: GET https://host:port/
    Agent-->>Client: 200 index.html + assets
    Client->>Agent: POST /api/auth  {token | user+pass}
    Agent->>Auth: validate credentials
    Auth-->>Agent: session token (JWT, 8h TTL)
    Agent-->>Client: 200 {sessionToken}
    Client->>Agent: WS Upgrade /ws  Authorization: Bearer <token>
    Agent->>Auth: validate token
    Auth-->>Agent: OK
    Agent-->>Client: 101 Switching Protocols
    Note over Client,Agent: JSON-RPC over WebSocket (same protocol as TCP agent)
    Client->>Agent: session/create {type: "ssh", ...}
    Agent-->>Client: session/output stream
```

## Agent Listener State Machine

```mermaid
stateDiagram-v2
    [*] --> Disabled : initial state
    Disabled --> Starting : user enables in Settings
    Starting --> Listening : TLS cert ready, port bound
    Starting --> Error : port in use / TLS failure
    Error --> Starting : user retries / changes port
    Listening --> Stopping : user disables in Settings
    Listening --> Error : unexpected bind failure
    Stopping --> Disabled : port released
```

## Client Session State Machine

```mermaid
stateDiagram-v2
    [*] --> Unauthenticated : page load
    Unauthenticated --> Authenticating : user submits token/password
    Authenticating --> Connected : token valid, WS open
    Authenticating --> Unauthenticated : auth failure
    Connected --> Reconnecting : WS closed (network drop)
    Reconnecting --> Connected : WS re-established, sessions re-attached
    Reconnecting --> Unauthenticated : token expired
    Connected --> Unauthenticated : user disconnects
```

## iPad App Launch Sequence

```mermaid
sequenceDiagram
    participant User
    participant App as iPad App
    participant Store as Saved Connections
    participant Agent

    User->>App: opens app
    App->>Store: load saved agent URLs
    alt saved agents exist
        App-->>User: show agent list
        User->>App: tap agent
    else no saved agents
        App-->>User: "Add agent" screen
        User->>App: enter URL (or scan QR)
    end
    App->>Agent: POST /api/auth
    Agent-->>App: sessionToken
    App->>Agent: WS /ws
    Agent-->>App: session list
    App-->>User: termiHub main UI
```
