# RDP Sessions — Behavior

Behavior diagrams for the [rdp-sessions concept](concept.md). State machines, sequences, and flows
live here; visual layout lives in [`mockups/`](mockups/).

---

## Scale Modes

```mermaid
flowchart LR
    A[Scale Mode] --> B[Fit to Tab]
    A --> C[1:1 Pixel]
    A --> D[Match Window]

    B --> B1[Scale canvas to fill tab area<br>preserving aspect ratio]
    C --> C1[Render at native resolution<br>with scrollbars if larger than tab]
    D --> D1[Request session resolution<br>matching current tab size<br>dynamic resize on tab resize]
```

## Clipboard Integration

```mermaid
sequenceDiagram
    participant L as Local Clipboard
    participant T as termiHub (frontend)
    participant R as RDP Backend (Rust)
    participant S as Remote Windows

    Note over L,S: Copy from Remote → Local
    S->>R: Clipboard update (text/image)
    R->>T: emit("rdp-clipboard-update", data)
    T->>L: navigator.clipboard.writeText(text)

    Note over L,S: Copy from Local → Remote
    T->>T: Detect canvas focus + paste event
    T->>L: navigator.clipboard.readText()
    L-->>T: Clipboard content
    T->>R: invoke("rdp_send_clipboard", {data})
    R->>S: Send clipboard to RDP channel
```

Clipboard sync is bidirectional for text content. Image clipboard support is a stretch goal (requires
format conversion between Windows CF_DIB and PNG).

## Connection Lifecycle

```mermaid
flowchart TD
    A[User clicks Connect on RDP connection] --> B[Create RDP session via Tauri command]
    B --> C[Open new tab with contentType: rdp]
    C --> D[Backend: resolve hostname]
    D --> E[Backend: TLS handshake]
    E --> F{NLA required?}
    F -->|Yes| G[CredSSP / NLA authentication]
    F -->|No| H[RDP security negotiation]
    G --> I{Auth success?}
    H --> I
    I -->|No| J[Show auth error in tab]
    I -->|Yes| K[Capability exchange]
    K --> L[Graphics channel active]
    L --> M[Stream bitmap updates to canvas]
    M --> N{Session end?}
    N -->|User disconnect| O[Close tab]
    N -->|Server disconnect| P[Show reconnect prompt]
    N -->|Network error| Q[Show error + reconnect option]
    P --> R{Reconnect?}
    Q --> R
    R -->|Yes| B
    R -->|No| O
```

## Authentication Methods

```mermaid
flowchart TD
    A[RDP Authentication] --> B{Security mode?}

    B -->|Auto| C{Server supports NLA?}
    C -->|Yes| D[NLA / CredSSP]
    C -->|No| E[TLS + RDP auth]

    B -->|NLA| D
    B -->|TLS| E
    B -->|RDP| F[Classic RDP encryption<br>legacy, insecure]

    D --> G{Credential source?}
    E --> G
    F --> G

    G -->|Saved in credential store| H[Use stored password]
    G -->|Prompt| I[Show password dialog]
    G -->|None configured| I

    H --> J[Authenticate]
    I --> J
```

Supported authentication:

- **NLA (Network Level Authentication)** — CredSSP with NTLM or Kerberos. This is the default and most
  secure option. IronRDP supports CredSSP with NTLM; Kerberos is a stretch goal.
- **TLS** — TLS encryption with RDP-level password authentication.
- **RDP** — Legacy RDP encryption. Included for compatibility with old servers but shown with a
  security warning.

## Resolution Negotiation & Dynamic Resize

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant B as RDP Backend
    participant S as RDP Server

    Note over U,S: Initial connection
    F->>B: connect({host, resolution: "match_window", tabSize: 1200x800})
    B->>S: RDP Connect (requested: 1200×800)
    S-->>B: Session established at 1200×800
    B-->>F: emit("rdp-connected", {width: 1200, height: 800})
    F->>F: Initialize canvas at 1200×800

    Note over U,S: Tab resized (split view / window resize)
    U->>F: Resize tab to 900×600
    F->>F: Debounce resize (300ms)
    F->>B: invoke("rdp_resize", {sessionId, width: 900, height: 600})
    B->>S: Display Control Channel: resize to 900×600
    S-->>B: Desktop resized, new bitmap
    B-->>F: emit("rdp-frame", {bitmap, width: 900, height: 600})
    F->>F: Resize canvas, render new frame
