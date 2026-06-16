# Package Manager — Behavior

Behavior diagrams for the [package-manager concept](concept.md). State machines, sequences, and
flows live here; visual layout lives in [`mockups/`](mockups/).

---

## Installing a Package

```mermaid
sequenceDiagram
    actor User
    participant UI as Package Manager UI
    participant Store as App Store
    participant PM as Package Manager (Rust)
    participant Net as HTTP Client
    participant FS as File System
    participant PS as Plugin System

    User->>UI: Click "Install" on package
    UI->>PM: install_package(package_id, version)
    PM->>PM: Resolve dependencies

    alt Has unmet dependencies
        PM-->>UI: Show dependency prompt
        User->>UI: Confirm install with deps
    end

    loop For each package to install
        PM->>Net: Download package archive
        Net-->>PM: Package bytes + checksum
        PM->>PM: Verify SHA-256 checksum
        PM->>PM: Verify code signature (if signed)

        alt Plugin package
            PM->>FS: Extract to plugins/<id>/
            PM->>PS: register_plugin(plugin_id)
            PS-->>PM: Plugin metadata
        else Tool package
            PM->>FS: Extract to tools/<id>/
            PM->>PM: Update PATH registry
        end
    end

    PM->>Store: Update installed packages list
    PM-->>UI: Installation complete
    UI->>User: Show success notification
```

## Updating Packages

```mermaid
flowchart TD
    A[Check for updates] --> B[Fetch index.json from all repos]
    B --> C[Compare installed versions vs latest]
    C --> D{Updates available?}
    D -->|No| E[Show 'all up to date']
    D -->|Yes| F[Show update banner]

    F --> G{User action}
    G -->|Update All| H[Download & install all updates]
    G -->|Review| I[Show update list with changelogs]
    G -->|Dismiss| J[Hide banner until next check]

    I --> K{User selects updates}
    K --> H

    H --> L[For each update]
    L --> M{Plugin with active sessions?}
    M -->|Yes| N[Queue for next restart]
    M -->|No| O[Install immediately]
    N --> P[Notify: update pending restart]
    O --> Q[Replace old version]
    Q --> R[Re-register with Plugin System]

    style E fill:#2d2d2d,stroke:#4ec9b0,color:#fff
    style P fill:#2d2d2d,stroke:#cca700,color:#fff
    style R fill:#2d2d2d,stroke:#4ec9b0,color:#fff
```

## Dependency Resolution

```mermaid
flowchart TD
    A[Install request: package X] --> B[Read X's dependencies]
    B --> C{All deps satisfied?}
    C -->|Yes| D[Install X]
    C -->|No| E[Collect unmet deps]
    E --> F{Deps available in repos?}
    F -->|No| G[Report missing deps]
    F -->|Yes| H{Circular dependency?}
    H -->|Yes| I[Report circular dep error]
    H -->|No| J[Build install order via topological sort]
    J --> K[Show user: will install X + deps]
    K --> L{User confirms?}
    L -->|No| M[Cancel]
    L -->|Yes| N[Install in dependency order]
    N --> D

    style D fill:#2d2d2d,stroke:#4ec9b0,color:#fff
    style G fill:#2d2d2d,stroke:#f44747,color:#fff
    style I fill:#2d2d2d,stroke:#f44747,color:#fff
```

## Package Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> Available: Listed in repository

    Available --> Downloading: User clicks Install
    Downloading --> Installing: Download complete
    Downloading --> Available: Download failed / cancelled

    Installing --> Installed: Extraction + registration succeed
    Installing --> Available: Installation failed

    Installed --> Active: Plugin enabled / Tool in PATH
    Installed --> Uninstalling: User clicks Uninstall

    Active --> UpdateAvailable: New version in repo
    Active --> Uninstalling: User clicks Uninstall
    Active --> Installed: Plugin disabled

    UpdateAvailable --> Downloading: User clicks Update
    UpdateAvailable --> Active: User dismisses
    UpdateAvailable --> Uninstalling: User clicks Uninstall

    Uninstalling --> [*]: Files removed

    state Active {
        [*] --> Ready
        Ready --> InUse: Sessions using this package
        InUse --> Ready: All sessions closed
        InUse --> PendingUpdate: Update queued (sessions active)
        PendingUpdate --> Ready: App restart applies update
    }
```

## Update Check Sequence

```mermaid
sequenceDiagram
    participant Timer as Update Timer
    participant PM as Package Manager
    participant Net as HTTP Client
    participant Store as App Store
    participant UI as Package Manager UI

    Note over Timer: Triggered by interval<br/>(daily/weekly/manual)

    Timer->>PM: check_for_updates()

    loop For each configured repository
        PM->>Net: GET index.json (If-None-Match: etag)
        alt Index unchanged (304)
            Net-->>PM: Not Modified
        else Index updated (200)
            Net-->>PM: New index + ETag
            PM->>PM: Cache index locally
        end
    end

    PM->>PM: Compare installed versions<br/>with latest in merged index

    alt Updates found
        PM->>Store: Set availableUpdates list
        Store->>UI: Re-render update banner
    else No updates
        PM->>Store: Clear availableUpdates
    end
