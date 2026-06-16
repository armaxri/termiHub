# Macro Recording — Behavior

Behavior diagrams for the [Macro Recording and Playback](concept.md) concept. The prose lives in
[`concept.md`](concept.md); the visual surfaces live in [`mockups/`](mockups/).

---

## Macro Manager Flow

```mermaid
graph TD
    A[Activity Bar: Macros icon] --> B[Macro Sidebar Panel]
    B --> C{Action}
    C -->|"+ Record"| D[Start Recording on Active Terminal]
    C -->|Right-click → Play| E[Play on Active Terminal]
    C -->|Right-click → Play on...| F[Target Picker Dialog]
    C -->|Right-click → Edit| G[Macro Editor Tab]
    C -->|"↓ Import"| H[File Picker → Import]
    C -->|Right-click → Export| I[Save File Dialog]
    D --> J[Recording... Status Bar Shows REC]
    J --> K[Stop Recording]
    K --> L[Save Macro Dialog]
    L --> B
    F --> M{Has Template Variables?}
    M -->|Yes| N[Parameter Prompt]
    M -->|No| O[Playback with Progress Overlay]
    N --> O
    E --> M
```

---

## Recording State Machine

```mermaid
stateDiagram-v2
    [*] --> Idle

    Idle --> Recording : Start recording
    Recording --> Saving : Stop recording
    Recording --> Idle : Terminal closed / disconnected

    Saving --> Idle : Discard
    Saving --> Idle : Save

    state Recording {
        [*] --> Capturing
        Capturing --> Capturing : Keystroke received
    }
```

---

## Playback State Machine

```mermaid
stateDiagram-v2
    [*] --> Idle

    Idle --> PromptingVariables : Play macro (has variables)
    Idle --> SelectingTargets : Play on... (target picker)
    Idle --> Executing : Play macro (no variables, active terminal)

    SelectingTargets --> PromptingVariables : Targets selected (has variables)
    SelectingTargets --> Executing : Targets selected (no variables)
    SelectingTargets --> Idle : Cancel

    PromptingVariables --> Executing : Variables filled
    PromptingVariables --> Idle : Cancel

    Executing --> Idle : Playback complete
    Executing --> Cancelled : User cancels
    Executing --> Error : Terminal disconnected

    Cancelled --> Idle
    Error --> Idle

    state Executing {
        [*] --> SendingStep
        SendingStep --> WaitingDelay : Step sent
        WaitingDelay --> SendingStep : Delay elapsed, more steps
        WaitingDelay --> [*] : All steps sent
    }
```

---

## Recording Sequence

```mermaid
sequenceDiagram
    participant U as User
    participant TB as Toolbar / Shortcut
    participant T as Terminal Component
    participant R as MacroRecorder
    participant API as sendInput (API)
    participant B as Backend

    U->>TB: Click Record / Shortcut
    TB->>R: startRecording(sessionId)
    R->>R: Initialize step buffer, start timer

    loop Each keystroke
        U->>T: Type keystroke
        T->>R: captureInput(data, timestamp)
        R->>R: Append step to buffer
        T->>API: sendInput(sessionId, data)
        API->>B: write(data)
    end

    U->>TB: Click Stop / Shortcut
    TB->>R: stopRecording()
    R->>U: Show save dialog
    U->>R: Provide name, tags → Save
    R->>R: Persist macro to storage
```

---

## Playback Sequence

```mermaid
sequenceDiagram
    participant U as User
    participant S as Macro Sidebar
    participant P as PlaybackEngine
    participant API as sendInput (API)
    participant T1 as Terminal 1
    participant T2 as Terminal 2

    U->>S: Right-click → Play on...
    S->>U: Show target picker
    U->>S: Select terminals 1 & 2
    S->>U: Show variable prompt (if any)
    U->>S: Fill variables → Continue
    S->>P: play(macro, [session1, session2], variables)

    loop Each step
        P->>P: Substitute variables in step data
        par Send to all targets
            P->>API: sendInput(session1, data)
            API->>T1: write(data)
            P->>API: sendInput(session2, data)
            API->>T2: write(data)
        end
        P->>P: Wait for delay (per delay mode)
        P->>U: Update progress overlay
    end

    P->>U: Playback complete notification
```

---

## Integration Overview

```mermaid
graph TD
    subgraph Frontend
        AB[Activity Bar] -->|"macros" view| MS[Macro Sidebar]
        MS --> ME[Macro Editor Tab]
        MS --> TP[Target Picker Dialog]
        MS --> VP[Variable Prompt Dialog]

        TC[Terminal Component] --> MR[MacroRecorder Hook]
        MR -->|captures input| TC
        MR -->|save| MAPI[Macro Storage API]

        PE[PlaybackEngine] -->|sendInput| API[api.ts]
        PE -->|progress| PO[Progress Overlay]
    end

    subgraph Backend
        API -->|invoke send_input| SM[SessionManager]
        MCMD[Macro Commands] -->|CRUD| MF[macros.json]
        MAPI --> MCMD
    end

    subgraph Storage
        MF[(macros.json)]
    end
```

---

## Backend Integration Overview

```mermaid
graph TD
    subgraph "New Files"
        MT[src/types/macro.ts]
        MR[src/hooks/useMacroRecorder.ts]
        MP[src/services/macroPlayback.ts]
        MSUI[src/components/MacroSidebar/]
        MEUI[src/components/MacroEditor/]
        MDUI[src/components/MacroDialogs/]
        MCMD[src-tauri/src/commands/macros.rs]
        MSTO[src-tauri/src/macros/storage.rs]
    end

    subgraph "Modified Files"
        AB[ActivityBar.tsx - add macros view]
        SB[Sidebar.tsx - add macros branch]
        TT[terminal.ts - add macro-editor content type]
        TC[Terminal.tsx - integrate recorder hook]
        AS[appStore.ts - add macro state/actions]
        SET[settings types - add MacroSettings]
        SBR[StatusBar.tsx - add recording indicator]
        MAIN[main.rs - register macro commands]
    end

    MT --> MSUI
    MT --> MEUI
    MT --> AS
    MR --> TC
    MP --> MSUI
    MCMD --> MSTO
    MSTO --> |"macros.json"| DISK[(Disk)]
```
