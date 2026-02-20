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
├── agent/                # Raspberry Pi remote agent
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
