# Contributing to termiHub

This guide covers the development workflow, architecture overview, and coding standards for contributing to termiHub.

---

## Architecture Overview

termiHub is built with:

- **Frontend**: React 18 + TypeScript, built with Vite
- **Backend**: Rust, running inside Tauri 2
- **IPC**: Tauri commands (frontend calls backend) and events (backend pushes to frontend)

### High-Level Design

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                     │
│                                                         │
│  ┌─────────────┐     ┌────────┐     ┌───────────────┐  │
│  │  React UI   │◄───►│  IPC   │◄───►│ Rust Backend  │  │
│  │  (xterm.js, │     │ Bridge │     │ (PTY, SSH,    │  │
│  │   Monaco)   │     │        │     │  Serial,      │  │
│  │             │     │        │     │  Telnet)      │  │
│  └─────────────┘     └────────┘     └───────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Trait-Based Backend

All terminal types implement the `TerminalBackend` trait, which provides a consistent interface for:

- Spawning sessions
- Sending input / receiving output
- Resizing the terminal
- Closing connections

Current desktop implementations: `LocalShell`, `SshConnection`, `SerialConnection`, `TelnetConnection`, and `RemoteBackend` (proxy to remote agent via JSON-RPC over SSH).

The remote agent has its own backend architecture: `ShellBackend`, `DockerBackend`, `SshBackend`, and `SerialBackend` — all communicating with session daemons via a binary frame protocol over Unix domain sockets. See [Architecture Documentation](architecture.md#level-2-agent-modules) for details.

Adding a new terminal type means implementing this trait and registering it with the `TerminalManager`. See [Adding a New Terminal Backend](#adding-a-new-terminal-backend) below.

### State Management

The frontend uses Zustand for state management with a single `appStore` that manages:

- Panel layout (recursive tree of horizontal/vertical splits)
- Tab state (active tab, dirty flags, colors, CWD tracking)
- Connection and folder persistence
- Sidebar view state
- SFTP sessions and file browser state

---

## Project Structure

```
termihub/
├── src/                  # React frontend
│   ├── components/       # UI components (ActivityBar, Sidebar, Terminal, etc.)
│   ├── hooks/            # React hooks (useTerminal, useKeyboardShortcuts, etc.)
│   ├── services/         # Tauri API wrappers (api.ts, events.ts)
│   ├── store/            # Zustand store (appStore.ts)
│   ├── types/            # TypeScript types (terminal.ts, connection.ts)
│   └── utils/            # Utilities (formatters, shell detection)
├── src-tauri/            # Rust backend
│   ├── src/
│   │   ├── terminal/     # Terminal backends and manager
│   │   ├── connection/   # Connection config, CRUD, persistence
│   │   ├── files/        # File browser and SFTP
│   │   ├── monitoring/   # SSH remote system monitoring
│   │   ├── commands/     # Tauri IPC command handlers
│   │   └── events/       # Event emitters
│   ├── Cargo.toml
│   └── tauri.conf.json
├── core/                 # Shared Rust core library (termihub-core)
│   └── src/
│       ├── buffer/       # RingBuffer (1 MiB circular byte buffer)
│       ├── config/       # ShellConfig, SshConfig, DockerConfig, SerialConfig, PtySize
│       ├── errors.rs     # CoreError, SessionError, FileError
│       ├── files/        # FileBackend trait, LocalFileBackend, FileEntry, utilities
│       ├── monitoring/   # SystemStats, CpuCounters, StatsCollector trait, parsers
│       ├── output/       # OutputCoalescer, screen-clear detection
│       ├── protocol/     # JSON-RPC message types and error codes
│       └── session/      # Transport traits, shell/SSH/Docker/serial helpers
├── agent/                # Remote agent (JSON-RPC over SSH)
│   └── src/
│       ├── daemon/       # Session daemon process and binary frame protocol
│       ├── shell/        # ShellBackend (daemon client for shell sessions)
│       ├── docker/       # DockerBackend (Docker container sessions)
│       ├── ssh/          # SshBackend (SSH jump host sessions)
│       ├── serial/       # SerialBackend (direct serial port access)
│       ├── session/      # SessionManager, types, prepared connection definitions
│       ├── files/        # File browsing (local, SFTP relay, Docker)
│       ├── monitoring/   # System monitoring (delegates to core parsers)
│       ├── handler/      # JSON-RPC method dispatcher
│       ├── protocol/     # Protocol types, methods, error codes
│       ├── state/        # Session state persistence (state.json)
│       ├── io/           # Transport layer (stdio, TCP)
│       └── main.rs       # Entry point (--stdio, --listen, --daemon)
├── scripts/              # Dev helper scripts (.sh + .cmd)
├── examples/             # Docker test environment, virtual serial
├── docs/                 # User and developer documentation
└── package.json
```

For the full architecture documentation, including class diagrams and data flow sequences, see [Architecture Documentation](architecture.md).

---

## Development Setup

See [Building termiHub](building.md) for detailed instructions on:

- Installing prerequisites (Node.js, pnpm, Rust, system libraries)
- Platform-specific dependencies
- Running the development server

Quick start:

```bash
git clone <repo-url>
cd termihub
pnpm install
pnpm tauri dev
```

---

## Task Management

All work is tracked in **GitHub Issues**.

### Issue Labels

Issues use these workflow labels:

- **`Ready2Implement`** — Ready for implementation work
- **`Concept`** — Design-only: produce a concept document, no code

### Finding Work

```bash
# List issues ready for implementation
gh issue list --label Ready2Implement

# List concept/design tasks
gh issue list --label Concept
```

Pick the next task from `Ready2Implement` for implementation work or `Concept` for design tasks.

### Creating Issues

When you discover work during development, create a new issue:

```bash
gh issue create --title "Brief description" --label "Ready2Implement"
```

---

## Git Workflow

### Branch Strategy

- **`main`** — Production-ready code
- **`feature/<description>`** — New features (e.g., `feature/serial-backend`)
- **`bugfix/<description>`** — Bug fixes (e.g., `bugfix/terminal-resize-crash`)

**Never commit directly to `main`.**

### Creating a Feature Branch

```bash
git checkout main
git pull origin main
git checkout -b feature/my-feature
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

**Scopes**: `terminal`, `ssh`, `serial`, `ui`, `backend`, `sftp`, `config`, etc.

**Examples:**

```
feat(terminal): add horizontal scrolling option

Add per-connection horizontal scroll toggle with runtime
switching via tab context menu.

Closes #42
```

```
fix(ssh): handle connection timeout gracefully

Previously, a connection timeout would crash the app.
Now shows an error message in the terminal.

Fixes #34
```

### Pull Requests

1. Push your branch: `git push -u origin feature/my-feature`
2. Create a PR: `gh pr create`
3. Include in the PR description:
   - What changed and why
   - How to test
   - Screenshots for UI changes
4. Reference issues: `Closes #N` or `Fixes #N`
5. **Always merge with a merge commit** (`gh pr merge --merge`) — never squash or rebase

---

## Coding Standards

### TypeScript / React

- **No `any` types** — Use proper type definitions
- **One component per file** — Named exports
- **Hooks first** in component body, then event handlers, then render
- **`PascalCase`** for components, **`camelCase`** for functions/hooks, **`UPPER_SNAKE_CASE`** for constants
- **Props interfaces** always defined (e.g., `interface MyComponentProps { ... }`)
- **JSDoc** for public functions

### Rust

- **No `.unwrap()` in production code** — Use `?` with `anyhow::Result`
- **Add context** to errors: `.context("description")`
- **`PascalCase`** for types/traits, **`snake_case`** for functions/modules, **`UPPER_SNAKE_CASE`** for constants
- **Doc comments** (`///`) for public APIs
- **`tokio`** for async, channels for communication

### General

- Maximum ~500 lines per file
- Maximum ~50 lines per function
- Clear, descriptive naming
- Single Responsibility Principle

See [Architecture Documentation](architecture.md) for detailed diagrams and patterns.

---

## Adding a New Terminal Backend

To add a new connection type (e.g., a new protocol):

### 1. Implement the Backend (Rust)

Create a new file in `src-tauri/src/terminal/` (e.g., `my_protocol.rs`):

- Implement the `TerminalBackend` trait
- Handle spawning, input/output, resize, and close
- Use `anyhow::Result` for error handling

### 2. Register with TerminalManager

Update `src-tauri/src/terminal/manager.rs` to:

- Add a match arm for the new connection type
- Instantiate your backend when a session is created

### 3. Add Tauri Commands

Update `src-tauri/src/commands/` if any new IPC commands are needed beyond the standard terminal lifecycle.

### 4. Add Configuration Types

- **Rust**: Add a config struct in `src-tauri/src/connection/config.rs`
- **TypeScript**: Add corresponding types in `src/types/terminal.ts`

### 5. Create Settings UI

Add a settings component in `src/components/Settings/` (e.g., `MyProtocolSettings.tsx`) and integrate it into the `ConnectionEditor`.

### 6. Add to Connection Type Selector

Update the connection type dropdown in `src/components/Sidebar/ConnectionEditor.tsx`.

### 7. Test

- Use the test environment in `examples/` if applicable
- Test on your target platform
- Run `cargo clippy` and `pnpm build` to check for errors

---

## Testing

For the full testing strategy — including unit, integration, E2E, and visual regression testing — see [Testing Strategy](testing.md).

### Running Tests

The quickest way to run all tests is via the helper scripts:

```bash
./scripts/test.sh      # Run all unit tests (frontend + backend + agent)
./scripts/check.sh     # Read-only quality checks mirroring CI
```

Individual commands if you only need one tool:

```bash
# Frontend unit tests (Vitest)
pnpm test              # single run
pnpm test:watch        # watch mode
pnpm test:coverage     # with coverage report

# Rust workspace tests (core + agent + desktop)
cargo test --workspace

# Individual crate tests
cargo test -p termihub-core
cargo test -p termihub-agent

# TypeScript type checking
pnpm build

# Rust linting (workspace-wide)
cargo clippy --workspace --all-targets -- -D warnings

# E2E tests (requires built app — see docs/testing.md for setup)
pnpm test:e2e
```

### Test Environment

The `examples/` directory provides Docker-based test servers:

```bash
cd examples
./start-test-environment.sh   # Start SSH + Telnet servers
./stop-test-environment.sh    # Stop servers
```

See [examples/README.md](../examples/README.md) for details on:

- SSH server (port 2222) and Telnet server (port 2323)
- Virtual serial ports via socat
- Pre-configured test connections
- X11 forwarding test applications

### Manual Testing

See [Manual Test Plan](manual-testing.md) for the full checklist. For UI changes, test at minimum:

- Create, edit, duplicate, and delete connections
- Connect to each terminal type
- Drag-and-drop tabs between panels
- Split views (horizontal and vertical)
- File browser (local and SFTP)
- Keyboard shortcuts

---

## Agent Development

The remote agent (`termihub-agent`) is a standalone Rust binary in `agent/` that runs on remote hosts (build servers, ARM devices, NAS boxes, etc.). It provides persistent terminal sessions that survive desktop disconnects and agent restarts.

### Operating Modes

| Mode   | Flag              | Use Case                                                           |
| ------ | ----------------- | ------------------------------------------------------------------ |
| Stdio  | `--stdio`         | Production — NDJSON over stdin/stdout, launched by desktop via SSH |
| TCP    | `--listen [addr]` | Development/test — TCP listener (default `127.0.0.1:7685`)         |
| Daemon | `--daemon <id>`   | Internal — session daemon process, not invoked directly            |

### Key Architecture Concepts

- **Session daemon architecture** — Each shell session runs as an independent daemon process (`termihub-agent --daemon <session-id>`) that manages a PTY, a 1 MiB ring buffer, and a Unix domain socket. Daemons survive agent restarts.
- **State persistence** — Active sessions are tracked in `~/.config/termihub-agent/state.json`. On restart, the agent reconnects to living daemons and recovers sessions.
- **Platform constraint** — Daemon features are Unix-only (`#[cfg(unix)]`) due to PTY, Unix sockets, and POSIX process APIs.

### Running and Testing

```bash
# Run agent in dev mode (TCP listener)
cd agent && cargo run -- --listen

# Run agent tests
cd agent && cargo test

# Clippy
cd agent && cargo clippy --all-targets --all-features -- -D warnings

# Format check
cd agent && cargo fmt --check
```

See [Architecture Documentation](architecture.md#level-2-agent-modules) for the module breakdown and [Remote Protocol](remote-protocol.md) for the JSON-RPC protocol specification.

---

## Changelog

Update `CHANGELOG.md` for every user-facing change following [Keep a Changelog](https://keepachangelog.com/) format:

- Add entries under `[Unreleased]`
- Use categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`
- Write user-facing descriptions (not implementation details)

**Good**: "Added support for Git Bash on Windows"
**Bad**: "Implemented GitBashDetector class in shell_detect.rs"

---

## Code Review Checklist

Before submitting a PR, run the quality scripts:

```bash
./scripts/format.sh    # Auto-fix formatting (Prettier + cargo fmt)
./scripts/test.sh      # Run all unit tests
./scripts/check.sh     # Read-only quality checks mirroring CI
```

Then verify:

- [ ] All scripts pass without errors
- [ ] No `.unwrap()` calls in Rust production code
- [ ] No `any` types in TypeScript
- [ ] Commit messages follow Conventional Commits
- [ ] `CHANGELOG.md` updated for user-facing changes
- [ ] Tested on your primary platform
- [ ] PR description explains what changed and how to test
