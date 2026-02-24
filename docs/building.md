# Building termiHub

This guide covers how to set up a development environment and build termiHub from source on macOS, Linux, and Windows.

---

## Prerequisites (All Platforms)

### Node.js

Install [Node.js](https://nodejs.org/) v18 or later.

Verify your installation:

```bash
node --version   # v18.x or later
```

### pnpm

Install [pnpm](https://pnpm.io/installation) (the package manager used by this project):

```bash
npm install -g pnpm
```

### Rust

Install Rust via [rustup](https://www.rust-lang.org/tools/install):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Verify your installation:

```bash
rustc --version
cargo --version
```

### Tauri Prerequisites

Follow the [Tauri v2 prerequisites guide](https://v2.tauri.app/start/prerequisites/) for your platform. The platform-specific sections below summarize the key requirements.

---

## macOS

### System Dependencies

1. **Xcode Command Line Tools** (required for C/C++ compilation):

   ```bash
   xcode-select --install
   ```

2. No additional system libraries are needed on macOS — the required frameworks (WebKit, Security) are included with the OS.

### Development

```bash
pnpm install
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

**Output**: `src-tauri/target/release/bundle/dmg/termiHub_<version>_aarch64.dmg` (Apple Silicon) or `termiHub_<version>_x64.dmg` (Intel).

The build also produces a `.app` bundle in `src-tauri/target/release/bundle/macos/`.

---

## Linux

### System Dependencies

termiHub requires several system libraries. Install them for your distribution:

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

### Development

```bash
pnpm install
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

**Output**: `src-tauri/target/release/bundle/deb/termihub_<version>_amd64.deb` and `src-tauri/target/release/bundle/appimage/termihub_<version>_amd64.AppImage`.

---

## Raspberry Pi / ARM64 Linux

termiHub builds for ARM64 Linux, covering Raspberry Pi 3 (64-bit OS), Pi 4, Pi 5, and other ARM64 SBCs (Orange Pi, Rock Pi, etc.).

### Prerequisites

- 64-bit OS (Raspberry Pi OS Bookworm or newer recommended)
- At least 2GB RAM (4GB+ recommended)

Verify your architecture:

```bash
uname -m
# Should output: aarch64
```

### Installing from Release

**Using .deb Package (Recommended):**

```bash
wget https://github.com/armaxri/termiHub/releases/latest/download/termiHub-X.X.X-linux-arm64.deb
sudo dpkg -i termiHub-X.X.X-linux-arm64.deb
sudo apt-get install -f   # fix dependencies if needed
```

**Using AppImage:**

```bash
wget https://github.com/armaxri/termiHub/releases/latest/download/termiHub-X.X.X-linux-arm64.AppImage
chmod +x termiHub-X.X.X-linux-arm64.AppImage
./termiHub-X.X.X-linux-arm64.AppImage
```

If the AppImage won't run, install FUSE: `sudo apt-get install fuse libfuse2`

### System Dependencies

Same as Linux/Ubuntu above:

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1
```

### Building from Source on Raspberry Pi

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

### Performance Tips

- **Raspberry Pi 3/4**: Close unnecessary applications to free RAM. Consider a lightweight desktop environment (LXDE). Increase swap if needed.
- **Raspberry Pi 5**: Should run smoothly with default settings.

### Serial Port Access

```bash
# Add user to dialout group for serial port access
sudo usermod -a -G dialout $USER
# Logout and login for changes to take effect
```

### Updating

**Using .deb package**: Download the new version and `sudo dpkg -i` it.
**Using AppImage**: Replace the old AppImage with the new one.

---

## Windows

### System Dependencies

1. **Visual Studio Build Tools** — Install the "Desktop development with C++" workload from [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).

2. **WebView2** — Comes pre-installed on Windows 10 (version 1803+) and Windows 11. If missing, download from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

3. **ConPTY** — Required for local terminal support. Available on Windows 10 version 1809 and later.

### Development

```powershell
pnpm install
pnpm tauri dev
```

### Build

```powershell
pnpm tauri build
```

**Output**: `src-tauri\target\release\bundle\msi\termiHub_<version>_x64_en-US.msi` and `src-tauri\target\release\bundle\nsis\termiHub_<version>_x64-setup.exe`.

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

## Development Workflow

### Using Helper Scripts

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

### TypeScript Check

```bash
pnpm build
```

This runs `tsc && vite build` — the TypeScript compiler checks for errors, then Vite builds the frontend.

### Rust Checks

```bash
cd src-tauri
cargo clippy
cargo test
```

### Using the Test Environment

The `examples/` directory includes Docker-based SSH and Telnet servers and virtual serial port scripts for testing without real hardware. See the [examples/README.md](../examples/README.md) for setup instructions.

Quick start:

```bash
cd examples
./start-test-environment.sh
```

This builds Docker containers, starts SSH (port 2222) and Telnet (port 2323) servers, and launches termiHub with pre-configured test connections.

---

## Project Structure Overview

```
termihub/
├── src/                  # React frontend (TypeScript)
│   ├── components/       # UI components
│   ├── hooks/            # React hooks
│   ├── services/         # Tauri API wrappers
│   ├── store/            # Zustand state management
│   ├── types/            # TypeScript type definitions
│   └── utils/            # Utility functions
├── src-tauri/            # Rust backend
│   ├── src/
│   │   ├── terminal/     # Terminal backends (local, SSH, serial, telnet)
│   │   ├── connection/   # Connection config and persistence
│   │   ├── files/        # File browser and SFTP
│   │   ├── monitoring/   # SSH remote system monitoring
│   │   ├── commands/     # Tauri IPC commands
│   │   └── events/       # Event emitters
│   ├── Cargo.toml
│   └── tauri.conf.json
├── agent/                # Remote agent (headless servers, ARM devices)
├── scripts/              # Dev helper scripts (.sh + .cmd)
├── examples/             # Test environment (Docker, virtual serial)
├── docs/                 # Documentation (this directory)
└── package.json
```

See [Architecture Documentation](architecture.md) for the complete architecture documentation.

---

## Troubleshooting

### `pnpm tauri dev` fails to compile Rust

- Ensure all system dependencies are installed (see platform sections above)
- Run `rustup update` to get the latest Rust toolchain
- On Linux, verify `pkg-config` can find `libssh2`: `pkg-config --libs libssh2`

### WebKitGTK not found (Linux)

```
error: could not find system library 'webkit2gtk-4.1'
```

Install the WebKitGTK development package for your distribution (see Linux section above).

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
