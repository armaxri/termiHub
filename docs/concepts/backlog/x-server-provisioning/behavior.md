# X Server Provisioning — Behavior

Behavior diagrams for the [x-server-provisioning concept](concept.md). State machines, sequences,
and flows live here; visual layout lives in [`mockups/`](mockups/).

> **Transport note.** termiHub forwards X11 via **reverse SSH port-forwarding**
> (`tcpip_forward`), not the native `x11-req` channel, because russh does not expose `x11-req`.
> That transport half already exists (`core/src/backends/ssh/x11.rs`). These diagrams cover only
> the **provisioning half** — ensuring a local X server exists for that transport to proxy into.

---

## Top-level: ensure a server when an X11 session opens

```mermaid
flowchart TD
    A[User opens SSH connection\nwith enableX11Forwarding] --> B{Reachable local\nX server detected?}
    B -->|Yes| Z[Adopt existing server\nDISPLAY + cookie]
    B -->|No| C{provideXServerAutomatically\nenabled?}
    C -->|No| W[Warn: no X server;\nforwarding will not display]
    C -->|Yes| D{Platform?}
    D -->|Windows| E[Provision VcXsrv\nsee 'Windows provisioning']
    D -->|macOS| F[Guided XQuartz install\nsee 'macOS']
    D -->|Linux| G[Classify gap + hint\nsee 'Linux']
    E --> Z
    F --> Z
    G --> H{Server now\nreachable?}
    H -->|Yes| Z
    H -->|No| W
    Z --> Y[Transport half proxies\nremote X clients to display :N]
    style E fill:#e87d0d,stroke:#333,color:#fff
```

## Per-platform decision

```mermaid
flowchart LR
    subgraph WIN[Windows]
        W1[No native X server] --> W2[Download/adopt VcXsrv\nspawn + manage]
    end
    subgraph MAC[macOS]
        M1[No embeddable server] --> M2[Detect XQuartz]
        M2 -->|present| M3[open -a XQuartz]
        M2 -->|missing| M4[Guided install\nbrew / .pkg / link]
    end
    subgraph LIN[Linux]
        L1[Xorg / XWayland\nalmost always present] --> L2[Detect + adopt]
        L2 -->|gap| L3[Targeted hint\nno bundle]
    end
    style W2 fill:#e87d0d,stroke:#333,color:#fff
```

## Windows provisioning workflow (VcXsrv)

```mermaid
flowchart TD
    A[ensure_x_server: Windows] --> B{VcXsrv reachable\nat 127.0.0.1:6000?}
    B -->|Yes| Z[Adopt external server]
    B -->|No| C{Pinned VcXsrv\nextracted in data dir?}
    C -->|Yes| L[Launch managed server]
    C -->|No| D{Bundled with app?}
    D -->|Yes| K[Copy into place] --> L
    D -->|No| E[Show consent prompt]
    E -->|Not now| W[Skip: no server]
    E -->|Download & Enable| F[Download pinned .zip\nfrom GitHub releases]
    F --> G[Verify SHA-256]
    G -->|mismatch| G2[Discard + retry once] --> F
    G -->|ok| H[Extract → atomic rename]
    H --> L
    L --> M[Generate MIT-MAGIC-COOKIE-1\nwrite .Xauthority]
    M --> N["vcxsrv.exe :0 -multiwindow\n-clipboard -auth <file>"]
    N --> O[Register managed server\ndisplay :0 + cookie]
    O --> Z
    style F fill:#e87d0d,stroke:#333,color:#fff
    style L fill:#e87d0d,stroke:#333,color:#fff
```

## Binary resolution order (mirrors agent_setup.rs)

```mermaid
flowchart LR
    A[Need VcXsrv] --> B{cache\nvcxsrv-version/}
    B -->|hit| Z[Use path]
    B -->|miss| C{bundled\nwith app}
    C -->|hit| Y[Copy to cache] --> Z
    C -->|miss| D[Download pinned zip] --> E[Verify sha256] --> F[Unzip] --> Z
```

## X server lifecycle state machine

```mermaid
stateDiagram-v2
    [*] --> Absent

    Absent --> Adopted: external server\ndetected on :0/6000
    Absent --> Downloading: provision consented
    Downloading --> Verifying: zip fetched
    Verifying --> Downloading: checksum mismatch\n(retry once)
    Verifying --> Extracting: checksum ok
    Extracting --> Starting: files in place
    Starting --> Running: process up + reachable
    Starting --> Failed: spawn/port error

    Running --> Running: new X11 session\nadopts same server
    Running --> Idle: last X11 session closed
    Idle --> Running: new X11 session opens
    Idle --> Stopped: stopXServerWhenIdle\nor app exit
    Adopted --> [*]: app exit\n(external left running)
    Running --> Stopped: app exit\n(managed killed)
    Failed --> Absent: user retries
    Stopped --> [*]
```

## Session open sequence (Windows, managed server)

