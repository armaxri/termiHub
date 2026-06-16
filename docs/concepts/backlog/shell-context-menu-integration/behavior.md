# Shell Context Menu & CLI Spawn Integration — Behavior

Behavior diagrams for the [shell-context-menu-integration concept](concept.md). State machines,
sequences, and flows live here; in-app visual layout lives in [`mockups/`](mockups/).

---

## Top-Level Spawn Flow

Every spawn request — whether from an OS file-manager context menu entry or a terminal user running
`termiHub spawn` — funnels through the same IPC path and either attaches to a running window or
launches a new one.

```mermaid
flowchart LR
    A[OS File Manager<br>Right-Click] -->|calls| B[termiHub spawn CLI]
    C[Terminal User<br>termiHub spawn] --> B
    B -->|IPC socket / pipe| D{termiHub running?}
    D -->|Yes| E[Focus window<br>Open session tab]
    D -->|No| F[Launch termiHub<br>Open session on ready]
```

## Spawn Request — Full State Machine

```mermaid
stateDiagram-v2
    [*] --> SpawnInvoked: termiHub spawn --location /path

    SpawnInvoked --> ConnectingIPC: Attempt IPC socket connection

    ConnectingIPC --> RoutingToExisting: Connected (termiHub running)
    ConnectingIPC --> LaunchingApp: Connection refused (not running)<br>or --new-window flag

    state RoutingToExisting {
        [*] --> SendingRequest: Send SpawnRequest via IPC
        SendingRequest --> FocusingWindow: Request received by app
        FocusingWindow --> ResolvingConnection
        ResolvingConnection --> ShowingPicker: No default / --pick flag
        ResolvingConnection --> OpeningSession: Default resolved
        ShowingPicker --> OpeningSession: User selects connection
        ShowingPicker --> [*]: User cancels
        OpeningSession --> CdToPath: Shell / container started
        CdToPath --> [*]: Session ready
    }

    state LaunchingApp {
        [*] --> StartingProcess: Spawn termiHub process
        StartingProcess --> WaitingForUI: App loading
        WaitingForUI --> ProcessingQueuedRequest: UI ready
        ProcessingQueuedRequest --> ResolvingConnectionNew
        ResolvingConnectionNew --> ShowingPickerNew: No default / --pick flag
        ResolvingConnectionNew --> OpeningSessionNew: Default resolved
        ShowingPickerNew --> OpeningSessionNew: User selects
        OpeningSessionNew --> [*]: Session ready
    }
```

## Full Spawn Sequence (Existing Instance)

```mermaid
sequenceDiagram
    participant OS as OS File Manager
    participant CLI as termiHub (spawn client mode)
    participant IPC as IPC Socket / Named Pipe
    participant App as termiHub (running app)
    participant UI as termiHub Frontend

    OS->>CLI: invoke "termiHub spawn --entry-id abc --location /path"
    CLI->>IPC: connect to socket

    alt termiHub is running
        IPC-->>CLI: connected
        CLI->>IPC: SpawnRequest { entryId, location, newWindow: false }
        IPC->>App: route to SpawnHandler
        App->>UI: window.set_focus()
        App->>App: resolve connection type for entryId

        alt default connection resolved
            App->>UI: open new session tab
            UI-->>App: session created
            App->>App: post-start: execute "cd /path"
            App->>UI: show spawn toast notification
        else no default → show picker
            App->>UI: show SpawnPicker dialog
            UI-->>App: user selects connection + optional "remember"
            alt user clicked Remember
                App->>App: save as new default, re-register context menu
            end
            App->>UI: open new session tab
        end

        IPC-->>CLI: SpawnResponse { status: Ok }
        CLI->>CLI: exit 0

    else termiHub is NOT running (connection refused)
        IPC-->>CLI: connection refused
        CLI->>CLI: launch new termiHub process<br>with --pending-spawn args
        Note over CLI: CLI process exits immediately
        App->>App: startup normally
        App->>App: detect pending spawn args
        App->>UI: UI load complete
        App->>App: process pending SpawnRequest
        App->>UI: open session tab
    end
```

## Spawn Sequence — New Window

