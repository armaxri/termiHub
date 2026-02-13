# TermiHub - Project Documentation

## Project Overview

**TermiHub** is a modern, cross-platform terminal hub designed for embedded development workflows. It provides a VS Code-like interface for managing multiple terminal connections with support for split views, drag-and-drop tabs, and organized connection management.

### Key Features
- Multiple terminal types: Local shells (zsh, bash, cmd, PowerShell, Git Bash), SSH, Telnet, Serial
- VS Code-inspired UI with activity bar, sidebar, and split view support
- Drag-and-drop tab management with up to 40 concurrent terminals
- Connection organization in folder hierarchies
- Integrated SSH file browser with drag-and-drop file transfer
- Session persistence and reconnect capabilities (for remote connections)
- Cross-platform support: Windows, Linux, macOS

### Target Use Case
Primary use case is embedded development where:
- Local shells build the product
- Serial connections interface with test targets
- Remote Raspberry Pi agents maintain persistent sessions overnight
- File transfer between development machine and test targets is seamless

---

## Tech Stack

### Frontend
- **Framework**: React 18 + TypeScript
- **Build Tool**: Vite (via Tauri template)
- **UI Libraries**:
  - `react-resizable-panels` - Split view management
  - `@dnd-kit/core` + `@dnd-kit/sortable` - Drag and drop
  - `@radix-ui/*` - Accessible UI primitives
  - `lucide-react` - Icon system
- **Terminal**: `@xterm/xterm` + `@xterm/addon-fit`
- **File Browser**: `react-virtuoso` (virtualized lists)

### Backend (Tauri)
- **Runtime**: Tauri 2.x
- **Language**: Rust
- **Core Dependencies**:
  - `tokio` - Async runtime
  - `portable-pty` - Cross-platform PTY
  - `serialport` - Serial port communication
  - `ssh2` - SSH and SFTP support
  - `serde` + `serde_json` - Serialization
  - `uuid` - Session ID generation
  - `anyhow` - Error handling

### Future (Phase 3 - Remote Agent)
- Standalone Rust binary for Raspberry Pi
- SQLite for session persistence
- Custom protocol over SSH for session management
- systemd service integration

---

## Architecture

### High-Level Architecture

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

### Component Architecture

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

### Backend Architecture (Trait-Based Design)

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

### Data Flow

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
    
    Note over Backend,PTY: Background async loop
    loop Output streaming
        PTY->>Backend: Data available
        Backend->>Tauri: emit("terminal-output", data)
        Tauri->>UI: Event received
        UI->>UI: xterm.write(data)
    end
    
    UI->>Tauri: send_input(sessionId, data)
    Tauri->>TM: send_input(sessionId, data)
    TM->>Backend: send_input(data)
    Backend->>PTY: Write data
```

---

## Task Management

All work is tracked in **GitHub Issues**. Use `gh issue list` to see open tasks.

### Priority Labels

Issues are prioritized by phase label (highest priority first):

1. **`phase-5-polish`** — Polish & Testing (UX improvements, performance, cross-platform testing)
2. **`phase-6-remote-foundation`** — Remote Agent Foundation (protocol design, RemoteBackend, agent stub)
3. **`phase-7-remote-agent`** — Remote Agent Implementation (SQLite persistence, serial proxy, systemd, UI integration)
4. **`future`** — Post-v1 enhancements (X11 forwarding, credential encryption, plugins, cloud sync, etc.)

### Workflow

- Pick the next task from the highest-priority label with open issues
- Reference issue numbers in commits and PRs (`Closes #N` / `Fixes #N`)
- Create new issues for work discovered during development
- Label new issues appropriately upon creation
- Use `gh issue list --label <label>` to filter by phase

---

## Project Structure

