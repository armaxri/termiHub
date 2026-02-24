<p align="center">
  <img src="public/icons/termihub-terminal-v2.svg" width="128" height="128" alt="termiHub">
</p>

<h1 align="center">termiHub</h1>

<p align="center">
A modern, cross-platform terminal hub for managing multiple connections.
</p>

<p align="center">
  <a href="https://github.com/armaxri/termiHub/actions/workflows/code-quality.yml"><img src="https://github.com/armaxri/termiHub/actions/workflows/code-quality.yml/badge.svg" alt="Code Quality"></a>
  <a href="https://github.com/armaxri/termiHub/actions/workflows/build.yml"><img src="https://github.com/armaxri/termiHub/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="https://github.com/armaxri/termiHub/actions/workflows/release.yml"><img src="https://github.com/armaxri/termiHub/actions/workflows/release.yml/badge.svg" alt="Release"></a>
</p>

---

termiHub provides a VS Code-like interface for managing multiple terminal connections — local shells, SSH, serial, telnet, Docker containers, and WSL distributions — with split views, drag-and-drop tabs, SSH tunneling, and organized connection management. A shared Rust core (`termihub-core`) powers both the desktop app and a remote agent for persistent sessions on headless servers. Built with [Tauri](https://tauri.app/), [React](https://react.dev/), and [Rust](https://www.rust-lang.org/).

## Features

### Connection Types

- **Local shells** — zsh, bash, PowerShell, cmd, Git Bash with automatic shell detection
- **SSH** — Remote terminal sessions with key-based and password authentication
- **Serial** — Direct serial port connections for hardware debugging and IoT devices
- **Telnet** — Classic telnet connections with IAC protocol support
- **Docker** — Connect to running containers or start new ones
- **WSL** — Windows Subsystem for Linux distribution sessions (Windows only)
- **Remote agent** — Persistent sessions on headless servers via auto-deployed `termihub-agent`

### Terminal Management

- **Split views** — Arrange terminals in horizontal and vertical splits with drag-and-drop
- **Tab management** — Drag-and-drop tabs between panels, per-tab colors, CWD tracking
- **Connection management** — Organize connections in folder hierarchies with import/export from external files

### SSH Features

- **File browser** — Browse, upload, download, and edit remote files via SFTP
- **SSH tunneling** — Local, remote, and dynamic (SOCKS5) port forwarding with session pooling
- **X11 forwarding** — Forward remote GUI applications to your local X server
- **System monitoring** — Real-time CPU, memory, disk, and network stats for remote hosts

### UI and Customization

- **VS Code-inspired layout** — Activity bar, sidebar, status bar with customizable positions
- **Themes** — Dark, Light, and System (auto-detects OS preference) themes
- **Layout presets** — Default, Focus (no sidebar), and Zen (minimal UI) modes
- **Built-in editor** — Edit local and remote files with Monaco Editor (syntax highlighting, search, minimap)
- **Schema-driven settings** — Connection types declare their own settings; the UI renders them automatically

### Security

- **Credential storage** — Optional credential encryption via platform keychain, master password, or prompt-only mode
- **Auto-lock** — Configurable timeout for credential store locking

### Platform Support

- **Cross-platform** — Windows, Linux, and macOS
- **Shared core** — `termihub-core` Rust library shared between desktop and remote agent

## Usage Guide

### Interface Overview

termiHub uses a VS Code-inspired three-column layout:

```
┌──────────┬────────────────┬──────────────────────────────────────────┐
│ Activity │    Sidebar     │           Terminal View                  │
│   Bar    │                │  ┌──────┬──────┬──────┐                 │
│          │  Connections   │  │ Tab1 │ Tab2 │ Tab3 │                 │
│  [Con]   │  File Browser  │  ├──────┴──────┴──────┤                 │
│  [File]  │  Settings      │  │                    │                 │
│          │                │  │  Terminal Content   │                 │
│          │                │  │                    │                 │
│          │                │  │                    │                 │
│          │                │  └────────────────────┘                 │
│  [Gear]  │                │  Status Bar                             │
└──────────┴────────────────┴──────────────────────────────────────────┘
```

- **Activity Bar** — The narrow left column with icon buttons: Connections (network), File Browser (folder), and a gear icon at the bottom for settings, import/export. Click an active icon to toggle the sidebar.
- **Sidebar** — Shows the view selected in the Activity Bar.
- **Terminal View** — The main area with a tab bar, terminal content, toolbar (New Terminal, Split, Close Panel), and status bar.

### Managing Connections

1. Click **Connections** in the Activity Bar, then **+** to create a new connection
2. Fill in Name, Folder, Type (Local Shell / SSH / Serial / Telnet), and type-specific settings
3. Click **Save**

**Right-click** a connection for: Connect, Ping Host (SSH/Telnet), Edit, Duplicate, Delete. **Double-click** to connect immediately.

**Folders** — Create folders via the toolbar icon. Drag and drop connections between folders. Deleting a folder moves children to the parent.

**Import/Export** — Use the gear icon to export connections to JSON or import from a JSON file.

**External Connection Files** — Load shared connection configs from external JSON files (e.g., from a git repo). Add them in Settings > External Connection Files. External connections appear read-only with a git-folder icon.

**Environment Variable Placeholders** — Use `${env:VAR}` syntax in any connection field to substitute environment variables at connect time (e.g., `${env:HOME}/.ssh/id_rsa`).

### Connection Types

- **Local Shell** — Opens a local terminal using an auto-detected shell (zsh, bash, sh on macOS/Linux; PowerShell, cmd, Git Bash on Windows). Select the shell in the connection editor.
- **SSH** — Remote terminal via SSH. See [SSH Configuration](docs/ssh-configuration.md) for authentication, X11 forwarding, SFTP, and troubleshooting.
- **Telnet** — Remote terminal via Telnet protocol. Configure host and port (default: 23).
- **Serial** — Connect to serial devices (USB-to-serial adapters, IoT, networking equipment). Configure port, baud rate, data/stop bits, parity, and flow control. See [Serial Setup](docs/serial-setup.md) for platform-specific instructions.

### Terminal Tabs

Open terminals appear as tabs with type-specific icons and optional colored borders. Actions:

- **Click** to switch, **drag** to reorder or move between panels
- **Right-click** a tab for: Save to File, Copy to Clipboard, Clear Terminal, Horizontal Scrolling, Set Color

Each connection also has terminal options: **horizontal scrolling** and **tab color**, configurable in the editor or via the tab context menu.

### Split Views

Split the terminal area into multiple panels:

- Click the **Split** button in the toolbar, or **drag a tab** to the edge of a panel
- **Drag the divider** to resize panels
- **Close Panel** (X) removes a panel and moves its tabs to an adjacent one
- Splits can be nested (horizontal within vertical and vice versa)
- Drag tabs between panels or to panel edges to create new splits

### File Browser

The sidebar file browser operates in different modes based on the active tab:

| Active Tab      | Mode  | Description                  |
| --------------- | ----- | ---------------------------- |
| Local shell     | Local | Browses the local filesystem |
| SSH             | SFTP  | Browses the remote server    |
| Serial / Telnet | None  | File browser unavailable     |
| Editor/Settings | —     | Retains the last active mode |

**Toolbar:** Up (parent dir), Refresh, Upload (SFTP), New File, New Folder, Disconnect (SFTP).

**Context menu:** Files — Edit, Open in VS Code, Download (SFTP), Rename, Delete. Directories — Open, Rename, Delete.

**Drag-and-drop upload:** In SFTP mode, drag files from your OS file manager onto the browser to upload.

### Built-in Editor

Double-click a file in the file browser (or right-click > Edit) to open it in a Monaco-powered editor tab:

- Syntax highlighting with automatic language detection
- Search and replace (Ctrl+F / Ctrl+H)
- Save with Ctrl+S / Cmd+S, unsaved changes shown as a red dot
- Status bar shows cursor position, language, EOL type, tab size, and encoding

### Keyboard Shortcuts

| Shortcut                 | Action                |
| ------------------------ | --------------------- |
| `Ctrl+Shift+`` (`` ` ``) | New local terminal    |
| `Ctrl+W` / `Cmd+W`       | Close active tab      |
| `Ctrl+Tab`               | Next tab              |
| `Ctrl+Shift+Tab`         | Previous tab          |
| `Ctrl+S` / `Cmd+S`       | Save file (in editor) |