```mermaid
sequenceDiagram
    participant CLI as termiHub spawn --new-window
    participant IPC as IPC Socket
    participant Existing as Existing termiHub Window
    participant New as New termiHub Window

    CLI->>IPC: attempt connection
    IPC-->>CLI: connected (termiHub is running)
    Note over CLI: --new-window flag bypasses attach-to-existing
    CLI->>CLI: launch new termiHub process<br>with --new-window --location /path
    Note over CLI: does NOT send to IPC; exits
    New->>New: startup → open session at /path
    Note over Existing: existing window unaffected
```

## Context Menu Registration Flow

```mermaid
flowchart TD
    A[User clicks Install in Settings<br>or runs termiHub install-shell-integration] --> B[Read configured entries from settings]
    B --> C{Platform?}

    C -->|Windows| D[Write HKCU registry keys<br>for each entry]
    D --> D1[Directory\\shell\\]
    D --> D2[Directory\\Background\\shell\\]
    D --> D3["*\\shell\\ for files"]
    D1 & D2 & D3 --> Z

    C -->|macOS| E[Generate .workflow bundles<br>for each entry]
    E --> E1[Write to ~/Library/Services/]
    E1 --> E2[Update NSServices in Info.plist<br>if needed]
    E2 --> Z

    C -->|Linux| F[Write .desktop file<br>to ~/.local/share/applications/]
    F --> G[call update-desktop-database]
    G --> H{Nautilus scripts dir exists?}
    H -->|Yes| H1[Install shell scripts<br>to ~/.local/share/nautilus/scripts/]
    H -->|No| I{KDE service menus dir exists?}
    H1 --> I
    I -->|Yes| I1[Write termihub.desktop to<br>kservices5 or kio/servicemenus/]
    I -->|No| J{Thunar uca.xml exists?}
    I1 --> J
    J -->|Yes| J1[Append Thunar custom action<br>via XML]
    J -->|No| Z
    J1 --> Z

    Z[Update registration timestamp<br>and status in settings.json]
    Z --> Done[Show success in Settings panel]
```

## Docker Container Mount Sequence

```mermaid
sequenceDiagram
    participant U as User
    participant P as SpawnPicker Dialog
    participant B as termiHub Backend
    participant D as Docker / Podman Daemon
    participant S as Session Manager

    U->>P: Select "New container…" under Docker
    P->>P: Expand image selector inline
    U->>P: Choose ubuntu:22.04, mount as /workspace
    U->>P: Click Open

    P->>B: SpawnContainerSession { runtime: docker, image: ubuntu:22.04, mountSource: /path, mountTarget: /workspace }
    B->>D: docker run -d -it -v /path:/workspace ubuntu:22.04 bash
    D-->>B: containerId

    B->>S: CreateSession { type: docker_spawned, containerId, workDir: /workspace }
    S-->>B: sessionId

    B-->>P: OK
    P->>P: Close dialog
    Note over B,S: Session tab opens, labelled "ubuntu:22.04 (spawned)"
    B->>S: execute "cd /workspace" in session
```

## Binary Path Staleness Check

```mermaid
flowchart TD
    A[termiHub launches] --> B[Read registered exe path<br>from settings.json]
    B --> C{Path matches<br>current_exe?}
    C -->|Yes| D[No action needed]
    C -->|No| E[Show stale-registration banner<br>in Settings]
    E --> F{User clicks Reinstall?}
    F -->|Yes| G[Re-run registration<br>with new exe path]
    F -->|No / dismissed| H[Banner persists until<br>user acts or uninstalls]
    G --> I[Update stored path in settings.json]
    I --> D
```

## Session Picker — User Interaction State

```mermaid
stateDiagram-v2
    [*] --> Loading: Picker dialog opens

    Loading --> Ready: Local shells, WSL, Docker, Podman enumerated

    Ready --> LocalSelected: User clicks local shell
    Ready --> WSLSelected: User clicks WSL distro (Windows)
    Ready --> DockerExpanded: User clicks "New container…" (Docker)
    Ready --> PodmanExpanded: User clicks "New container…" (Podman)

    DockerExpanded --> ImageSelected: User picks image
    PodmanExpanded --> ImageSelected
    ImageSelected --> ContainerConfigured: Mount path set

    LocalSelected --> Confirming
    WSLSelected --> Confirming
    ContainerConfigured --> Confirming

    Confirming --> RememberingChoice: "Remember" checked → save default
    Confirming --> Opening: "Remember" unchecked
    RememberingChoice --> Opening

    Opening --> [*]: Session opens, dialog closes
    Ready --> [*]: User cancels
```
