# VNC Sessions — Behavior

Behavior diagrams for the [VNC sessions concept](concept.md). State machines, sequences, and flows
live here; visual layout lives in [`mockups/`](mockups/).

---

## Transport Topology

noVNC speaks WebSocket; VNC servers speak raw TCP. The Rust backend bridges the two, optionally
through an SSH tunnel.

```mermaid
flowchart LR
    A[noVNC in Frontend] -->|WebSocket| B[Tauri Backend<br>WebSocket Server]
    B -->|Raw TCP| C[VNC Server<br>port 5900+N]
```

## VNC via SSH Tunnel

```mermaid
sequenceDiagram
    participant F as Frontend (noVNC)
    participant WS as WebSocket Proxy
    participant T as SSH Tunnel
    participant S as SSH Server
    participant V as VNC Server

    F->>WS: WebSocket connect
    WS->>T: Connect to local tunnel port
    T->>S: SSH connection (encrypted)
    S->>V: Forward to VNC port (localhost:5901)
    V-->>S: VNC handshake
    S-->>T: Tunnel data
    T-->>WS: TCP data
    WS-->>F: WebSocket frames
    Note over F,V: All VNC traffic encrypted via SSH
```

## Keyboard Shortcut Handling

VNC sessions conflict with termiHub's keyboard shortcuts since all keys should be forwarded to the
remote desktop. The escape hatch (`Ctrl+Shift+Escape` by default, configurable) releases focus back
to termiHub.

```mermaid
flowchart TD
    A[Key event in VNC tab] --> B{Is escape hatch?<br>Ctrl+Shift+Escape}
    B -->|Yes| C[Release VNC focus<br>Return to termiHub shortcuts]
    B -->|No| D{VNC canvas focused?}
    D -->|Yes| E[Forward key to remote<br>via RFB KeyEvent]
    D -->|No| F[Handle as termiHub shortcut]
```

## VNC Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Disconnected: Tab created

    Disconnected --> Connecting: User clicks Connect
    Connecting --> TunnelSetup: SSH tunnel enabled
    Connecting --> ProxyStarting: No tunnel needed

    TunnelSetup --> ProxyStarting: Tunnel established
    TunnelSetup --> Error: Tunnel failed

    ProxyStarting --> Handshaking: WebSocket proxy ready
    ProxyStarting --> Error: Port allocation failed

    Handshaking --> Authenticating: RFB version exchanged
    Handshaking --> Error: Protocol mismatch

    Authenticating --> Connected: Auth succeeded
    Authenticating --> AuthFailed: Wrong password

    AuthFailed --> Disconnected: User dismisses
    AuthFailed --> Authenticating: User retries with new password

    Connected --> Connected: Framebuffer updates
    Connected --> Reconnecting: Connection lost

    Reconnecting --> Connecting: Auto-reconnect timer
    Reconnecting --> Disconnected: Max retries exceeded
    Reconnecting --> Disconnected: User cancels

    Connected --> Disconnecting: User closes tab / clicks Disconnect
    Disconnecting --> Disconnected: Cleanup complete

    Error --> Disconnected: User dismisses
    Error --> Connecting: User retries

    Disconnected --> [*]: Tab closed
```

## WebSocket Proxy Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Idle: Proxy created

    Idle --> Binding: Allocate local port
    Binding --> Listening: Port bound successfully
    Binding --> Error: Port unavailable

    Listening --> Connected: noVNC WebSocket connects
    Connected --> Bridging: TCP connection to VNC server established

    state Bridging {
        [*] --> Forwarding
        Forwarding --> Forwarding: WS frame → TCP / TCP data → WS frame
    }

    Bridging --> Disconnected: Either side closes
    Disconnected --> Listening: Awaiting reconnect

    Connected --> Error: TCP connection failed
    Error --> Idle: Reset

    Listening --> [*]: Proxy shutdown
    Disconnected --> [*]: Proxy shutdown
```