```

## Repository Source Resolution

```mermaid
flowchart TD
    A[Search for package X] --> B[Query all configured repos]
    B --> C[Repo 1: Official]
    B --> D[Repo 2: Community]
    B --> E[Repo 3: Corporate]

    C --> F{Found?}
    D --> G{Found?}
    E --> H{Found?}

    F -->|Yes| I[Priority 1]
    G -->|Yes| J[Priority 2]
    H -->|Yes| K[Priority 3]

    F -->|No| L[ ]
    G -->|No| M[ ]
    H -->|No| N[ ]

    I --> O{Multiple sources?}
    J --> O
    K --> O

    O -->|Yes| P[Use highest-priority source]
    O -->|No| Q[Use the single source]

    P --> R[Return package metadata]
    Q --> R

    style R fill:#2d2d2d,stroke:#4ec9b0,color:#fff
```

## Tool Package PATH Integration

```mermaid
sequenceDiagram
    participant PM as Package Manager
    participant FS as File System
    participant Cfg as PATH Config
    participant TM as Terminal Manager
    participant Shell as New Terminal Session

    PM->>FS: Extract tool to tools/<id>/bin/
    PM->>Cfg: Add tools/<id>/bin/ to managed PATH list
    PM->>Cfg: Persist managed PATH to config

    Note over TM,Shell: When a new terminal starts

    TM->>Cfg: Read managed PATH entries
    TM->>TM: Prepend managed entries to system PATH
    TM->>Shell: Spawn with augmented PATH

    Note over Shell: Tool binaries now available<br/>e.g., 'git', 'python', etc.
```

## Dependency Resolution Sequence

```mermaid
sequenceDiagram
    actor User
    participant UI as Package Manager UI
    participant PM as Package Manager
    participant Resolver as Dependency Resolver
    participant Net as HTTP Client

    User->>UI: Install package "ssh-tunnel-plugin"
    UI->>PM: install_package("ssh-tunnel-plugin", "latest")
    PM->>Resolver: resolve("ssh-tunnel-plugin")

    Resolver->>Resolver: Read manifest dependencies
    Note over Resolver: Requires: ssh-utils >=1.0

    Resolver->>Resolver: Check installed packages
    Note over Resolver: ssh-utils not installed

    Resolver->>Resolver: Check repo for ssh-utils
    Resolver->>Resolver: Read ssh-utils dependencies
    Note over Resolver: ssh-utils has no deps

    Resolver->>Resolver: Topological sort
    Resolver-->>PM: Install order:<br/>1. ssh-utils v1.2<br/>2. ssh-tunnel-plugin v1.0

    PM-->>UI: Dependencies to install
    UI->>User: "Will also install ssh-utils v1.2"
    User->>UI: Confirm

    PM->>Net: Download ssh-utils
    PM->>PM: Install ssh-utils
    PM->>Net: Download ssh-tunnel-plugin
    PM->>PM: Install ssh-tunnel-plugin
    PM-->>UI: All installed successfully
```

## Error Handling During Installation

```mermaid
stateDiagram-v2
    [*] --> DownloadStarted

    DownloadStarted --> DownloadProgress: Receiving bytes
    DownloadProgress --> DownloadProgress: More bytes
    DownloadProgress --> DownloadComplete: All bytes received
    DownloadProgress --> DownloadFailed: Network error

    DownloadFailed --> Retrying: Attempt < 3
    Retrying --> DownloadProgress: Resume download
    DownloadFailed --> UserNotified: Attempts exhausted

    DownloadComplete --> ChecksumVerify: Verify SHA-256
    ChecksumVerify --> ExtractionStarted: Checksum matches
    ChecksumVerify --> UserNotified: Checksum mismatch

    ExtractionStarted --> ExtractionComplete: Files extracted
    ExtractionStarted --> Rollback: Extraction error

    ExtractionComplete --> Registration: Register with Plugin/Tool system
    Registration --> Installed: Registration succeeds
    Registration --> Rollback: Registration fails

    Rollback --> UserNotified: Clean up partial files

    UserNotified --> [*]: User sees error message
    Installed --> [*]: Success

    note right of Rollback
        Partial installations are
        always cleaned up to prevent
        corrupted state
    end note
```

## Architecture Overview

```mermaid
flowchart TD
    subgraph Frontend [React Frontend]
        PMV[Package Manager View]
        BT[Browse Tab]
        IT[Installed Tab]
        PD[Package Detail]
        IC[Install Confirm]
        UB[Update Banner]
        PS[Package Settings]
    end

    subgraph IPC [Tauri IPC Bridge]
        CMD[Package Commands]
        EVT[Install Progress Events]
    end

    subgraph Backend [Rust Backend]
        PM[Package Manager]
        DR[Dependency Resolver]
        RC[Repository Client]
        DL[Download Manager]
        LS[Local State]
    end

    subgraph External [External]
        R1[Official Repo CDN]
        R2[Community Repo]
        R3[Corporate Repo]
    end

    subgraph Existing [Existing Systems]
        PLG[Plugin System]
        TM[Terminal Manager]
    end

    PMV --- BT
    PMV --- IT
    BT --> PD
    IT --> PD
    PD --> IC

    BT <-->|invoke| CMD
    IT <-->|invoke| CMD
    IC <-->|invoke| CMD
    PS <-->|invoke| CMD
    EVT --> PMV

    CMD <--> PM
    PM --> DR
    PM --> RC
    PM --> DL
    PM --> LS

    RC --> R1
    RC --> R2
    RC --> R3

    PM -->|register plugin| PLG
    PM -->|update PATH| TM

    style Frontend fill:#1e3a1e,stroke:#4ec9b0,color:#fff
    style Backend fill:#2d1e3a,stroke:#b07acc,color:#fff
    style External fill:#3a2e1e,stroke:#cca700,color:#fff
    style Existing fill:#1e2a3a,stroke:#007acc,color:#fff
```