```
termihub/
├── src/                          # React frontend
│   ├── components/
│   │   ├── ActivityBar/
│   │   │   ├── ActivityBar.tsx
│   │   │   ├── ActivityBarItem.tsx
│   │   │   └── index.ts
│   │   ├── Sidebar/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── ConnectionList.tsx
│   │   │   ├── ConnectionEditor.tsx
│   │   │   ├── FileBrowser.tsx
│   │   │   └── index.ts
│   │   ├── Terminal/
│   │   │   ├── Terminal.tsx
│   │   │   ├── TerminalView.tsx
│   │   │   ├── TabBar.tsx
│   │   │   ├── Tab.tsx
│   │   │   └── index.ts
│   │   ├── SplitView/
│   │   │   ├── SplitView.tsx
│   │   │   └── index.ts
│   │   └── Settings/
│   │       ├── ConnectionSettings.tsx
│   │       ├── SerialSettings.tsx
│   │       ├── SshSettings.tsx
│   │       └── index.ts
│   ├── hooks/
│   │   ├── useTerminal.ts
│   │   ├── useConnections.ts
│   │   ├── useFileSystem.ts
│   │   └── useTauriEvents.ts
│   ├── services/
│   │   ├── api.ts              # Tauri command wrappers
│   │   ├── events.ts           # Tauri event listeners
│   │   └── storage.ts          # Local storage helpers
│   ├── types/
│   │   ├── terminal.ts
│   │   ├── connection.ts
│   │   └── events.ts
│   ├── utils/
│   │   ├── shell-detection.ts
│   │   └── formatters.ts
│   ├── App.tsx
│   ├── App.css
│   └── main.tsx
│
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── terminal/
│   │   │   ├── mod.rs
│   │   │   ├── backend.rs      # TerminalBackend trait
│   │   │   ├── manager.rs      # TerminalManager
│   │   │   ├── local_shell.rs
│   │   │   ├── serial.rs
│   │   │   ├── ssh.rs
│   │   │   ├── telnet.rs
│   │   │   └── remote.rs       # Future remote backend
│   │   ├── connection/
│   │   │   ├── mod.rs
│   │   │   ├── config.rs       # Connection config types
│   │   │   ├── manager.rs      # Connection CRUD
│   │   │   └── storage.rs      # Persistence
│   │   ├── files/
│   │   │   ├── mod.rs
│   │   │   ├── sftp.rs
│   │   │   └── browser.rs
│   │   ├── commands/           # Tauri commands
│   │   │   ├── mod.rs
│   │   │   ├── terminal.rs
│   │   │   ├── connection.rs
│   │   │   └── files.rs
│   │   ├── events/             # Event emitters
│   │   │   ├── mod.rs
│   │   │   └── terminal.rs
│   │   ├── utils/
│   │   │   ├── mod.rs
│   │   │   ├── shell_detect.rs
│   │   │   └── errors.rs
│   │   ├── lib.rs
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── agent/                        # Future: Raspberry Pi agent
│   ├── src/
│   │   ├── session/
│   │   ├── serial/
│   │   ├── protocol/
│   │   └── main.rs
│   └── Cargo.toml
│
├── package.json
├── tsconfig.json
├── vite.config.ts
├── .gitignore
├── README.md
├── CLAUDE.md                     # This file
└── CHANGELOG.md                  # Keep-a-Changelog format, update with each PR
```

---

## Coding Standards

### General Principles

1. **Clean Code**
   - Maximum file length: ~500 lines (prefer smaller, focused files when reasonable)
   - Maximum function length: ~50 lines
   - Clear, descriptive naming
   - Single Responsibility Principle

2. **Type Safety**
   - No `any` types in TypeScript
   - Use proper Rust error handling (no `.unwrap()` in production code)
   - Comprehensive type definitions

3. **Documentation**
   - JSDoc for public TypeScript functions
   - Rust doc comments (`///`) for public APIs
   - README in each major directory

### TypeScript/React Standards

```typescript
// Component structure
interface ComponentNameProps {
  // Props interface always defined
  requiredProp: string;
  optionalProp?: number;
}

/**
 * Brief description of component purpose
 */
export function ComponentName({ requiredProp, optionalProp = 42 }: ComponentNameProps) {
  // Hooks first
  const [state, setState] = useState<Type>(initialValue);
  
  // Event handlers
  const handleEvent = useCallback(() => {
    // Implementation
  }, [dependencies]);
  
  // Render
  return (
    <div>
      {/* JSX */}
    </div>
  );
}
```

