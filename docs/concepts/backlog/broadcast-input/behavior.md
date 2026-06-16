# Broadcast Input — Behavior

Behavior diagrams for the [broadcast-input concept](concept.md). State machines, sequences, and
flows live here; visual layout lives in [`mockups/`](mockups/).

---

## Activation Workflow

```mermaid
flowchart TD
    A[User clicks Broadcast button\nor presses Ctrl+Shift+B] --> B{First activation\nor shortcut?}
    B -->|Toolbar click| C[Show target scope dropdown]
    B -->|Keyboard shortcut| D{Has previous scope?}
    D -->|Yes| E[Use last scope]
    D -->|No| F[Default: All terminals]
    C --> G[User selects scope]
    G --> H[Activate broadcast mode]
    E --> H
    F --> H
    H --> I[Set source = active terminal]
    H --> J[Apply visual indicators\nto all targets]
    H --> K[Show status bar indicator]
    H --> L[Intercept input from source\nand mirror to targets]
```

## Input Flow During Broadcast

```mermaid
sequenceDiagram
    participant User
    participant XTerm as xterm.js (source)
    participant BC as BroadcastService
    participant API as sendInput (api.ts)
    participant T1 as Terminal 1 (source)
    participant T2 as Terminal 2 (target)
    participant T3 as Terminal 3 (target)

    User->>XTerm: Types "uptime\r"
    XTerm->>BC: onData("uptime\r")
    BC->>BC: Check broadcast active
    BC->>BC: Get target session IDs
    par Send to all targets
        BC->>API: sendInput(session1, "uptime\r")
        API->>T1: Write to PTY stdin
        BC->>API: sendInput(session2, "uptime\r")
        API->>T2: Write to PTY stdin
        BC->>API: sendInput(session3, "uptime\r")
        API->>T3: Write to PTY stdin
    end
    Note over T1,T3: Each terminal shows its own independent output
```

## Broadcast Mode State Machine

```mermaid
stateDiagram-v2
    [*] --> Inactive

    Inactive --> ScopeSelection: User clicks\nBroadcast button
    Inactive --> Active: Keyboard shortcut\n(uses last scope)

    ScopeSelection --> Active: User confirms scope
    ScopeSelection --> Inactive: User cancels

    Active --> Active: Target added/removed\n(tab opened/closed/toggled)
    Active --> Inactive: User deactivates\n(button, shortcut, or\nsource tab closed)

    state Active {
        [*] --> Broadcasting
        Broadcasting --> Broadcasting: Input received →\nmirror to targets
        Broadcasting --> NoTargets: All targets\ndisconnected
        NoTargets --> Broadcasting: Target reconnects
    }
```

## Activation Sequence

```mermaid
sequenceDiagram
    participant User
    participant Toolbar as Broadcast Button
    participant Dropdown as Scope Dropdown
    participant Store as Zustand Store
    participant StatusBar as Status Bar
    participant Terminals as Terminal Panels

    User->>Toolbar: Click broadcast button
    Toolbar->>Dropdown: Show scope options
    User->>Dropdown: Select "All terminals"
    Dropdown->>Store: setBroadcast({ active: true, scope: "all", sourceTabId, targetTabIds })
    Store->>StatusBar: Update indicator
    Store->>Terminals: Apply broadcast borders
    Note over Terminals: All terminal panels show amber border
    Note over StatusBar: "◉ Broadcast (5 terminals)"
```

## Deactivation Sequence

```mermaid
sequenceDiagram
    participant User
    participant Source as Source Terminal
    participant Store as Zustand Store
    participant StatusBar as Status Bar
    participant Terminals as Terminal Panels

    alt User clicks broadcast button on source
        User->>Source: Click broadcast button
    else User presses shortcut
        User->>Source: Ctrl+Shift+B
    else Source tab closed
        Source->>Store: Tab close event
    end

    Store->>Store: setBroadcast({ active: false })
    Store->>StatusBar: Remove indicator
    Store->>Terminals: Remove broadcast borders
    Note over Terminals: All panels return to normal appearance
```

## Target Exclusion Sequence

```mermaid
sequenceDiagram
    participant User
    participant Target as Target Terminal
    participant Store as Zustand Store
    participant StatusBar as Status Bar

    Note over Target: Terminal is currently a broadcast target
    User->>Target: Click broadcast button
    Target->>Store: removeBroadcastTarget(tabId)
    Store->>Target: Remove broadcast border
    Store->>StatusBar: Update count "◉ Broadcast (3 terminals)"
    Note over Target: Terminal no longer receives broadcast input

    User->>Target: Click broadcast button again
    Target->>Store: addBroadcastTarget(tabId)
    Store->>Target: Apply broadcast border
    Store->>StatusBar: Update count "◉ Broadcast (4 terminals)"
```

## Input Routing Decision Flow

```mermaid
flowchart TD
    A[xterm.onData fires\nwith input data] --> B{Is broadcast\nmode active?}
    B -->|No| C[sendInput to\ncurrent session only]
    B -->|Yes| D{Is this terminal\nthe broadcast source?}
    D -->|No| C
    D -->|Yes| E[Get broadcast target\nsession IDs from store]
    E --> F{Filter connected\nsessions only}
    F --> G[sendInput to each\ntarget session in parallel]
    G --> H[Each terminal shows\nindependent output]
```

## Architecture Overview

```mermaid
flowchart LR
    subgraph "Terminal Input Path"
        XT[xterm.js onData] --> BC[Broadcast Check]
        BC -->|Not active| SI1[sendInput\nsingle session]
        BC -->|Active + source| BCS[BroadcastService]
        BCS --> SI2[sendInput × N\nall target sessions]
    end

    subgraph "State Management"
        ZS[Zustand Store] --> BS[Broadcast State]
        BS --> BC
        BS --> VI[Visual Indicators]
    end

    subgraph "UI"
        TB[Toolbar Button] --> ZS
        SB[Status Bar] --> ZS
        VI --> Borders[Panel Borders]
        VI --> Badges[Tab Badges]
    end

    style BCS fill:#e87d0d,stroke:#333,color:#fff
    style BS fill:#e87d0d,stroke:#333,color:#fff
```

## Session Filtering Rules

| Session state                   | Behavior                                  |
| ------------------------------- | ----------------------------------------- |
| Connected                       | Receives input normally                   |
| Disconnected                    | Skipped silently (no per-keystroke error) |
| Connecting                      | Skipped (avoid input during handshake)    |
| Non-terminal tab (editor, SFTP) | Always excluded from broadcast            |

## Edge Cases

| Scenario                                          | Behavior                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Only one terminal open                            | Broadcast activates but has no effect (input goes to the single terminal)      |
| Source terminal loses focus                       | Broadcast remains active; input resumes when focus returns to source terminal  |
| User switches active tab in source panel          | Broadcast continues from whichever tab is active in the source panel           |
| User drags a target tab to a different panel      | The tab remains in the broadcast group (tracked by tab ID, not panel position) |
| Resize event on source terminal                   | Only the source terminal is resized — broadcast does not mirror resize events  |
| Terminal type mismatch (SSH vs. local vs. serial) | All terminal types receive the same raw input; output varies per backend       |
| Broadcast + chord shortcut pending                | Chord keystrokes are not broadcast — they are consumed by the shortcut system  |