On macOS, `Cmd` can be used in place of `Ctrl`.

### Settings

Click the **gear icon** > **Settings** to open the settings tab. termiHub stores configuration in a platform-specific directory. Override with the `TERMIHUB_CONFIG_DIR` environment variable:

```bash
TERMIHUB_CONFIG_DIR=./my-project/termihub-config pnpm tauri dev
```

### Tips and Tricks

- **Quick connect** — Double-click any connection to open it immediately
- **Organize by project** — Use folders to group connections by project or environment
- **Color-code tabs** — Assign colors to distinguish production, staging, and dev
- **Share configs** — Use external connection files in a git repo for team-wide connection lists
- **Env var placeholders** — Use `${env:VAR}` so shared configs work across machines
- **Split for comparison** — Split the view to compare output from two sessions side by side
- **Auto-SFTP** — The file browser auto-connects to SFTP when you click an SSH tab

---

## Documentation

- **[Contributing](docs/contributing.md)** — Development setup, building, workflow, and coding standards
- **[Scripts](scripts/README.md)** — Helper scripts for setup, dev, build, test, format, and quality checks
- **[Serial Setup](docs/serial-setup.md)** — Serial port configuration per platform
- **[SSH Configuration](docs/ssh-configuration.md)** — SSH keys, X11 forwarding, SFTP
- **[Testing Strategy](docs/testing.md)** — Automated testing layers (unit, integration, E2E)
- **[Manual Testing](docs/manual-testing.md)** — Manual test procedures and regression checklist
- **[Architecture](docs/architecture.md)** — Full arc42 architecture documentation
- **[Remote Protocol](docs/remote-protocol.md)** — Desktop-to-agent JSON-RPC specification
- **[Performance](docs/performance.md)** — Profiling guide and baseline metrics
- **[Releasing](docs/releasing.md)** — Release process and version management

## Built With

- [Tauri 2](https://tauri.app/) — Desktop application framework
- [React 18](https://react.dev/) — UI framework
- [Rust](https://www.rust-lang.org/) — Backend language
- [xterm.js](https://xtermjs.org/) — Terminal emulator component
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — Code editor component
- [Zustand](https://github.com/pmndrs/zustand) — State management
- [dnd kit](https://dndkit.com/) — Drag and drop
- [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) — Split view layout

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

The MIT License is a short, permissive license that allows free use, modification, and distribution. For a plain-language explanation, see [Choose a License: MIT](https://choosealicense.com/licenses/mit/) by GitHub.
