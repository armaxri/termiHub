# Plugin System — Behavior

Behavior diagrams for the [plugin-system concept](concept.md). State machines, sequences, and
flows live here; visual layout lives in [`mockups/`](mockups/).

---

## Plugin Lifecycle (Install → Activate → Use → Deactivate)

```mermaid
sequenceDiagram
    actor User
    participant UI as Plugin Manager UI
    participant Store as App Store
    participant PM as Plugin Manager (Rust)
    participant FS as File System
    participant Plugin as Plugin Runtime

    Note over User,Plugin: Installation
    User->>UI: Click "Install from file..."
    UI->>PM: install_plugin(file_path)
    PM->>FS: Validate & extract package
    PM->>FS: Copy to plugins directory
    PM->>PM: Validate manifest & permissions
    PM-->>UI: Plugin metadata
    UI->>User: Show permission prompt

    Note over User,Plugin: Activation
    User->>UI: Click "Install & Enable"
    UI->>PM: enable_plugin(plugin_id)
    PM->>Plugin: Load and initialize
    Plugin->>PM: Register extension points
    PM->>Store: Update available backends/themes
    Store->>UI: Re-render with new options

    Note over User,Plugin: Usage
    User->>UI: Create terminal with plugin backend
    UI->>PM: create_session(plugin_config)
    PM->>Plugin: Instantiate backend
    Plugin-->>PM: TerminalBackend instance
    PM->>PM: Manage session normally

    Note over User,Plugin: Deactivation
    User->>UI: Click "Disable"
    UI->>PM: disable_plugin(plugin_id)
    PM->>PM: Check for active sessions
    PM->>Plugin: Shutdown
    PM->>Store: Remove extension points
```

## Plugin Discovery and Loading

On application startup, the Plugin Manager scans the plugins directory for installed plugins:

```mermaid
flowchart TD
    A[App starts] --> B[Scan plugins directory]
    B --> C{Plugins found?}
    C -->|No| D[Continue with built-in features only]
    C -->|Yes| E[For each plugin]
    E --> F[Read manifest.json]
    F --> G{Manifest valid?}
    G -->|No| H[Log warning, skip plugin]
    G -->|Yes| I{Plugin enabled?}
    I -->|No| J[Register as disabled in store]
    I -->|Yes| K{API version compatible?}
    K -->|No| L[Log error, mark incompatible]
    K -->|Yes| M[Load plugin]
    M --> N{Load successful?}
    N -->|No| O[Log error, mark failed]
    N -->|Yes| P[Initialize & register extensions]

    H --> E
    J --> E
    L --> E
    O --> E
    P --> E

    style A fill:#2d2d2d,stroke:#007acc,color:#fff
    style D fill:#2d2d2d,stroke:#4ec9b0,color:#fff
    style P fill:#2d2d2d,stroke:#4ec9b0,color:#fff
    style H fill:#2d2d2d,stroke:#f44747,color:#fff
    style L fill:#2d2d2d,stroke:#f44747,color:#fff
    style O fill:#2d2d2d,stroke:#f44747,color:#fff
```

## Plugin Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> NotInstalled

    NotInstalled --> Installing: User selects plugin file
    Installing --> Installed: Validation & extraction succeed
    Installing --> NotInstalled: Validation fails

    Installed --> Enabling: User clicks "Enable"
    Installed --> Uninstalling: User clicks "Uninstall"

    Enabling --> Active: Load & init succeed
    Enabling --> Error: Load or init fails

    Active --> Disabling: User clicks "Disable"
    Active --> Error: Runtime crash
    Active --> Incompatible: App update breaks API

    Disabling --> Installed: Shutdown complete

    Error --> Enabling: User clicks "Retry"
    Error --> Uninstalling: User clicks "Uninstall"

    Incompatible --> Enabling: Plugin updated
    Incompatible --> Uninstalling: User clicks "Uninstall"

    Uninstalling --> NotInstalled: Files removed

    state Active {
        [*] --> Idle
        Idle --> InUse: Terminal session created
        InUse --> Idle: All sessions closed
    }