```

Dynamic resize uses the RDP Display Control Channel (available in RDP 8.1+). For older servers that
don't support dynamic resize, the session stays at the initially negotiated resolution and the canvas
scales to fit.

## Input Handling

```mermaid
flowchart TD
    A[User Input in Canvas] --> B{Input Type}

    B -->|Keyboard| C[Capture keydown/keyup events]
    C --> D[Convert to RDP scancode]
    D --> E[Send keyboard input PDU]

    B -->|Mouse Move| F[Capture mousemove event]
    F --> G[Calculate position relative to canvas]
    G --> H{Scale mode?}
    H -->|Fit to Tab| I[Reverse-scale coordinates<br>to remote resolution]
    H -->|1:1| J[Add scroll offset]
    H -->|Match Window| K[Use coordinates directly]
    I --> L[Send mouse move PDU]
    J --> L
    K --> L

    B -->|Mouse Click| M[Capture mousedown/mouseup]
    M --> N[Map button: left/right/middle]
    N --> O[Send mouse button PDU]

    B -->|Mouse Wheel| P[Capture wheel event]
    P --> Q[Send mouse wheel PDU]
```

Mouse coordinate mapping is critical when using "Fit to Tab" mode — screen coordinates from the
browser canvas must be reverse-scaled to the remote desktop's resolution. The frontend handles this
transformation before sending coordinates to the backend.

## Drive Redirection

```mermaid
sequenceDiagram
    participant U as User
    participant B as RDP Backend
    participant S as RDP Server
    participant FS as Local Filesystem

    Note over U,S: During connection setup
    U->>B: Enable drive redirection<br>path: /Users/admin/shared
    B->>S: Virtual channel: RDPDR<br>Announce drive "termiHub" at path

    Note over U,S: Remote user accesses drive
    S->>B: RDPDR: Read file request<br>\\tsclient\termiHub\report.docx
    B->>FS: Read /Users/admin/shared/report.docx
    FS-->>B: File contents
    B-->>S: RDPDR: File data response
```

The RDPDR (RDP Device Redirection) virtual channel is handled by IronRDP's channel infrastructure.
The mapped drive appears as `\\tsclient\termiHub` in the remote Windows session.

## Session Reconnection

```mermaid
stateDiagram-v2
    [*] --> Connected: Connection established

    Connected --> Disconnected: Network error
    Connected --> Disconnected: Server-initiated disconnect
    Connected --> UserDisconnected: User closes tab

    Disconnected --> Reconnecting: Auto-reconnect enabled
    Disconnected --> ShowPrompt: Auto-reconnect disabled
    ShowPrompt --> Reconnecting: User clicks Reconnect
    ShowPrompt --> [*]: User dismisses

    Reconnecting --> Connected: Reconnection success
    Reconnecting --> ReconnectFailed: Timeout / auth failure

    ReconnectFailed --> Reconnecting: Retry (max 3 attempts)
    ReconnectFailed --> ShowPrompt: Max retries exceeded

    UserDisconnected --> [*]: Tab closed
```

When the network drops, the RDP tab shows a semi-transparent overlay: "Connection lost.
Reconnecting... (attempt 2/3)" with a cancel button.

## RDP Session State Machine

```mermaid
stateDiagram-v2
    [*] --> Initializing: create_rdp_session()

    state Initializing {
        [*] --> ResolvingHost
        ResolvingHost --> Connecting: DNS resolved
        Connecting --> TlsHandshake: TCP connected
        TlsHandshake --> Authenticating: TLS established
        Authenticating --> NegotiatingCapabilities: Auth success
        NegotiatingCapabilities --> Ready: Capabilities exchanged
    }

    Initializing --> AuthFailed: Authentication error
    Initializing --> ConnectFailed: Network / TLS error

    AuthFailed --> [*]: User dismisses
    AuthFailed --> Initializing: Retry with new credentials
    ConnectFailed --> [*]: User dismisses
    ConnectFailed --> Initializing: Retry

    Ready --> Active: First frame received
    Active --> Active: Frame updates, input events

    Active --> Resizing: Tab resize event
    Resizing --> Active: New resolution confirmed

    Active --> Disconnected: Network error
    Active --> ServerDisconnected: Server logoff / shutdown
    Active --> [*]: User disconnect

    Disconnected --> Reconnecting: Auto-reconnect
    Reconnecting --> Initializing: Retry connection
    Reconnecting --> [*]: Max retries exceeded

    ServerDisconnected --> [*]: Session ended
```

## Frame Rendering Pipeline

```mermaid
sequenceDiagram
    participant S as RDP Server
    participant D as Decoder (Rust)
    participant C as Canvas (Frontend)

    loop Continuous during active session
        S->>D: Bitmap update PDU (compressed)
        D->>D: Decode RFX / NSCodec / bitmap
        D->>D: Apply to framebuffer (dirty region)
        D-->>C: emit("rdp-frame", {x, y, w, h, pixels})
        C->>C: ctx.putImageData(pixels, x, y)
    end

    Note over S,C: Only dirty regions are transmitted<br>and rendered — not the full screen