**File Organization**:
- One component per file
- Co-located styles (if using CSS modules)
- Export from `index.ts` for clean imports

**Naming Conventions**:
- Components: `PascalCase`
- Hooks: `useCamelCase`
- Utils: `camelCase`
- Constants: `UPPER_SNAKE_CASE`

### Rust Standards

```rust
// Module structure
pub mod terminal;
mod internal_module;

use std::collections::HashMap;
// Group imports

/// Brief description
/// 
/// # Examples
/// 
/// ```
/// let backend = LocalShell::new(ShellType::Bash)?;
/// ```
pub trait TerminalBackend: Send + Sync {
    /// Method documentation
    fn spawn(&mut self) -> Result<SessionId>;
}

// Implementation
pub struct LocalShell {
    /// Field documentation
    pty: PtySession,
    shell_type: ShellType,
}

impl LocalShell {
    /// Constructor documentation
    pub fn new(shell_type: ShellType) -> Result<Self> {
        // Implementation with proper error handling
        let pty = PtySession::new()?;
        
        Ok(Self {
            pty,
            shell_type,
        })
    }
}

impl TerminalBackend for LocalShell {
    fn spawn(&mut self) -> Result<SessionId> {
        // Clear, focused implementation
        // Use ? for error propagation
        // No .unwrap() in production
        Ok(uuid::Uuid::new_v4().to_string())
    }
}
```

**Naming Conventions**:
- Types/Traits: `PascalCase`
- Functions/methods: `snake_case`
- Constants: `UPPER_SNAKE_CASE`
- Modules: `snake_case`

**Error Handling**:
- Use `anyhow::Result<T>` for application code
- Custom error types where appropriate
- Always propagate errors with `?`
- Add context with `.context("description")`

**Async Code**:
- Use `tokio` for async runtime
- Properly handle task cancellation
- Use channels for communication

---

## Git Workflow

### Branch Strategy

**Main Branches**:
- `main` - Production-ready code, protected
- `develop` - Integration branch (optional, for larger features)

**Feature Branches**:
- Format: `feature/<brief-description>`
- Examples: `feature/ui-foundation`, `feature/serial-backend`
- Branch from `main`
- Merge back via Pull Request

**Bugfix Branches**:
- Format: `bugfix/<issue-description>`
- Example: `bugfix/terminal-resize-crash`

**Never commit directly to `main`**

### Commit Message Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples**:
```
feat(terminal): add xterm.js integration

- Integrate xterm.js library
- Add Terminal component with resize support
- Implement basic event handling

Closes #12

---

fix(serial): handle port disconnection gracefully

Previously, disconnecting a serial port would crash the app.
Now properly handles the error and shows notification to user.

Fixes #34

---

refactor(backend): extract TerminalBackend trait

Split terminal implementations into separate files following
the trait pattern for better maintainability.

---

docs(readme): add build instructions for macOS
```

**Scope Examples**: `terminal`, `ssh`, `ui`, `backend`, `sftp`, `config`

### Pull Request Process

1. Create feature branch from `main`
2. Implement feature following coding standards
3. Test thoroughly on all platforms (if applicable)
4. Create PR with description:
   - What changed
   - Why it changed
   - How to test
   - Screenshots (for UI changes)
5. Review and address feedback
6. **Always merge with a merge commit** (`gh pr merge --merge`). Never squash or rebase — preserve full commit history.
7. Merge when approved

---

## Configuration Files

### package.json (Frontend)

```json
{
  "name": "termihub",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri": "tauri"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "@tauri-apps/api": "^2.0.0",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "react-resizable-panels": "^2.0.0",
    "@dnd-kit/core": "^6.1.0",
    "@dnd-kit/sortable": "^8.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "@radix-ui/react-tabs": "^1.0.4",
    "@radix-ui/react-dropdown-menu": "^2.0.6",
    "@radix-ui/react-dialog": "^1.0.5",
    "@radix-ui/react-select": "^2.0.0",
    "lucide-react": "^0.263.1",
    "react-virtuoso": "^4.6.0",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.2.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "@tauri-apps/cli": "^2.0.0"
  }
}
```

### Cargo.toml (Backend)

```toml
[package]
name = "termihub"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = ["shell-open"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
portable-pty = "0.8"
serialport = "4"
ssh2 = "0.9"
uuid = { version = "1", features = ["v4", "serde"] }
anyhow = "1"
thiserror = "1"
tracing = "0.1"
tracing-subscriber = "0.3"

# Platform-specific dependencies
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "Win32_System_Console",
    "Win32_Foundation",
] }