```

## Terminal Backend Plugin Session Flow

```mermaid
sequenceDiagram
    actor User
    participant UI as Connection Dialog
    participant API as api.ts
    participant TM as Terminal Manager
    participant PR as Plugin Registry
    participant PB as Plugin Backend

    User->>UI: Select plugin connection type
    UI->>UI: Render plugin-provided config form
    User->>UI: Fill config & click Connect
    UI->>API: createTerminal(pluginConfig)
    API->>TM: create_session(config)
    TM->>PR: lookup_backend_factory(plugin_id)
    PR-->>TM: factory_fn
    TM->>PB: factory_fn.create(config, output_sender)
    PB->>PB: Initialize connection
    PB-->>TM: Box<dyn TerminalBackend>

    loop Terminal I/O
        User->>API: sendInput(session_id, data)
        API->>TM: send_input(session_id, data)
        TM->>PB: write_input(data)
        PB-->>TM: Output via channel
        TM-->>UI: terminal-output event
    end

    User->>API: closeTerminal(session_id)
    API->>TM: close_session(session_id)
    TM->>PB: close()
    PB->>PB: Cleanup resources
```

## Protocol Parser Plugin Data Flow

```mermaid
sequenceDiagram
    participant Backend as Terminal Backend
    participant TM as Terminal Manager
    participant PP as Protocol Parser Plugin
    participant Term as xterm.js

    Backend->>TM: Raw output bytes
    TM-->>Term: terminal-output event

    Note over PP,Term: Parser operates in WebView

    Term->>PP: onData hook (raw text)
    PP->>PP: Parse & annotate
    PP-->>Term: Decorated output (ANSI sequences)

    Note over PP,Term: Example: Log colorizer adds<br/>color codes to ERROR/WARN lines
```

## Theme Plugin Loading

```mermaid
sequenceDiagram
    participant PM as Plugin Manager
    participant FS as File System
    participant TE as Theme Engine
    participant Doc as Document Root

    PM->>FS: Read theme.json from plugin dir
    FS-->>PM: ThemeDefinition JSON
    PM->>PM: Validate against ThemeColors schema
    PM->>TE: registerTheme(pluginId, definition)
    TE->>TE: Add to available themes

    Note over TE,Doc: When user selects plugin theme

    TE->>Doc: Apply CSS custom properties
    TE->>TE: Notify theme change listeners
```

## Plugin Installation Sequence

```mermaid
sequenceDiagram
    actor User
    participant UI as Plugin Manager UI
    participant API as api.ts
    participant PM as Plugin Manager (Rust)
    participant FS as File System

    User->>UI: Click "Install from file..."
    UI->>UI: Open native file picker
    User->>UI: Select .termihub-plugin file
    UI->>API: validate_plugin(file_path)
    API->>PM: validate_plugin(file_path)

    PM->>FS: Open ZIP archive
    PM->>PM: Read manifest.json from archive
    PM->>PM: Validate manifest schema
    PM->>PM: Check API version compatibility

    alt Validation fails
        PM-->>UI: Error (reason)
        UI->>User: Show error message
    else Validation succeeds
        PM-->>UI: PluginManifest
        UI->>User: Show permissions prompt
        User->>UI: Confirm install

        UI->>API: install_plugin(file_path)
        API->>PM: install_plugin(file_path)
        PM->>FS: Create plugins/<plugin-id>/
        PM->>FS: Extract archive contents
        PM->>FS: Write plugin state (disabled)
        PM-->>UI: InstallResult (success)
        UI->>User: Plugin installed (disabled)
    end
```

## Plugin Manager Startup Sequence

```mermaid
sequenceDiagram
    participant App as Application
    participant PM as Plugin Manager
    participant FS as File System
    participant Store as App Store
    participant TE as Theme Engine
    participant TM as Terminal Manager

    App->>PM: initialize()
    PM->>FS: Scan plugins directory

    loop For each plugin directory
        PM->>FS: Read manifest.json
        PM->>PM: Validate manifest

        alt Plugin enabled in settings
            PM->>PM: Check API compatibility

            alt Compatible
                PM->>PM: Load plugin

                alt Terminal Backend plugin
                    PM->>TM: register_backend_factory(id, factory)
                end

                alt Theme plugin
                    PM->>TE: registerTheme(id, definition)
                end

                PM->>Store: Add to active plugins
            else Incompatible
                PM->>Store: Add as incompatible
            end
        else Plugin disabled
            PM->>Store: Add as disabled
        end
    end

    PM-->>App: Initialization complete
