# Contributing to TermiHub

This guide covers the development workflow, architecture overview, and coding standards for contributing to TermiHub.

---

## Architecture Overview

TermiHub is built with:

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

Current implementations: `LocalShell`, `SshConnection`, `SerialConnection`, `TelnetConnection`.

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
│   │   ├── commands/     # Tauri IPC command handlers
│   │   └── events/       # Event emitters
│   ├── Cargo.toml
│   └── tauri.conf.json
├── examples/             # Docker test environment, virtual serial
├── docs/                 # User and developer documentation
└── package.json
```

For the full architecture documentation, including class diagrams and data flow sequences, see [CLAUDE.md](../CLAUDE.md).

---

## Development Setup

See [Building TermiHub](building.md) for detailed instructions on:
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

### Priority Labels

Issues are prioritized by phase label (highest priority first):

1. **`phase-5-polish`** — UX improvements, performance, cross-platform testing
2. **`phase-6-remote-foundation`** — Remote agent protocol and backend
3. **`phase-7-remote-agent`** — Remote agent implementation
4. **`future`** — Post-v1 enhancements

### Finding Work

```bash
# List open issues by priority
gh issue list --label phase-5-polish
gh issue list --label phase-6-remote-foundation
gh issue list --label future
```

Pick the next task from the highest-priority label with open issues.

### Creating Issues

When you discover work during development, create a new issue:

```bash
gh issue create --title "Brief description" --label "phase-5-polish"
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

See [CLAUDE.md](../CLAUDE.md) for detailed code examples and patterns.

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

### Running Tests

```bash
# Rust tests
cd src-tauri && cargo test

# TypeScript type checking
pnpm build

# Rust linting
cd src-tauri && cargo clippy
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

For UI changes, test the following:
- Create, edit, duplicate, and delete connections
- Connect to each terminal type
- Drag-and-drop tabs between panels
- Split views (horizontal and vertical)
- File browser (local and SFTP)
- Keyboard shortcuts

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

Before submitting a PR:

- [ ] Code compiles without warnings (`cargo clippy`, `pnpm build`)
- [ ] No `.unwrap()` calls in Rust production code
- [ ] No `any` types in TypeScript
- [ ] Commit messages follow Conventional Commits
- [ ] `CHANGELOG.md` updated for user-facing changes
- [ ] Tested on your primary platform
- [ ] PR description explains what changed and how to test