```

The backend maintains a full framebuffer in Rust memory. On each bitmap update, only the changed
(dirty) region is decoded and sent to the frontend as raw RGBA pixel data. The frontend uses
`CanvasRenderingContext2D.putImageData()` to update only the dirty rectangle, minimizing rendering
overhead.

### Frame Data Transfer Options

```mermaid
flowchart TD
    A[Frame Update in Rust] --> B{Transfer method}

    B -->|Tauri events + base64| C[Encode RGBA as base64<br>emit via event system]
    C --> C1[Simple but ~33% overhead<br>from base64 encoding]

    B -->|Tauri events + ArrayBuffer| D[Send raw bytes via<br>Tauri event payload]
    D --> D1[Efficient, minimal overhead<br>Tauri 2 supports byte arrays]

    B -->|SharedArrayBuffer| E[Shared memory between<br>Rust and WebView]
    E --> E1[Fastest but complex setup<br>requires COOP/COEP headers]
```

## Full Connection Sequence

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend (React)
    participant S as Store (Zustand)
    participant B as Backend (Rust / IronRDP)
    participant R as RDP Server

    U->>F: Double-click RDP connection
    F->>S: createTab({contentType: "rdp", config})
    S->>B: invoke("create_rdp_session", {config})
    B->>B: Look up password from credential store
    B->>R: TCP connect to host:3389
    R-->>B: TCP established
    B->>R: TLS handshake
    R-->>B: TLS established
    B->>R: CredSSP / NLA (NTLM)
    R-->>B: Auth success
    B->>R: Capability exchange, channel setup
    R-->>B: Session ready, initial resolution
    B-->>F: emit("rdp-connected", {sessionId, width, height})
    F->>F: Create <canvas>, set dimensions
    F->>S: updateTab({sessionId})

    loop Active session
        R->>B: Bitmap update (dirty region)
        B->>B: Decode bitmap to RGBA
        B-->>F: emit("rdp-frame", {sessionId, x, y, w, h, pixels})
        F->>F: putImageData on canvas
    end

    loop User input
        U->>F: Keyboard / mouse event
        F->>B: invoke("rdp_send_input", {sessionId, event})
        B->>R: Input PDU
    end

    U->>F: Close tab
    F->>B: invoke("close_rdp_session", {sessionId})
    B->>R: Disconnect PDU
    B-->>F: Session closed
    F->>S: removeTab(tabId)
```

## Clipboard Sync State Machine

```mermaid
stateDiagram-v2
    [*] --> Idle: Clipboard channel ready

    Idle --> RemoteCopy: Remote clipboard update notification
    RemoteCopy --> RequestingData: Request clipboard data from server
    RequestingData --> ReceivedData: Data received
    ReceivedData --> WritingLocal: Write to local clipboard
    WritingLocal --> Idle: Done

    Idle --> LocalCopy: User pastes in canvas
    LocalCopy --> ReadingLocal: Read local clipboard
    ReadingLocal --> SendingData: Send to remote via CLIPRDR channel
    SendingData --> Idle: Done

    note right of Idle: Clipboard sync only active<br>when feature is enabled
```

## Connection Type Routing

```mermaid
flowchart TD
    A[Connection clicked in sidebar] --> B{Connection type?}
    B -->|terminal: ssh, local, telnet, serial, docker| C[SessionManager.create_session]
    C --> D[Terminal tab with xterm.js]
    B -->|rdp| E[RdpManager.create_session]
    E --> F[RDP tab with canvas]
```

## Implementation Phases

```mermaid
gantt
    title RDP Sessions Implementation Phases
    dateFormat X
    axisFormat %s

    section Phase 1 — Core Connection
    RdpConfig + connection editor schema        :a1, 0, 2
    IronRDP integration + basic connect/auth    :a2, 2, 4
    Frame rendering pipeline (Rust → canvas)    :a3, 4, 3
    Keyboard + mouse input forwarding           :a4, 5, 3

    section Phase 2 — UI Integration
    RDP tab + panel components                  :b1, 8, 3
    Toolbar (Ctrl+Alt+Del, fullscreen, scale)   :b2, 9, 2
    Tab bar + split view integration            :b3, 10, 2
    Status bar RDP indicators                   :b4, 11, 1

    section Phase 3 — Features
    Clipboard sync (CLIPRDR)                    :c1, 12, 3
    Dynamic resize (Display Control Channel)    :c2, 12, 2
    Scale modes (fit, 1:1, match)               :c3, 14, 2
    Credential store integration                :c4, 14, 1

    section Phase 4 — Advanced (Stretch)
    Drive redirection (RDPDR)                   :d1, 16, 3
    Audio playback redirection                  :d2, 16, 3
    Session reconnection                        :d3, 19, 2
    Certificate management (trust store)        :d4, 19, 2
```