```

## Error Recovery State Machine

```mermaid
stateDiagram-v2
    [*] --> Healthy: Plugin loaded successfully

    Healthy --> SessionError: Backend operation fails
    SessionError --> Healthy: Error handled gracefully
    SessionError --> PluginError: Repeated failures

    Healthy --> PluginError: Plugin crashes
    PluginError --> Recovering: Auto-restart attempt
    Recovering --> Healthy: Restart succeeds
    Recovering --> Disabled: Max retries exceeded (3)

    Disabled --> Healthy: User manually re-enables

    note right of SessionError
        Individual session fails
        Other sessions unaffected
    end note

    note right of PluginError
        Plugin process/library error
        All plugin sessions affected
    end note
```

## Security Considerations — Install/Permission Gate

```mermaid
flowchart TD
    A[Plugin Package] --> B{Signature valid?}
    B -->|Yes| C[Extract to sandbox]
    B -->|No / Unsigned| D[Warn user: untrusted source]
    D --> E{User accepts risk?}
    E -->|No| F[Cancel installation]
    E -->|Yes| C

    C --> G{Permissions declared?}
    G -->|Yes| H[Show permission prompt]
    G -->|No| I[Install with no permissions]

    H --> J{User grants permissions?}
    J -->|Yes| K[Store granted permissions]
    J -->|No| F

    K --> L[Plugin installed]
    I --> L

    style F fill:#2d2d2d,stroke:#f44747,color:#fff
    style L fill:#2d2d2d,stroke:#4ec9b0,color:#fff
```

## Architecture Overview

```mermaid
flowchart TD
    subgraph Frontend [React Frontend - WebView]
        PMV[Plugin Manager View]
        PSD[Plugin Settings Dialog]
        PID[Plugin Install Dialog]
        TE[Theme Engine]
        PP[Protocol Parsers]
        SBW[Status Bar Widgets]
        CS[Connection Selector]
    end

    subgraph IPC [Tauri IPC Bridge]
        CMD[Plugin Commands]
        EVT[Plugin Events]
    end

    subgraph Backend [Rust Backend]
        PM[Plugin Manager]
        PR[Plugin Registry]
        TM[Terminal Manager]
        FS[File System]
    end

    subgraph Plugins [Loaded Plugins]
        RP[Rust Backend Plugins]
        JP[JS Frontend Plugins]
        TP[Theme JSON Files]
    end

    PMV <-->|invoke| CMD
    PSD <-->|invoke| CMD
    PID <-->|invoke| CMD
    CMD <--> PM
    EVT --> PMV

    PM --> PR
    PM --> FS
    PR --> TM
    TM --> RP

    TE --> TP
    PP --> JP
    SBW --> JP
    CS -->|plugin types| PR

    style Frontend fill:#1e3a1e,stroke:#4ec9b0,color:#fff
    style Backend fill:#2d1e3a,stroke:#b07acc,color:#fff
    style Plugins fill:#3a2e1e,stroke:#cca700,color:#fff
```

---

## Session Filtering & State Rules

| Plugin state   | Behavior in the Plugin Manager                                         |
| -------------- | ---------------------------------------------------------------------- |
| `active`       | Extension points registered; backend/theme available; green state dot  |
| `disabled`     | Installed but not loaded; no extension points; grey state dot          |
| `error`        | Load/init failed; error message in detail panel; red state dot + Retry |
| `incompatible` | API version mismatch; auto-disabled; red state dot; prompt to update   |
| `installed`    | Freshly extracted, awaiting first enable; grey state dot               |

## Edge Cases

| Scenario                                     | Behavior                                                       |
| -------------------------------------------- | -------------------------------------------------------------- |
| Two plugins provide the same connection type | Second type is suffixed with the plugin name to disambiguate   |
| Plugin and core theme share a name           | Core theme wins; plugin theme is prefixed with the plugin name |
| Plugin directory not writable                | Clear error with the path and required permissions             |
| Plugin dependency missing (e.g. `kubectl`)   | Actionable instructions shown in the detail panel              |
| App update changes the plugin API version    | Incompatible plugins auto-disabled with a notification         |
| Plugin file larger than 50 MB                | Installation rejected; size limit enforced before extraction   |
| Concurrent install/uninstall                 | Operations serialized to prevent race conditions               |