[build-dependencies]
tauri-build = { version = "2", features = [] }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

---

## Key Design Decisions

### Why React over Svelte?
Despite Svelte's performance benefits, React was chosen for:
- Larger ecosystem with mature libraries
- Better tooling for complex drag-and-drop (dnd-kit)
- Production-ready split view component (react-resizable-panels)
- More examples and community support for AI-assisted development
- Better knowledge base for Claude Code

### Why Trait-Based Backend?
The `TerminalBackend` trait allows:
- Easy addition of new terminal types
- Consistent interface for the manager
- Future remote backend without major refactoring
- Testability through mock implementations

### Why Not Electron?
Tauri provides:
- Smaller binary size (~5MB vs ~100MB)
- Lower memory footprint
- Better security (Rust backend)
- Native system integration
- Still cross-platform

### Credential Storage Strategy
Phase 1 does NOT implement credential encryption to avoid complexity. Future implementation will use:
- Platform keychains (Windows Credential Manager, macOS Keychain, Linux Secret Service)
- Encryption at rest for portability option
- Clear UI warning when credentials are not yet encrypted

---

## Testing Strategy

### Running Automated Tests

**Rust backend:**
```bash
cd src-tauri && cargo test
```

**TypeScript frontend:**
```bash
pnpm test            # single run
pnpm test:watch      # watch mode
pnpm test:coverage   # with coverage report
```

### What's Covered by Automated Tests

**Rust (~54 tests):**
- `utils/shell_detect.rs` — `shell_to_command()` mapping for all shell types
- `utils/expand.rs` — `${env:...}` placeholder expansion
- `utils/x11_detect.rs` — X11 display string parsing
- `files/utils.rs` — `format_permissions()`, `chrono_from_epoch()`
- `files/local.rs` — filesystem operations (list, mkdir, delete, rename, read/write) via tempdir
- `connection/config.rs` — serde round-trips for all `ConnectionConfig` variants, JSON shape verification
- `connection/manager.rs` — `strip_ssh_password()`, `filename_from_path()`, external file save/load round-trip
- `terminal/backend.rs` — serde round-trips for config types, `expand()` for all config variants

**TypeScript (~43 tests):**
- `utils/formatters.ts` — `formatBytes()`, `truncate()`, `formatRelativeTime()`
- `utils/panelTree.ts` — all tree operations (create, find, update, remove, split, simplify, edgeToSplit)
- `store/appStore.ts` — tab add/close/activate, split panel, move tab, connection CRUD, sidebar toggle

### What's NOT Covered (and Why)

- **Terminal rendering** — xterm.js renders to a `<canvas>`, not DOM elements, making it opaque to DOM-based test tools
- **Real SSH/Serial/Telnet connections** — require live servers or hardware; tested manually
- **Tauri IPC integration** — commands require a running Tauri app with an `AppHandle`; unit-testing would require refactoring production code to extract the `AppHandle` dependency
- **E2E UI tests** — xterm.js canvas rendering + platform-specific WebDriver setup makes automated E2E impractical for this project size
- **Cross-platform behavior** — platform-specific code paths (Windows shell detection, ConPTY) require running on each OS

See [`docs/manual-testing.md`](docs/manual-testing.md) for the manual test plan covering these areas.

### Performance Testing
- Load testing with 40 concurrent terminals
- Memory profiling
- Event throughput testing

### Platform Testing Matrix
| Feature | Windows | Linux | macOS |
|---------|---------|-------|-------|
| Local shells | ✓ | ✓ | ✓ |
| Serial | ✓ | ✓ | ✓ |
| SSH | ✓ | ✓ | ✓ |
| Telnet | ✓ | ✓ | ✓ |
| File browser | ✓ | ✓ | ✓ |