## Connection Sequence (Full Flow)

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend (React)
    participant S as Store (Zustand)
    participant B as Backend (Rust)
    participant WS as WebSocket Proxy
    participant V as VNC Server

    U->>F: Double-click VNC connection
    F->>S: openVncTab(connectionId)
    S->>F: Render VNC tab with "Connecting..." overlay

    F->>B: invoke("vnc_connect", {connectionId})
    B->>B: Load connection config + credentials

    alt SSH Tunnel enabled
        B->>B: Establish SSH tunnel (local:randomPort → remote:vncPort)
        B-->>F: emit("vnc-tunnel-ready", {localPort})
    end

    B->>WS: Start WebSocket proxy on random port
    WS->>V: TCP connect to VNC server (or tunnel endpoint)
    V-->>WS: TCP connected

    B-->>F: Ok({wsUrl: "ws://localhost:PORT", sessionId})
    F->>F: Initialize noVNC with wsUrl

    Note over F,WS: noVNC handles RFB protocol internally
    F->>WS: WebSocket connect
    WS->>V: RFB ProtocolVersion
    V-->>WS: RFB ProtocolVersion
    WS-->>F: Forward

    V-->>WS: Security types
    WS-->>F: Forward
    F->>WS: VNC password (encrypted)
    WS->>V: Forward
    V-->>WS: SecurityResult OK
    WS-->>F: Forward

    F-->>S: setVncState(sessionId, "connected")
    S-->>F: Remove "Connecting..." overlay

    loop Framebuffer updates
        V-->>WS: FramebufferUpdate (RFB)
        WS-->>F: WebSocket frame
        F->>F: noVNC renders to canvas
    end

    loop User input
        U->>F: Mouse/keyboard event
        F->>WS: RFB KeyEvent / PointerEvent
        WS->>V: Forward to VNC server
    end

    U->>F: Close tab / Disconnect
    F->>B: invoke("vnc_disconnect", {sessionId})
    B->>WS: Shutdown proxy
    WS->>V: Close TCP connection
    B->>B: Close SSH tunnel if applicable
    B-->>F: Ok(())
    F->>S: removeVncSession(sessionId)
```

## Clipboard Sync Sequence

```mermaid
sequenceDiagram
    participant U as User (Local)
    participant F as Frontend (noVNC)
    participant V as VNC Server
    participant R as Remote Desktop

    Note over U,R: Local → Remote
    U->>F: Paste text into clipboard panel
    F->>F: noVNC sends ClientCutText
    F->>V: RFB ClientCutText message
    V->>R: Update remote clipboard
    R-->>R: Text available for paste in remote apps

    Note over U,R: Remote → Local
    R->>R: User copies text in remote app
    R->>V: Clipboard change detected
    V->>F: RFB ServerCutText message
    F->>F: noVNC fires "clipboard" event
    F->>U: Display in clipboard panel / copy to local clipboard
```

## Scaling & Resize Flow

```mermaid
flowchart TD
    A[Window/panel resize event] --> B{Scaling mode?}

    B -->|Fit to Window| C[Calculate scale factor<br>to fit canvas in container]
    B -->|Fill Window| D[Calculate scale factor<br>to fill container completely]
    B -->|None| E[Keep native resolution<br>enable scrollbars if overflow]
    B -->|Custom| F[Apply user-specified<br>scale percentage]

    C --> G[Apply CSS transform<br>scale on canvas]
    D --> G
    E --> H[Set canvas to native size<br>container overflow: auto]
    F --> G

    G --> I[Adjust mouse coordinate<br>mapping for input events]
    H --> I
    I --> J[noVNC sends correct<br>coordinates to server]
```

## SSH Tunnel Branch

```mermaid
flowchart TD
    A[vnc_connect called] --> B{SSH tunnel configured?}
    B -->|Yes| C[Create SSH tunnel<br>localPort → remoteHost:vncPort]
    C --> D[Start WebSocket proxy<br>targeting localhost:localPort]
    B -->|No| E[Start WebSocket proxy<br>targeting vncHost:vncPort directly]
    D --> F[Return ws://127.0.0.1:wsPort]
    E --> F
```

## Proxy Byte Forwarding

```mermaid
flowchart LR
    subgraph "WebSocket Proxy (per session)"
        A[noVNC WebSocket Client] -->|Binary WS frames| B[tokio-tungstenite<br>WS Server]
        B -->|Raw bytes| C[tokio TcpStream<br>to VNC server]
        C -->|Raw bytes| B
        B -->|Binary WS frames| A
    end
```

## Implementation Phases

```mermaid
gantt
    title VNC Sessions Implementation Phases
    dateFormat X
    axisFormat %s

    section Phase 1 — Core Infrastructure
    WebSocket-to-TCP proxy (Rust)             :a1, 0, 3
    VncManager + Tauri commands               :a2, 0, 2
    VNC connection type + schema              :a3, 2, 2

    section Phase 2 — Frontend Integration
    VncViewer component (noVNC wrapper)       :b1, 4, 3
    VNC tab type + store integration          :b2, 4, 2
    Connection editor VNC form                :b3, 6, 2

    section Phase 3 — Features
    Floating toolbar + special keys           :c1, 8, 2
    Clipboard sync panel                      :c2, 8, 2
    Scaling modes + resize handling           :c3, 8, 2
    Reconnection logic                        :c4, 10, 2

    section Phase 4 — SSH Tunnel + Polish
    SSH tunnel integration for VNC            :d1, 12, 2
    Credential store for VNC passwords        :d2, 12, 1
    Keyboard mapping + escape hatch           :d3, 13, 2
    Status bar integration                    :d4, 14, 1
```
