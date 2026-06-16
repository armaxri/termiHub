# Embedded Unix Command Environment — Behavior

Behavior diagrams for the [embedded-unix-windows concept](concept.md). State machines, sequences,
and flows live here; visual layout lives in [`mockups/`](mockups/).

---

## Environment Lifecycle

```mermaid
stateDiagram-v2
    [*] --> NotInstalled: First install

    NotInstalled --> Checking: App startup
    Checking --> Available: Binaries valid
    Checking --> Corrupted: Binaries missing/invalid

    Available --> SessionStarting: User opens termiHub Bash
    SessionStarting --> Running: Shell spawned
    Running --> SessionEnded: User closes tab
    SessionEnded --> Available: Ready for next session

    Available --> Updating: Update available & accepted
    Updating --> Available: Update successful
    Updating --> Available: Update failed (keep current)

    Corrupted --> Repairing: User clicks Repair
    Repairing --> Available: Repair successful
    Repairing --> Corrupted: Repair failed

    Corrupted --> NotInstalled: User reinstalls termiHub
```

## Session Startup Sequence

```mermaid
sequenceDiagram
    participant User
    participant UI as Frontend (React)
    participant Backend as Tauri Backend
    participant Shell as Shell Detection
    participant PTY as portable-pty
    participant Bash as BusyBox bash.exe

    User->>UI: Click "New Terminal" (termiHub Bash)
    UI->>Backend: create_session("termihub-bash")
    Backend->>Shell: resolve_shell("termihub-bash")
    Shell->>Shell: Locate unix-env/bin/bash.exe
    Shell-->>Backend: (path, args, env)

    Backend->>Backend: Build environment variables
    Note over Backend: PATH = unix-env/bin + converted system PATH
    Note over Backend: HOME = /c/Users/<user>
    Note over Backend: TERM = xterm-256color

    Backend->>PTY: spawn(bash.exe, env, cwd)
    PTY->>Bash: Start bash process
    Bash->>Bash: Source /etc/profile
    Bash->>Bash: Source ~/.bashrc (if exists)
    Bash-->>PTY: Prompt output
    PTY-->>Backend: Output bytes
    Backend-->>UI: Terminal output stream
    UI-->>User: Bash prompt displayed
```

## Update Flow

```mermaid
flowchart TD
    A[App Startup] --> B{Last check > 24h ago?}
    B -->|No| C[Skip check]
    B -->|Yes| D[Fetch manifest from update server]
    D --> E{New version available?}
    E -->|No| F[Record check timestamp]
    E -->|Yes| G[Show update notification]
    G --> H{User response}
    H -->|Update Now| I[Download updated binaries]
    H -->|Remind Later| F
    H -->|Skip Version| J[Record skipped version]
    I --> K{Download successful?}
    K -->|Yes| L[Verify checksums]
    K -->|No| M[Show error, keep current]
    L --> N{Checksums match?}
    N -->|Yes| O[Backup current unix-env]
    N -->|No| M
    O --> P[Replace binaries]
    P --> Q{Replace successful?}
    Q -->|Yes| R[Update manifest.json]
    Q -->|No| S[Restore backup]
    R --> T[Delete backup]
    S --> M
```

## Shell Detection Flow (with termiHub Bash)

```mermaid
flowchart TD
    A[detect_available_shells] --> B{Platform?}
    B -->|Windows| C[Add PowerShell]
    B -->|macOS/Linux| D[Scan /etc/shells + env]

    C --> E[Add cmd]
    E --> F{unix-env/bin/bash.exe exists?}
    F -->|Yes| G[Verify busybox integrity]
    G --> H{Valid?}
    H -->|Yes| I["Add 'termihub-bash'"]
    H -->|No| J[Log warning, skip]
    F -->|No| J

    I --> K{Git Bash installed?}
    J --> K
    K -->|Yes| L[Add gitbash]
    K -->|No| M{WSL installed?}
    L --> M
    M -->|Yes| N[Detect WSL distros]
    M -->|No| O[Return shell list]
    N --> O
```

## Environment Integrity Check

```mermaid
flowchart TD
    A[Integrity Check] --> B[Read manifest.json]
    B --> C{manifest exists?}
    C -->|No| D[Status: Corrupted]
    C -->|Yes| E[For each entry in manifest]
    E --> F{File exists?}
    F -->|No| G[Mark file missing]
    F -->|Yes| H{Checksum matches?}
    H -->|Yes| I[File OK]
    H -->|No| J[Mark file corrupted]
    G --> K{All files checked?}
    J --> K
    I --> K
    K -->|No| E
    K -->|Yes| L{Any issues?}
    L -->|No| M[Status: Available]
    L -->|Yes| N{Critical files affected?}
    N -->|Yes| D
    N -->|No| O[Status: Degraded - list missing tools]
```

## Portable Mode Interaction

```mermaid
flowchart TD
    A[App Launch] --> B{Portable mode?}
    B -->|Yes| C[unix-env relative to app dir]
    B -->|No| D[unix-env in install dir]
    C --> E[HOME = portable data dir]
    D --> F["HOME = /c/Users/&lt;user&gt;"]
    E --> G[Check unix-env integrity]
    F --> G
    G --> H[Start shell session]
```

## Implementation Phases

```mermaid
gantt
    title Implementation Phases
    dateFormat YYYY-MM-DD
    axisFormat %b %Y

    section Phase 1: Core
    Build script for unix-env assembly       :p1a, 2026-04-01, 5d
    Shell detection for termihub-bash        :p1b, after p1a, 3d
    Environment setup (PATH, HOME, etc.)     :p1c, after p1b, 3d
    Basic session lifecycle                  :p1d, after p1c, 3d

    section Phase 2: UI
    Shell dropdown integration               :p2a, after p1d, 2d
    Settings panel (status, tools list)      :p2b, after p2a, 3d
    First-run prompt                         :p2c, after p2b, 2d
    Tab title and status bar                 :p2d, after p2c, 1d

    section Phase 3: Reliability
    Manifest and integrity checking          :p3a, after p2d, 3d
    Repair functionality                     :p3b, after p3a, 2d
    Error handling and edge cases            :p3c, after p3b, 3d

    section Phase 4: Updates
    Update manifest and server setup         :p4a, after p3c, 3d
    Differential update download             :p4b, after p4a, 3d
    Update UI (notification, progress)       :p4c, after p4b, 2d
    Rollback mechanism                       :p4d, after p4c, 2d

    section Phase 5: Polish
    Portable mode integration                :p5a, after p4d, 2d
    CI pipeline integration                  :p5b, after p4d, 3d
    Testing and documentation                :p5c, after p5b, 5d
```