---

## Development Guidelines

### Before Starting Work
1. Pull latest `main`
2. Create feature branch
3. Review relevant code in that area
4. Plan your approach (comment in issue/PR)

### During Development
1. Commit frequently with clear messages
2. Keep commits atomic (one logical change)
3. Test as you go
4. Update documentation alongside code
5. **Update CHANGELOG.md** for user-facing changes

### Before Pull Request
1. Test on your primary platform
2. Run linters (`cargo clippy`, `eslint`)
3. **Update CHANGELOG.md** following [Keep a Changelog](https://keepachangelog.com/) format:
   - Add entry under `[Unreleased]` section
   - Use categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`
   - Write user-facing descriptions (not technical details)
   - Example: "Added support for Git Bash on Windows" not "Implemented GitBashDetector"
4. Self-review your diff
5. Write clear PR description

### Code Review
- Be respectful and constructive
- Explain reasoning for suggestions
- Accept that multiple solutions can be valid
- Focus on readability and maintainability

---

## CI/CD

### GitHub Actions Workflows

Three workflows run automatically in `.github/workflows/`:

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| **Code Quality** | Push/PR to `main` | Rust fmt + clippy + audit, ESLint, Prettier, TypeScript type check, tests on all 3 OSes, security audit, commit lint (PR only) |
| **Build** | Push/PR to `main` | Builds Tauri app for macOS (x64 + ARM64), Windows (x64), Linux (x64 + ARM64) |
| **Release** | Tag `v*.*.*` | Creates GitHub Release, builds and uploads platform installers |

### Running Quality Checks Locally

```bash
# Frontend
pnpm run lint            # ESLint
pnpm run format:check    # Prettier (use format to auto-fix)
pnpm test                # Vitest

# Rust
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

### Release Process

See [`docs/releasing.md`](docs/releasing.md) for the full release checklist, version bump locations, and post-release verification steps.

---

## Troubleshooting Common Issues

### Serial Port Access Denied (Linux)
```bash
sudo usermod -a -G dialout $USER
# Then logout and login
```

### PTY Spawn Fails (Windows)
- Ensure ConPTY is available (Windows 10 1809+)
- Check antivirus isn't blocking

### SSH Connection Timeout
- Verify SSH server is running
- Check firewall rules
- Test with standard `ssh` command first

### xterm.js Not Rendering
- Ensure container has explicit dimensions
- Call `terminal.fit()` after resize
- Check for CSS conflicts

---

## Resources

### Documentation
- [Tauri Docs](https://tauri.app/v2/)
- [React Docs](https://react.dev/)
- [xterm.js](https://xtermjs.org/)
- [portable-pty](https://docs.rs/portable-pty/)
- [serialport](https://docs.rs/serialport/)

### Similar Projects (for inspiration)
- [Tabby](https://github.com/Eugeny/tabby)
- [Hyper](https://hyper.is/)
- [Warp](https://www.warp.dev/)

### Community
- Tauri Discord
- Rust Forum
- React Community

---

## License

MIT License - See LICENSE file for details

---

## Contributors

- Arne Maximilian Richter (armaxri@gmail.com) - Initial development and architecture

---

**Last Updated**: 2026-02-09
**Document Version**: 1.0

---

## Quick Start for Claude Code

When working on this project:

1. **Check GitHub Issues** for the next task (`gh issue list --label phase-5-polish`)
2. **Always** create a feature branch first
3. **Read** the relevant architecture section before implementing
4. **Follow** the coding standards exactly
5. **Use** conventional commits, referencing issue numbers (`Closes #N`)
6. **Update CHANGELOG.md** for every user-facing change (new features, bug fixes, breaking changes)
7. **Test** on the target platform before committing
8. **Ask** if architecture decisions need clarification

For each new terminal backend:
1. Implement the `TerminalBackend` trait
2. Add to `TerminalManager`
3. Create Tauri commands
4. Build configuration UI
5. Add to connection type selector
6. Test thoroughly
7. Document in this file

Remember: Clean, maintainable code > clever code. Future you (and other developers) will thank you.