```mermaid
sequenceDiagram
    participant User
    participant Conn as connector.rs (X11 startup)
    participant Orch as ensure_x_server()
    participant Mgr as XServerManager
    participant Acq as acquire.rs
    participant VcX as vcxsrv.exe
    participant Fwd as X11Forwarder (transport)

    User->>Conn: Open SSH conn (enableX11Forwarding)
    Conn->>Orch: ensure_x_server()
    Orch->>Mgr: status()
    alt server already running/adopted
        Mgr-->>Orch: Running(:0, cookie)
    else must provision
        Orch->>User: consent prompt (download ~N MB?)
        User-->>Orch: Download & Enable
        Orch->>Acq: resolve VcXsrv (cache→bundled→download+verify+unzip)
        Acq-->>Orch: path
        Orch->>Mgr: start(path)
        Mgr->>Mgr: gen cookie + write .Xauthority
        Mgr->>VcX: spawn :0 -multiwindow -auth <file>
        Mgr-->>Orch: Running(:0, cookie)
    end
    Orch-->>Conn: LocalXServerInfo(:0, cookie)
    Conn->>Fwd: start forwarding to display :0 (known cookie)
    Note over Fwd,VcX: remote GUI apps now render as native windows
```

## Detection decision flow (`detect_local_x_server`)

```mermaid
flowchart TD
    A[detect_local_x_server] --> M{Managed server\nregistered?}
    M -->|Yes| R1[Return Tcp 127.0.0.1:6000\n+ known cookie]
    M -->|No| B{DISPLAY set?}
    B -->|Yes| R2[Parse DISPLAY → info]
    B -->|No| U{Unix?}
    U -->|Yes| S[Scan /tmp/.X11-unix]
    U -->|No: Windows| T{TCP 127.0.0.1:6000\nopen?}
    S -->|found| R3[UnixSocket info]
    S -->|none| N[None]
    T -->|open| R4[Tcp info\ncookie via xauth or none]
    T -->|closed| N
    style M fill:#e87d0d,stroke:#333,color:#fff
    style T fill:#e87d0d,stroke:#333,color:#fff
```

## macOS guided install sequence

```mermaid
sequenceDiagram
    participant User
    participant Orch as ensure_x_server()
    participant FS as /opt/X11 probe
    participant Inst as installer / brew
    participant XQ as XQuartz

    Orch->>FS: exists(/opt/X11 & XQuartz.app)?
    alt present
        Orch->>XQ: open -a XQuartz
        Orch-->>User: ready (DISPLAY via ssh -X/-Y)
    else missing
        Orch->>User: prompt (Install XQuartz?)
        User-->>Orch: Install (brew | .pkg)
        Orch->>Inst: brew install --cask xquartz\nOR installer -pkg … -target / (admin)
        Inst-->>Orch: installed
        Orch->>XQ: open -a XQuartz
    end
```

## Idle shutdown sequence

```mermaid
sequenceDiagram
    participant S1 as X11 session A
    participant S2 as X11 session B
    participant Mgr as XServerManager
    participant VcX as vcxsrv.exe

    S1->>Mgr: register (refcount 1)
    S2->>Mgr: register (refcount 2, adopts same server)
    S1->>Mgr: close (refcount 1)
    S2->>Mgr: close (refcount 0)
    alt stopXServerWhenIdle = on
        Mgr->>VcX: terminate
        Note over Mgr,VcX: managed server stopped when idle
    else keep running
        Note over Mgr,VcX: stays up until app exit
    end
```

## Architecture overview

```mermaid
flowchart TB
    subgraph FE[Frontend]
        SET[Settings toggle\nprovideXServerAutomatically]
        PRMPT[First-run consent + progress]
        OC[Open Connections\n'X Servers' section]
    end
    subgraph IPC[Tauri commands / events]
        CMD[x_server_status / _ensure / _stop\n_install_dependency]
        EVT[progress events\ndownload / verifying / status]
    end
    subgraph BE[Backend]
        ORCH[orchestrator.rs\nensure_x_server]
        MGR[manager.rs\nspawn/supervise/reuse]
        ACQ[acquire.rs\nresolve+download+verify+unzip]
        AUTH[auth.rs\ncookie + .Xauthority]
        DET[x11.rs\nmanaged-aware detection]
        PORT[portable.rs\nstorage path]
    end
    SET --> CMD
    PRMPT --> CMD
    OC --> CMD
    CMD --> ORCH
    ORCH --> MGR
    MGR --> ACQ
    MGR --> AUTH
    ACQ --> PORT
    ORCH --> DET
    MGR --> EVT
    EVT --> PRMPT
    style MGR fill:#e87d0d,stroke:#333,color:#fff
    style ORCH fill:#e87d0d,stroke:#333,color:#fff
```

## Edge cases

| Scenario                                             | Behavior                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| User already runs VcXsrv / X410 / Xming on `:0`      | Adopt it (TCP 6000 probe); do not spawn a duplicate                             |
| Port 6000 taken by a non-X process                   | Pick the next free display number; register that display                        |
| Download fails / checksum mismatch                   | Discard, retry once, then surface an actionable error (never run a bad binary)  |
| Offline, pinned version already cached               | No network call; launch from cache                                              |
| Portable install                                     | Store VcXsrv under `<data>/xserver/…` next to the exe; nothing outside app tree |
| Managed VcXsrv dies mid-session                      | `ensure_running()` restarts it on next use                                      |
| App exit with sessions still open                    | Managed server killed (no orphan); adopted external server left running         |
| macOS without XQuartz, user declines install         | Session opens without GUI display; clear hint shown, no silent failure          |
| Linux Wayland-only session without XWayland          | Detect gap; hint to install `xwayland`; do not bundle                           |
| Flatpak/Snap sandbox blocks the X socket             | Detect; hint to adjust sandbox `--socket=x11`; packaging-level fix              |
| macOS/Linux forwarding on a headless client box      | No local display to forward to; surface that it is a setup limitation           |
| `provideXServerAutomatically` off, no server present | Warn only; never download/install                                               |
