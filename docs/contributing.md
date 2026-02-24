# Contributing to termiHub

This guide covers everything you need to build, develop, and contribute to termiHub — from setting up your environment to submitting a pull request.

For the full architecture documentation (building blocks, runtime views, data flows, ADRs), see [Architecture Documentation](architecture.md).

---

## Development Setup

### Prerequisites (All Platforms)

#### Node.js

Install [Node.js](https://nodejs.org/) v18 or later.

```bash
node --version   # v18.x or later
```

#### pnpm

Install [pnpm](https://pnpm.io/installation) (the package manager used by this project):

```bash
npm install -g pnpm
```

#### Rust

Install Rust via [rustup](https://www.rust-lang.org/tools/install):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Verify your installation:

```bash
rustc --version
cargo --version
```

#### Tauri Prerequisites

Follow the [Tauri v2 prerequisites guide](https://v2.tauri.app/start/prerequisites/) for your platform. The platform-specific sections below summarize the key requirements.

### macOS

1. **Xcode Command Line Tools** (required for C/C++ compilation):

   ```bash
   xcode-select --install
   ```

2. No additional system libraries are needed on macOS — the required frameworks (WebKit, Security) are included with the OS.

### Linux

#### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssh2-1-dev \
  libudev-dev \
  pkg-config
```

#### Fedora

```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  openssl-devel \
  curl \
  wget \
  file \
  libxdo-devel \
  libappindicator-gtk3-devel \
  librsvg2-devel \
  libssh2-devel \
  systemd-devel \
  pkg-config
```

#### Arch Linux

```bash
sudo pacman -S --needed \
  webkit2gtk-4.1 \
  base-devel \
  curl \
  wget \
  file \
  openssl \
  xdotool \
  libappindicator-gtk3 \
  librsvg \
  libssh2 \
  pkg-config
```

### Windows

1. **Visual Studio Build Tools** — Install the "Desktop development with C++" workload from [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).

2. **WebView2** — Comes pre-installed on Windows 10 (version 1803+) and Windows 11. If missing, download from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

3. **ConPTY** — Required for local terminal support. Available on Windows 10 version 1809 and later.

### Quick Start

```bash
git clone <repo-url>
cd termihub
pnpm install
pnpm tauri dev
```

Or use the setup script for a complete first-time setup:

```bash
./scripts/setup.sh     # Install all dependencies and do an initial build
```

---

## Development Workflow

### Helper Scripts

The `scripts/` directory has cross-platform helpers (`.sh` + `.cmd`) for all common tasks:

```bash
./scripts/setup.sh     # First-time setup: install deps + initial build
./scripts/dev.sh       # Start dev mode with hot-reload
./scripts/build.sh     # Build for production
./scripts/test.sh      # Run all unit tests (frontend + backend + agent)
./scripts/check.sh     # Pre-push quality checks (mirrors CI)
./scripts/format.sh    # Auto-fix formatting (Prettier + cargo fmt)
./scripts/clean.sh     # Remove all build artifacts
```

See [scripts/README.md](../scripts/README.md) for the full list. On Windows, use the `.cmd` variants (e.g., `scripts\dev.cmd`).

### Dev Server with Hot Reload

```bash
./scripts/dev.sh
# or directly:
pnpm tauri dev
```

This starts:

- The Vite development server for the frontend (with hot module replacement)
- The Rust backend compiled in debug mode

Frontend changes appear instantly. Rust backend changes trigger a recompile and restart.

### Individual Commands

```bash
# Frontend
pnpm run lint            # ESLint
pnpm run format:check    # Prettier check (format to auto-fix)
pnpm test                # Vitest single run
pnpm test:watch          # Vitest watch mode
pnpm test:coverage       # Vitest with coverage
pnpm build               # TypeScript check + Vite build

# Rust workspace (all crates)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
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

## Agent Cross-Compilation

The remote agent (`termihub-agent`) runs on Linux hosts (servers, ARM devices, NAS boxes). You can cross-compile it for 6 Linux targets from any host OS.

### Targets

| Triple                           | Arch  | libc  | Use Case                          |
| -------------------------------- | ----- | ----- | --------------------------------- |
| `x86_64-unknown-linux-gnu`       | x64   | glibc | Standard servers                  |
| `aarch64-unknown-linux-gnu`      | ARM64 | glibc | ARM64 servers, Raspberry Pi 3/4/5 |
| `armv7-unknown-linux-gnueabihf`  | ARMv7 | glibc | ARMv7 devices, older Raspberry Pi |
| `x86_64-unknown-linux-musl`      | x64   | musl  | Static x64 binaries               |
| `aarch64-unknown-linux-musl`     | ARM64 | musl  | Static ARM64 binaries             |
| `armv7-unknown-linux-musleabihf` | ARMv7 | musl  | Static ARMv7 binaries             |

### Quick Start

```bash
# 1. Install cross-compilation toolchains (one-time)
./scripts/setup-agent-cross.sh    # Linux/macOS
scripts\setup-agent-cross.cmd     # Windows

# 2. Build all 6 targets
./scripts/build-agents.sh         # Linux/macOS
scripts\build-agents.cmd          # Windows
```

### Platform-Specific Notes

**Linux (Debian/Ubuntu):**

- GNU targets use native cross-compilers (`gcc-aarch64-linux-gnu`, `gcc-arm-linux-gnueabihf`) — fast, no Docker needed
- Musl targets use `cross-rs` (Docker-based) because musl packages don't include `libudev`
- The setup script installs multi-arch `libudev-dev` for ARM64 and ARMv7

**macOS / Windows:**

- All targets use `cross-rs` (Docker-based) since no native Linux cross-compilers are available
- Docker Desktop must be running before building

### Build Options (Unix)

```bash
# Build specific targets only
./scripts/build-agents.sh --targets aarch64-unknown-linux-gnu,armv7-unknown-linux-gnueabihf

# Force cross-rs for all targets (skip native toolchains)
./scripts/build-agents.sh --cross-only
```

### Output

Binaries are placed in:

```
agent/target/<triple>/release/termihub-agent
```

For example: `agent/target/aarch64-unknown-linux-gnu/release/termihub-agent`

### Deploying the Remote Agent

Once built (or cross-compiled), the `termihub-agent` binary can be deployed to any Linux host (server, Raspberry Pi, NAS, etc.).

**Install using the provided script:**

```bash
cd agent
sudo ./install.sh
```

This copies the binary to `/usr/local/bin/`, installs a systemd service, and enables it.

**Start and check the service:**

```bash
sudo systemctl start termihub-agent
sudo systemctl status termihub-agent
journalctl -u termihub-agent -f
```

**Agent modes:**

- **`--listen [addr]`** — TCP listener mode (default: `127.0.0.1:7685`). Used for systemd service. Sessions persist across client reconnects.
- **`--stdio`** — Stdio mode (NDJSON over stdin/stdout). Used when launched over SSH exec channels.

The systemd service uses `--listen` mode by default. To change the listen address:

```bash
sudo systemctl edit termihub-agent
# Override ExecStart to change the address
```

**Connecting from the desktop app:**

- **SSH port forward**: `ssh -L 7685:127.0.0.1:7685 user@host` then connect to `localhost:7685`
- **Direct LAN**: Start with `--listen 0.0.0.0:7685` and connect to the host's IP address

**Security note:** The TCP listener does not implement authentication or encryption. Always bind to `127.0.0.1` (default) and tunnel via SSH, or run on a trusted local network only.

---

## Building for Production

### macOS

```bash
pnpm tauri build
```

**Output**: `src-tauri/target/release/bundle/dmg/termiHub_<version>_aarch64.dmg` (Apple Silicon) or `termiHub_<version>_x64.dmg` (Intel).

The build also produces a `.app` bundle in `src-tauri/target/release/bundle/macos/`.

### Linux

```bash
pnpm tauri build
```

**Output**: `src-tauri/target/release/bundle/deb/termihub_<version>_amd64.deb` and `src-tauri/target/release/bundle/appimage/termihub_<version>_amd64.AppImage`.

### Windows

```powershell
pnpm tauri build
```

**Output**: `src-tauri\target\release\bundle\msi\termiHub_<version>_x64_en-US.msi` and `src-tauri\target\release\bundle\nsis\termiHub_<version>_x64-setup.exe`.

### Raspberry Pi / ARM64 Linux

termiHub builds for ARM64 Linux, covering Raspberry Pi 3 (64-bit OS), Pi 4, Pi 5, and other ARM64 SBCs (Orange Pi, Rock Pi, etc.).

**Prerequisites:**

- 64-bit OS (Raspberry Pi OS Bookworm or newer recommended)
- At least 2GB RAM (4GB+ recommended)

Verify your architecture:

```bash
uname -m
# Should output: aarch64
```

**Installing from Release:**

Using .deb Package (Recommended):

```bash
wget https://github.com/armaxri/termiHub/releases/latest/download/termiHub-X.X.X-linux-arm64.deb
sudo dpkg -i termiHub-X.X.X-linux-arm64.deb
sudo apt-get install -f   # fix dependencies if needed
```

Using AppImage:

```bash
wget https://github.com/armaxri/termiHub/releases/latest/download/termiHub-X.X.X-linux-arm64.AppImage
chmod +x termiHub-X.X.X-linux-arm64.AppImage
./termiHub-X.X.X-linux-arm64.AppImage
```

If the AppImage won't run, install FUSE: `sudo apt-get install fuse libfuse2`

**Runtime dependencies:**

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1
```

**Building from source on Raspberry Pi:**

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install build dependencies
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev

# Install Node.js and pnpm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm

# Clone and build
git clone https://github.com/armaxri/termiHub.git
cd termiHub
pnpm install
pnpm run build
```

The first build takes 20–30 minutes on Pi 4, less on Pi 5.

**Performance tips:**

- **Raspberry Pi 3/4**: Close unnecessary applications to free RAM. Consider a lightweight desktop environment (LXDE). Increase swap if needed.
- **Raspberry Pi 5**: Should run smoothly with default settings.

**Serial port access:**

```bash
# Add user to dialout group for serial port access
sudo usermod -a -G dialout $USER
# Logout and login for changes to take effect
```

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

---

## Troubleshooting

### `pnpm tauri dev` fails to compile Rust

- Ensure all system dependencies are installed (see [Development Setup](#development-setup) above)
- Run `rustup update` to get the latest Rust toolchain
- On Linux, verify `pkg-config` can find `libssh2`: `pkg-config --libs libssh2`

### WebKitGTK not found (Linux)

```
error: could not find system library 'webkit2gtk-4.1'
```

Install the WebKitGTK development package for your distribution (see [Linux](#linux) section above).

### `libssh2` linking errors

- **Ubuntu/Debian**: `sudo apt install libssh2-1-dev`
- **Fedora**: `sudo dnf install libssh2-devel`
- **Arch**: `sudo pacman -S libssh2`
- **macOS**: Handled automatically by the `ssh2` Rust crate

### Serial port compilation errors (Linux)

```
error: could not find system library 'libudev'
```

Install the udev development package:

- **Ubuntu/Debian**: `sudo apt install libudev-dev`
- **Fedora**: `sudo dnf install systemd-devel`

### ConPTY errors (Windows)

- Ensure you are running Windows 10 version 1809 or later
- Update Windows to the latest version

### Frontend build errors

```bash
# Clear node_modules and reinstall
rm -rf node_modules
pnpm install

# Check TypeScript errors
pnpm build
```

### Rust build takes too long

The first build compiles all Rust dependencies and can take several minutes. Subsequent builds are incremental and much faster. To speed up debug builds:

```bash
# Use fewer codegen units (faster compile, slower runtime — fine for dev)
CARGO_PROFILE_DEV_CODEGEN_UNITS=16 pnpm tauri dev
```
