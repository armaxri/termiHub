# TermiHub Architecture Documentation

> Based on the [arc42](https://arc42.org) template for software architecture documentation.

---

## Table of Contents

1. [Introduction and Goals](#1-introduction-and-goals)
2. [Architecture Constraints](#2-architecture-constraints)
3. [Context and Scope](#3-context-and-scope)
4. [Solution Strategy](#4-solution-strategy)
5. [Building Block View](#5-building-block-view)
6. [Runtime View](#6-runtime-view)
7. [Deployment View](#7-deployment-view)
8. [Cross-cutting Concepts](#8-cross-cutting-concepts)
9. [Architecture Decisions](#9-architecture-decisions)
10. [Quality Requirements](#10-quality-requirements)
11. [Risks and Technical Debts](#11-risks-and-technical-debts)
12. [Glossary](#12-glossary)

---

## 1. Introduction and Goals

### Requirements Overview

**TermiHub** is a modern, cross-platform terminal hub designed for embedded development workflows. It provides a VS Code-like interface for managing multiple terminal connections with support for split views, drag-and-drop tabs, and organized connection management.

**Core capabilities:**

- **Multiple terminal types** — Local shells (zsh, bash, cmd, PowerShell, Git Bash), SSH, Telnet, and Serial
- **VS Code-inspired UI** — Activity bar, sidebar, split view support
- **Drag-and-drop tab management** — Up to 40 concurrent terminals
- **Connection organization** — Folder hierarchies with import/export
- **SSH file browser** — Drag-and-drop file transfer via SFTP
- **Session persistence** — Reconnect capabilities for remote connections
- **Cross-platform** — Windows, Linux, macOS

**Target use case:** Embedded development where local shells build the product, serial connections interface with test targets, remote Raspberry Pi agents maintain persistent sessions overnight, and file transfer between development machine and test targets is seamless.

### Quality Goals

| Priority | Quality Goal | Description |
|----------|-------------|-------------|
| 1 | Cross-platform | Run identically on Windows, Linux, and macOS |
| 2 | Performance | Support 40 concurrent terminals without degradation |
| 3 | Extensibility | Add new terminal types with minimal code changes |
| 4 | Reliability | Handle disconnections, reconnections, and errors gracefully |
| 5 | Usability | VS Code-familiar interface with minimal learning curve |

### Stakeholders

| Role | Contact | Expectations |
|------|---------|-------------|
| Creator / Lead Developer | Arne Maximilian Richter | Full-featured terminal hub for embedded development workflows |
| Embedded Developers | (Target users) | Reliable multi-protocol terminal with organized connections and file transfer |
| Contributors | (Open source) | Clear architecture, coding standards, and contribution workflow |

---

## 2. Architecture Constraints

### Technical Constraints

| Constraint | Rationale |
|-----------|-----------|
| **Tauri 2.x** as application framework | Small binary (~5 MB vs Electron's ~100 MB), lower memory footprint, Rust backend for performance and safety |
| **React 18 + TypeScript** for frontend | Mature ecosystem, best-in-class drag-and-drop (dnd-kit) and split view (react-resizable-panels) libraries |
| **Rust** for backend | Memory safety, cross-platform PTY/serial/SSH support, async I/O via tokio |
| **Windows 10 1809+** minimum | Required for ConPTY (Windows pseudo-terminal) support |
| **No credential encryption** (Phase 1) | Avoids platform keychain complexity; SSH passwords are prompted at connection time |

### Organizational Constraints

| Constraint | Rationale |
|-----------|-----------|
| Single developer (initially) | Architecture must be simple enough for one person to maintain |
| MIT License | Permissive open-source for broad adoption |
| GitHub-based workflow | Issues, PRs, Actions for CI/CD |

### Convention Constraints

| Constraint | Detail |
|-----------|--------|
| Conventional Commits | All commit messages follow the `type(scope): subject` format |
| Keep a Changelog | User-facing changes documented in CHANGELOG.md |
| Merge commits only | No squash or rebase merges — preserve full commit history |

---

## 3. Context and Scope

### Business Context

The following diagram shows TermiHub in its operational environment — an embedded development workflow where a developer interacts with multiple systems simultaneously.

```mermaid
graph TB
    DEV[Developer]

    subgraph "TermiHub"
        APP[Desktop Application]
    end

    LOCAL[Local OS<br/>Build tools, shells]
    SERIAL[Serial Devices<br/>Test targets, MCUs]
    SSH_HOST[SSH Servers<br/>Build servers, Raspberry Pi]
    TELNET_HOST[Telnet Servers<br/>Network equipment]
    FS[File Systems<br/>Local and remote via SFTP]

    DEV -->|Keyboard / Mouse| APP
    APP -->|PTY| LOCAL
    APP -->|COM / ttyUSB| SERIAL
    APP -->|SSH protocol| SSH_HOST
    APP -->|Telnet protocol| TELNET_HOST
    APP -->|SFTP / Local FS| FS
```

| Partner | Description |
|---------|-------------|
| **Developer** | Primary user interacting via keyboard and mouse |
| **Local OS** | Host operating system providing shells (bash, zsh, PowerShell, cmd, Git Bash) via PTY |
| **Serial Devices** | Embedded targets connected via USB-to-serial adapters |
| **SSH Servers** | Remote machines (build servers, Raspberry Pi test agents) accessed over SSH |
| **Telnet Servers** | Legacy network equipment accessed via Telnet |
| **File Systems** | Local and remote file systems for browsing and transfer |

### Technical Context

```mermaid
graph LR
    subgraph "TermiHub Process"
        WV[WebView<br/>React UI]
        IPC[Tauri IPC<br/>Commands + Events]
        RUST[Rust Backend]
    end

    WV <-->|JSON over IPC| IPC
    IPC <-->|Function calls| RUST

    RUST -->|ConPTY / forkpty| PTY[PTY API]
    RUST -->|serialport crate| SERIAL_API[Serial Port API]
    RUST -->|ssh2 crate| SSH_API[SSH/SFTP Protocol]
    RUST -->|tokio TcpStream| TELNET_API[TCP Socket]
    RUST -->|std::fs / ssh2::Sftp| FS_API[File System API]

    PTY --> OS[Operating System]
    SERIAL_API --> HW[Serial Hardware]
    SSH_API --> NET1[Network]
    TELNET_API --> NET2[Network]
```

| Channel | Technology | Format |
|---------|-----------|--------|
| Frontend ↔ Backend | Tauri IPC (commands + events) | JSON-serialized Rust structs |
| Backend → PTY | `portable-pty` crate (ConPTY on Windows, forkpty on Unix) | Raw bytes |
| Backend → Serial | `serialport` crate | Raw bytes |
| Backend → SSH | `ssh2` crate (libssh2) | SSH protocol (encrypted) |
| Backend → Telnet | `tokio::net::TcpStream` | Telnet protocol (IAC sequences) |
| Backend → Files | `std::fs` (local) / `ssh2::Sftp` (remote) | File I/O |

---

## 4. Solution Strategy

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Application framework | **Tauri 2** over Electron | ~5 MB binary (vs ~100 MB), lower memory, Rust backend, native system integration |
| Frontend framework | **React 18** over Svelte | Larger ecosystem, mature dnd-kit and react-resizable-panels libraries, better AI-assisted development support |
| State management | **Zustand** | Minimal boilerplate, single store, no provider wrappers, good TypeScript support |
| Backend language | **Rust** | Memory safety, cross-platform PTY/serial/SSH, async I/O with tokio |
| Terminal rendering | **xterm.js** | Industry-standard terminal emulator, canvas-based rendering, add-on ecosystem |
| Backend extensibility | **Trait-based design** | `TerminalBackend` trait allows adding new terminal types without modifying the manager |
| IPC pattern | **Commands + Events** | Commands for request-response (create terminal, send input), events for streaming (terminal output) |
| Connection storage | **JSON files** | Simple, human-readable, no database dependency for Phase 1 |
| Credential handling | **Prompt at connection** | No encryption complexity in Phase 1; passwords are never persisted to disk |

---

## 5. Building Block View

### Level 1: System Overview

```mermaid
graph TB
    subgraph "Tauri Desktop App"
        UI[React UI Layer]
        IPC[Tauri IPC Bridge]

        subgraph "Rust Backend"
            TM[Terminal Manager]
            LB[Local Backends]
            RB[Remote Backend Stub]

            LB --> PTY[PTY Sessions]
            LB --> SERIAL[Serial Ports]
            LB --> SSH[SSH Client]
            LB --> TELNET[Telnet Client]
        end
    end

    subgraph "Future: Raspberry Pi Agent"
        AGENT[Session Manager]
        AGENT --> SHELLS[Persistent Shells]
        AGENT --> SERIAL_PROXY[Serial Proxy]
    end

    UI <--> IPC
    IPC <--> TM
    TM --> LB
    TM -.-> RB

    RB -.->|SSH Tunnel| AGENT

    style RB stroke-dasharray: 5 5
    style AGENT stroke-dasharray: 5 5
    style SHELLS stroke-dasharray: 5 5
    style SERIAL_PROXY stroke-dasharray: 5 5
```

**Contained building blocks:**

| Building Block | Description |
|---------------|-------------|
| **React UI Layer** | Frontend application rendered in Tauri's WebView |
| **Tauri IPC Bridge** | Bidirectional communication layer between frontend and backend |
| **Terminal Manager** | Orchestrates terminal session lifecycle across all backend types |
| **Local Backends** | PTY, Serial, SSH, and Telnet implementations |
| **Remote Backend Stub** | Future proxy to Raspberry Pi agent (dashed = not yet implemented) |
| **Raspberry Pi Agent** | Future standalone binary for persistent remote sessions |

### Level 2: Frontend Components

```mermaid
graph LR
    subgraph "Frontend Components"
        APP[App Root]
        AB[Activity Bar]
        SB[Sidebar]
        TV[Terminal View]

        APP --> AB
        APP --> SB
        APP --> TV

        SB --> CL[Connection List]
        SB --> CE[Connection Editor]
        SB --> FB[File Browser]

        TV --> TL[Tab Layout]
        TV --> SP[Split Panels]

        TL --> TERM[Terminal Component]
        SP --> TERM
    end

    subgraph "Backend Services"
        TM[Terminal Manager]
        CM[Connection Manager]
        FM[File Manager]

        TM --> BACKENDS[Terminal Backends]
        CM --> CONFIG[Config Storage]
        FM --> SFTP[SFTP Client]
    end

    TERM <-.->|Tauri Events| TM
    CL <-.->|Tauri Commands| CM
    FB <-.->|Tauri Commands| FM
```

| Component | Location | Responsibility |
|-----------|----------|---------------|
| **Activity Bar** | `src/components/ActivityBar/` | Icon navigation (Connections, File Browser, Settings) |
| **Sidebar** | `src/components/Sidebar/` | Connection list, editor, file browser panels |
| **Terminal View** | `src/components/Terminal/` | Tab bar, split panels, xterm.js terminal instances |
| **App Store** | `src/store/appStore.ts` | Zustand store managing all frontend state |
| **API Service** | `src/services/api.ts` | Tauri command wrappers |
| **Event Service** | `src/services/events.ts` | Tauri event listeners and dispatcher |

### Level 2: Backend Modules

| Module | Location | Responsibility |
|--------|----------|---------------|
| **Terminal** | `src-tauri/src/terminal/` | Backend trait, manager, all terminal implementations |
| **Connection** | `src-tauri/src/connection/` | Config types, CRUD operations, file persistence |
| **Files** | `src-tauri/src/files/` | Local and SFTP file browsing, upload/download |
| **Monitoring** | `src-tauri/src/monitoring/` | SSH remote system monitoring (CPU, memory, disk, uptime) |
| **Commands** | `src-tauri/src/commands/` | Tauri IPC command handlers |
| **Events** | `src-tauri/src/events/` | Event emitters for terminal output streaming |
| **Utils** | `src-tauri/src/utils/` | Shell detection, env expansion, error helpers |

### Level 3: Terminal Backends

```mermaid
classDiagram
    class TerminalBackend {
        <<trait>>
        +spawn() Result~SessionId~
        +send_input(data: Bytes)
        +subscribe_output() Stream~Bytes~
        +resize(cols, rows)
        +close()
    }

    class LocalShell {
        -pty: PtySession
        -shell_type: ShellType
        +new(shell_type) Result~Self~
    }

    class SerialConnection {
        -port: SerialPort
        -config: SerialConfig
        -active: AtomicBool
        +new(config) Result~Self~
        +set_active(bool)
    }

    class SshConnection {
        -session: Session
        -channel: Channel
        -sftp: Option~Sftp~
        +new(config) Result~Self~
        +get_sftp() Result~Sftp~
    }

    class TelnetConnection {
        -stream: TcpStream
        +new(host, port) Result~Self~
    }

    class RemoteBackend {
        -agent_connection: AgentConnection
        -session_id: String
        +new(config) Result~Self~
        +reconnect() Result~()~
    }

    TerminalBackend <|.. LocalShell
    TerminalBackend <|.. SerialConnection
    TerminalBackend <|.. SshConnection
    TerminalBackend <|.. TelnetConnection
    TerminalBackend <|.. RemoteBackend

    class TerminalManager {
        -sessions: HashMap~SessionId, Box~dyn TerminalBackend~~
        +create_session(config) Result~SessionId~
        +close_session(id)
        +list_sessions() Vec~SessionInfo~
    }

    TerminalManager --> TerminalBackend
```

Each backend implements the same trait, so the `TerminalManager` can manage all session types uniformly. See [Adding a New Terminal Backend](contributing.md#adding-a-new-terminal-backend) in the contributing guide.

---

## 6. Runtime View

### Terminal Creation

```mermaid
sequenceDiagram
    participant UI as React UI
    participant Tauri as Tauri IPC
    participant TM as Terminal Manager
    participant Backend as Terminal Backend
    participant PTY as PTY/Serial/SSH

    UI->>Tauri: create_terminal(config)
    Tauri->>TM: create_session(config)
    TM->>Backend: spawn()
    Backend->>PTY: Open connection
    PTY-->>Backend: Success
    Backend-->>TM: SessionId
    TM-->>Tauri: SessionId
    Tauri-->>UI: SessionId
```

### Output Streaming

```mermaid
sequenceDiagram
    participant PTY as PTY/Serial/SSH
    participant Backend as Terminal Backend
    participant Tauri as Tauri IPC
    participant UI as React UI

    Note over Backend,PTY: Background async loop
    loop Output streaming
        PTY->>Backend: Data available
        Backend->>Backend: Coalesce chunks (up to 32 KB)
        Backend->>Tauri: emit("terminal-output", data)
        Tauri->>UI: Event received
        UI->>UI: Singleton dispatcher routes to terminal
        UI->>UI: Batch write via requestAnimationFrame
    end
```

### Input Handling

```mermaid
sequenceDiagram
    participant UI as React UI
    participant Tauri as Tauri IPC
    participant TM as Terminal Manager
    participant Backend as Terminal Backend
    participant PTY as PTY/Serial/SSH

    UI->>Tauri: send_input(sessionId, data)
    Tauri->>TM: send_input(sessionId, data)
    TM->>Backend: send_input(data)
    Backend->>PTY: Write data
```

### SSH File Transfer

```mermaid
sequenceDiagram
    participant UI as React UI
    participant Tauri as Tauri IPC
    participant FM as File Manager
    participant SFTP as SFTP Client
    participant Remote as SSH Server

    UI->>Tauri: sftp_download(session_id, remote_path)
    Tauri->>FM: download(session_id, remote_path)
    FM->>SFTP: open(remote_path)
    SFTP->>Remote: SSH_FXP_OPEN
    Remote-->>SFTP: File handle
    loop Read chunks
        SFTP->>Remote: SSH_FXP_READ
        Remote-->>SFTP: Data chunk
    end
    SFTP-->>FM: File contents
    FM-->>Tauri: Save to local path
    Tauri-->>UI: Download complete
```

### Tab Drag-and-Drop Between Panels

```mermaid
sequenceDiagram
    participant User
    participant DnD as DnD Kit
    participant Store as Zustand Store
    participant Tree as Panel Tree

    User->>DnD: Drag tab from Panel A
    DnD->>DnD: Show ghost overlay + drop zones
    User->>DnD: Drop on Panel B edge
    DnD->>Store: moveTabToPanel(tabId, targetPanelId, edge)
    Store->>Tree: Remove tab from source panel
    Store->>Tree: Split target panel at edge
    Store->>Tree: Insert tab in new panel
    Tree-->>Store: Updated panel tree
    Store-->>DnD: Re-render layout
```

---

## 7. Deployment View

### Desktop Application

```mermaid
graph TB
    subgraph "Developer Machine"
        subgraph "TermiHub Application"
            WV[WebView / React UI]
            RS[Rust Backend]
        end

        OS[Operating System]
        WV --> RS
        RS --> OS
    end

    subgraph "Build Artifacts"
        WIN[Windows: .msi / .exe<br/>x64]
        LINUX[Linux: .deb / .AppImage<br/>x64, ARM64]
        MAC[macOS: .dmg<br/>x64, ARM64]
    end
```

| Platform | Architectures | Installer Formats | Min OS Version |
|----------|--------------|-------------------|----------------|
| Windows | x64 | `.msi`, `.exe` | Windows 10 1809+ (ConPTY) |
| Linux | x64, ARM64 | `.deb`, `.AppImage` | WebKitGTK 4.1+ |
| macOS | x64 (Intel), ARM64 (Apple Silicon) | `.dmg` | macOS 10.15+ |

### CI/CD Pipeline

Three GitHub Actions workflows handle the build and release pipeline. See `.github/workflows/` for details.

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **Code Quality** | Push/PR to `main` | Linting, formatting, type checking, tests (all 3 OSes) |
| **Build** | Push/PR to `main` | Build Tauri app for all platforms |
| **Agent** | Push/PR to `main` | Agent crate formatting, linting, tests, ARM64 cross-compilation |
| **Release** | Tag `v*.*.*` | Create GitHub Release with platform installers |

See [Releasing](releasing.md) for the full release process.

### Development Scripts

The `scripts/` directory provides cross-platform helper scripts (`.sh` + `.cmd` variants) for common tasks: setup, dev server, build, test, format, quality checks, and clean. These mirror the CI checks locally. See [scripts/README.md](../scripts/README.md) for the full list.

### Future: Raspberry Pi Agent

```mermaid
graph TB
    subgraph "Developer Machine"
        APP[TermiHub Desktop]
    end

    subgraph "Raspberry Pi"
        AGENT[termihub-agent<br/>systemd service]
        AGENT --> SHELL[Persistent Shells]
        AGENT --> SERIAL_P[Serial Port Proxy]
        AGENT --> DB[(SQLite<br/>Session State)]
    end

    APP -->|SSH Tunnel + JSON-RPC| AGENT

    style DB stroke-dasharray: 5 5
```

The remote agent is a standalone Rust binary deployed to Raspberry Pi (ARM64). It maintains persistent terminal sessions that survive desktop disconnects. Communication uses JSON-RPC 2.0 over SSH stdio. See [Remote Protocol](remote-protocol.md) for the protocol specification.

---

## 8. Cross-cutting Concepts

### Error Handling

**Rust backend:**
- `anyhow::Result<T>` for application code
- `thiserror` for custom error types in library-facing APIs
- Error propagation with `?` operator, context added with `.context("description")`
- No `.unwrap()` in production code — all mutex locks use proper error propagation

**TypeScript frontend:**
- Try-catch around all Tauri IPC calls
- Error display in terminal pane when connections fail (inline, not modal)
- Graceful degradation: a failed terminal doesn't crash the app

### Async Patterns

- **Tokio** runtime for all async operations in Rust
- **Bounded channels** (`sync_channel(64)`) for terminal output with backpressure
- **Output coalescing**: backend reads coalesce pending chunks (up to 32 KB) into a single IPC event
- **Task cancellation**: each terminal session owns its async tasks, cleaned up on close

### IPC Communication

```
Frontend → Backend:  Tauri Commands (request-response, JSON-serialized)
Backend → Frontend:  Tauri Events (push-based, JSON-serialized)
```

- **Commands** for actions: `create_terminal`, `send_input`, `resize_terminal`, `close_terminal`
- **Events** for streaming: `terminal-output` events routed by session ID
- **Singleton dispatcher**: frontend uses O(1) Map-based routing instead of per-terminal global listeners

### State Management

The frontend uses a single **Zustand** store (`src/store/appStore.ts`) managing:

- **Panel layout** — Recursive tree of horizontal/vertical splits
- **Tab state** — Active tab, dirty flags, colors, CWD tracking
- **Connection/folder persistence** — Saved connections and folder hierarchy
- **Sidebar** — Active view, collapsed state
- **SFTP sessions** — File browser state per SSH connection

### Terminal Rendering

- **xterm.js** renders to `<canvas>`, not DOM elements
- **`@xterm/addon-fit`** handles terminal resize to fill container
- **`requestAnimationFrame` batching** reduces rendering overhead for high-throughput output
- Canvas rendering makes DOM-based testing impossible; see [Testing Strategy](testing.md)

### Credential Storage

**Phase 1 (current):** No credential encryption. SSH passwords are prompted at connection time and never written to disk. Connection files store host, port, username, and key path only.

**Future:** Platform keychains (Windows Credential Manager, macOS Keychain, Linux Secret Service) with encryption at rest as a portability option.

---

## 9. Architecture Decisions

### ADR-1: React over Svelte

**Context:** Choosing a frontend framework for a complex desktop UI with drag-and-drop, split views, and terminal rendering.

**Decision:** React 18 with TypeScript.

**Rationale:**
- Mature ecosystem with production-ready libraries (dnd-kit, react-resizable-panels, react-virtuoso)
- Better tooling for complex drag-and-drop interactions
- Larger community and more examples for AI-assisted development
- Better knowledge base for Claude Code contributions

**Trade-off:** Larger bundle size and more boilerplate compared to Svelte.

### ADR-2: Tauri over Electron

**Context:** Choosing a desktop application framework for a cross-platform terminal hub.

**Decision:** Tauri 2.x with Rust backend.

**Rationale:**
- ~5 MB binary vs Electron's ~100 MB
- Lower memory footprint (single WebView vs bundled Chromium)
- Rust backend provides memory safety and native performance
- Native system integration (serial ports, PTY, file system)

**Trade-off:** Smaller ecosystem than Electron, platform-specific WebView rendering differences.

### ADR-3: Trait-Based Backend

**Context:** Supporting multiple terminal types (PTY, serial, SSH, telnet, remote agent) with a unified management interface.

**Decision:** Rust `TerminalBackend` trait with one implementation per terminal type.

**Rationale:**
- Adding new terminal types requires only implementing the trait
- `TerminalManager` manages all types through a single `Box<dyn TerminalBackend>`
- Future remote backend can be added without modifying existing code
- Enables mock implementations for testing

### ADR-4: Zustand for State Management

**Context:** Managing complex frontend state (panel trees, tabs, connections, file browser) in a React application.

**Decision:** Zustand with a single store.

**Rationale:**
- Minimal boilerplate (no providers, reducers, or action creators)
- Excellent TypeScript support
- Single store simplifies state access and debugging
- No context provider wrappers needed

### ADR-5: No Credential Encryption in Phase 1

**Context:** SSH connections require authentication credentials.

**Decision:** Prompt for passwords at connection time; never persist passwords to disk.

**Rationale:**
- Avoids platform keychain complexity across three OSes
- Key-based authentication (recommended) doesn't require password storage
- Clear security boundary: connection files are safe to share/commit
- Future phases will add platform keychain integration

---

## 10. Quality Requirements

### Quality Requirements Overview

```mermaid
graph TD
    Q[Quality Goals]
    Q --> P[Performance]
    Q --> R[Reliability]
    Q --> X[Cross-Platform]
    Q --> E[Extensibility]
    Q --> U[Usability]

    P --> P1[40 concurrent terminals]
    P --> P2[Low memory per session]
    P --> P3[Responsive UI under load]

    R --> R1[Graceful disconnection handling]
    R --> R2[Session cleanup on close]
    R --> R3[No crash on backend errors]

    X --> X1[Windows + Linux + macOS]
    X --> X2[Platform-specific shell detection]
    X --> X3[Native serial/PTY support]

    E --> E1[New backends via trait]
    E --> E2[Plugin-friendly architecture]

    U --> U1[VS Code-familiar layout]
    U --> U2[Keyboard shortcuts]
    U --> U3[Drag-and-drop everywhere]
```

### Quality Scenarios

| Scenario | Quality | Stimulus | Response | Measure |
|----------|---------|----------|----------|---------|
| High terminal count | Performance | User opens 40 terminals | All terminals remain responsive | UI interaction latency < 100ms |
| Connection failure | Reliability | SSH server becomes unreachable | Error shown in terminal, app stays stable | No crash, clear error message |
| New protocol | Extensibility | Developer adds WebSocket backend | Only new files + manager registration needed | < 3 existing files modified |
| Cross-platform use | Portability | User runs on Linux after using on Windows | Same features and behavior | All connection types available |
| First-time user | Usability | User familiar with VS Code opens TermiHub | Can create and manage terminals | No documentation needed for basic use |

---

## 11. Risks and Technical Debts

| Risk / Debt | Description | Mitigation |
|-------------|-------------|------------|
| **No credential encryption** | SSH passwords are prompted but key paths are stored in plaintext connection files | Phase 2: platform keychain integration. Key-based auth recommended. |
| **ConPTY dependency** | Windows PTY requires Windows 10 1809+ | Document minimum version; fail gracefully on older Windows |
| **xterm.js canvas testing** | Terminal renders to `<canvas>`, invisible to DOM-based test tools | Manual testing plan ([manual-testing.md](manual-testing.md)); E2E tests cover surrounding UI |
| **WebView rendering differences** | Tauri uses platform WebView (Edge/WebKitGTK/WebKit) with subtle CSS differences | CI builds on all 3 OSes; test matrix for visual regression |
| **libssh2 limitations** | `ssh2` crate wraps libssh2 which has occasional compatibility issues with newer SSH servers | Monitor upstream issues; consider `russh` migration if needed |
| **Single-threaded IPC** | Tauri commands run on the main thread by default | Heavy operations use `tauri::async_runtime::spawn` |
| **Session limit** | Hard cap at 50 concurrent terminals | Sufficient for target use case; can be raised if needed |
| **No automated cross-platform tests for serial** | Serial tests require physical hardware | Docker-based virtual serial via socat in `examples/` |

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| **PTY** | Pseudo-terminal — a virtual terminal device that provides a bidirectional communication channel, used to run shell processes |
| **ConPTY** | Windows Console Pseudo Terminal — Windows 10's pseudo-terminal API (available since build 1809) |
| **forkpty** | Unix system call that creates a new process with a pseudo-terminal attached |
| **SFTP** | SSH File Transfer Protocol — secure file transfer over an SSH connection |
| **IPC** | Inter-Process Communication — the mechanism Tauri uses for frontend-backend communication |
| **JSON-RPC** | JSON-based Remote Procedure Call protocol — used for desktop-to-agent communication |
| **IAC** | Interpret As Command — Telnet protocol escape sequence for control commands |
| **xterm.js** | Open-source terminal emulator component that renders to HTML5 canvas |
| **Tauri Command** | A Rust function exposed to the frontend via Tauri's IPC bridge (request-response pattern) |
| **Tauri Event** | A push-based message from backend to frontend via Tauri's event system |
| **Zustand** | Lightweight React state management library using hooks |
| **dnd-kit** | React drag-and-drop toolkit used for tab reordering and panel splitting |
| **WebView** | Platform-native web rendering component (Edge WebView2 on Windows, WebKitGTK on Linux, WebKit on macOS) |
| **Ring Buffer** | Fixed-size circular buffer used in the remote agent to store serial data (1 MiB) for replay on client attach |
| **Backpressure** | Flow control mechanism where bounded channels prevent fast producers from overwhelming slow consumers |

---

*This document follows the [arc42](https://arc42.org) template. For contribution guidelines, see [Contributing](contributing.md). For testing details, see [Testing Strategy](testing.md).*
