# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Split view panels now have a visible 1px border between them, making it easier to distinguish adjacent panels (#189)

### Added

- Per-SSH-connection monitoring and file browser settings: each SSH connection can now override the global defaults with Enabled/Disabled/Default, configured in the SSH connection editor
- Power monitoring and file browser can now be independently disabled in Settings > Advanced (#199)
- Remote agent shell sessions: the agent now spawns real PTY-backed shell sessions via independent daemon processes, with ring-buffered output, terminal resize support, session persistence across agent restarts, and automatic session recovery
- SSH key path browse button: key path fields in SSH and Agent settings now include a "..." button that opens a native file picker defaulting to `~/.ssh` (#117)
- Auto-extract port from host field: pasting `192.168.0.2:2222` or `[::1]:22` into the host field of SSH, Telnet, or Agent settings automatically splits the value into host and port on blur (#185)

### Changed

- Renamed "TermiHub" to "termiHub" throughout the project (documentation, window title, CI artifacts, scripts) to reflect the intended lowercase branding

### Fixed

- SSH terminals with zsh Agnoster theme no longer show a jarring black rectangle behind the user@host prompt segment; ANSI black now matches the terminal background (#197)
- Rapidly creating two WSL/SSH connections after startup no longer flashes initial shell output (welcome banner, setup commands) before the screen clear (#175)
- Product name casing: changed `productName` in `tauri.conf.json` from `termihub` to `termiHub` and fixed macOS binary paths in `wdio.conf.js`, `test-system.sh`, and `building.md`
- File browser now navigates to home directory when switching to a tab without CWD tracking (e.g., PowerShell), instead of staying on the previous tab's directory (#167)

### Added

- Connection error feedback dialog for remote agents: categorized error messages ("Could Not Reach Host", "Authentication Failed", "Agent Not Installed") with a "Setup Agent" button when the agent binary is missing
- Agent setup wizard: right-click a remote agent and select "Setup Agent..." to upload and install the agent binary on the remote host via SFTP, with visible setup progress in an SSH terminal tab. Supports configurable install path and optional systemd service installation (#137)
- SFTP file browser now follows SSH terminal working directory: running `cd /tmp` in an SSH session automatically navigates the file browser to `/tmp` (#158)
- Log Viewer: new activity bar button opens a log viewer tab displaying backend tracing logs in real time with level filtering (ERROR/WARN/INFO/DEBUG), text search, pause/resume auto-scroll, clear, and save-to-file functionality (#183)
- Log Viewer entry context menu: right-click a log entry to copy it to clipboard or save all logs to a file
- Backend log capture layer: custom tracing subscriber captures logs into a 2000-entry ring buffer and streams them to the frontend via Tauri events
- Tracing instrumentation across terminal backends (local shell, SSH, serial, telnet), command handlers, SFTP, monitoring, and agent operations
- Docker shell support: create interactive terminal sessions inside Docker containers with image selection (autocomplete from local images), environment variable configuration, volume mounts with directory browser, working directory setting, and optional container removal on exit (#166)
- Docker availability detection and image listing via `docker info` and `docker images` CLI commands
- Remote agent Docker protocol support: agents report Docker availability and images in capabilities, with Docker as a new session type
- Manual tests input file (`docs/manual-tests-input.md`) collecting all manual test steps from PRs for regression testing and future automation
- System test script (`scripts/test-system.sh`) that orchestrates Docker infrastructure (SSH + Telnet servers), virtual serial ports (socat), and the E2E infrastructure test suite for automated system-level testing on macOS
- Implemented E2E infrastructure tests for SSH (password auth, connection failure, session output), Telnet (connect, send/receive, failure handling), and Serial (port enumeration, virtual port connection, non-default config parameters)
- Remote agents as folder-like entries in the sidebar: one shared SSH connection per agent with multiple child sessions (shell/serial) multiplexed over JSON-RPC
- Agent capabilities discovery: available shells and serial ports are reported by the remote agent on connect and shown in session creation
- Persistent sessions for remote agents: sessions flagged as persistent survive reconnection and are re-attached automatically
- Agent session definition storage on the remote agent (saved to `~/.config/termihub-agent/sessions.json`)
- Sidebar context menu for remote agents: Connect, Disconnect, Edit, New Shell Session, New Serial Session, Delete
- Connection state indicators on agent nodes (colored dot for disconnected/connecting/connected/reconnecting)
- Password prompt for remote agent SSH connections using password authentication
- Shell-specific icons for terminal tabs: PowerShell shows a biceps icon, Git Bash shows a git branch icon, and WSL shows a penguin icon instead of the generic terminal icon
- Per-connection custom icons via a searchable icon picker dialog in the connection editor — choose from 2,000+ icons with tag-based search (e.g. search "arm" to find the biceps icon)
- Native support for OpenSSH-format private keys (Ed25519, RSA) for SSH authentication — keys generated by modern `ssh-keygen` now work without ssh-agent
- Passphrase-protected SSH key support via the connection editor (key passphrase field shown when auth method is "SSH Key")
- Default shell detection and labeling: the user's system default shell (e.g., Zsh on macOS) is now detected and marked with "(default)" in the shell dropdown
- Configurable starting directory for local shell connections — set a custom working directory per connection instead of always starting in the home directory
- Rename terminal tabs via right-click context menu on tabs or the terminal area

### Changed

- Remote connections redesigned: the flat "Remote" connection type is replaced by a two-level model — remote agents (SSH transport) contain child sessions (shell/serial)
- Remote Agent settings form now only shows SSH transport fields; session configuration is separate
- Removed folder selector from the connection editor; use drag-and-drop in the sidebar to organize connections into folders

### Removed

- Old `RemoteConfig` type and `RemoteSettings` component (replaced by `RemoteAgentConfig` + `RemoteSessionConfig`)
- Old `RemoteBackend` Rust implementation (replaced by `AgentConnectionManager` + `RemoteSessionBackend`)

### Fixed

- Connection monitor hides when switching to non-SSH tabs (Fixes #162)
- SSH connection monitor now auto-connects when switching to an SSH terminal tab (Fixes #159)
- Fix high CPU usage caused by monitoring auto-connect infinite retry loop (Fixes #161)
- Windows: SSH key authentication failing with "invalid filename syntax" (os error 123) due to mixed path separators from tilde expansion — now uses the centralized `expand_tilde` which handles platform-native separators
- Browser's default context menu ("Print", "Save As", etc.) no longer appears on right-click; only custom app menus are shown
- Windows: WSL file browser now follows the terminal's working directory by injecting OSC 7 PROMPT_COMMAND into WSL shells
- Windows: WSL file browser no longer shows "access denied" when the CWD is under `/mnt/c/` — drive-mounted paths are now converted directly to native Windows paths instead of routing through the `\\wsl$\` UNC share
- CI: Windows-specific `normalize_separators` tests no longer fail on macOS and Linux

- Windows: WSL shell tabs now browse the WSL Linux filesystem (via `\\wsl$\` UNC paths) instead of the Windows filesystem
- Windows: file browser path navigation (navigate-up, rename) now works correctly by normalizing backend paths to forward slashes
- Powerline glyphs (e.g., agnoster zsh theme) rendering as boxes on Windows by bundling MesloLGS Nerd Font Mono
- Windows: PowerShell and Git Bash shells launching WSL instead of the correct shell due to bare executable names being intercepted by WSL interop; now resolved via absolute paths
- Windows: `bash` shell type on Windows now routes to Git Bash instead of being intercepted by WSL
- Windows: new terminal tabs (keyboard shortcut / "+" button) defaulting to `zsh` instead of the platform default shell, causing WSL errors on Windows
- Windows: connection editor defaulting to `bash` instead of the platform default shell when creating new local connections (race condition with async shell detection)

### Added

- Windows: WSL distributions now appear as shell options — each installed distro (e.g., "WSL: Ubuntu") is automatically detected and selectable in the connection editor
- SSH agent setup guidance: detect when the SSH agent is not running and offer a guided setup flow with pre-filled PowerShell commands (Windows) or shell instructions (Unix)
- "Save & Connect" button in the connection editor to save and immediately open a terminal session
- Serial port proxy support in the remote agent: serial ports connected to the Raspberry Pi are now accessible from the desktop app over SSH
- 24/7 serial data buffering with 1 MiB ring buffer: data is captured continuously and replayed when a client attaches
- Serial port disconnection detection and automatic reconnection in the remote agent
- Agent-side `session.attach`, `session.detach`, `session.input`, and `session.resize` protocol handlers
- E2E performance stress test for 40 concurrent terminals with creation throughput, UI responsiveness, and cleanup timing measurements (`pnpm test:e2e:perf`)
- Performance profiling guide (`docs/performance.md`) with Chrome DevTools instructions, baseline metrics, and memory leak detection checklist
- Session limit of 50 concurrent terminals with clear error when exceeded
- Remote Agent connection type: connect to `termihub-agent` on Raspberry Pi for persistent shell and serial sessions that survive desktop disconnects
- Auto-reconnect for remote connections with exponential backoff and visual state indicators on tabs
- Remote Agent settings form with SSH connection fields, session type selector (shell/serial), and conditional serial port configuration
- TCP listener mode (`--listen`) for the remote agent, enabling persistent systemd service operation with session survival across client reconnects
- Graceful shutdown via SIGTERM/SIGINT signal handling in the remote agent
- systemd service unit file and install script for Raspberry Pi deployment
- Remote agent stub binary (`termihub-agent`) for Raspberry Pi with JSON-RPC 2.0 protocol over stdio, supporting initialize handshake, session create/list/close, and health check
- CI workflow for agent crate with formatting, linting, tests, and ARM64 cross-compilation
- Remote session management protocol specification (`docs/remote-protocol.md`) for desktop-to-agent communication over SSH
- SSH remote monitoring panel for viewing system stats (CPU, memory, disk, uptime, load average, OS info) of connected SSH hosts with auto-refresh
- E2E test suite with WebdriverIO and tauri-driver (~30 tests across 8 files) covering connection forms, CRUD operations, tab management, split views, local shell spawn, file browser, settings, and tab coloring
- E2E test helpers for selectors, app lifecycle, connection management, tab operations, and sidebar navigation
- Infrastructure test stubs for SSH, serial, and telnet connections (requires live servers)
- E2E test scripts: `test:e2e`, `test:e2e:ui`, `test:e2e:local`, `test:e2e:infra`
- Testing strategy document (`docs/testing.md`) covering unit, integration, E2E, and visual regression testing
- E2E test scaffolding with WebdriverIO and Tauri service (`wdio.conf.js`, `tests/e2e/`)
- VS Code workspace settings (`.vscode/settings.json`) with Vitest, ESLint, Prettier, and rust-analyzer configuration
- VS Code extension recommendations for Vitest, Test Explorer, ESLint, and Prettier
- `data-testid` attributes on all interactive UI elements for E2E test automation
- Vitest unit tests for API service wrappers (~37 tests), event listeners (~8 tests), shell detection (~7 tests), and additional store operations (~31 tests covering folders, duplicate/move connections, settings tab, editor tab)
- LICENSE file with full MIT License text
- "Built With" section in README with links to all major dependencies
- GitHub Actions CI/CD workflows (code quality, build, release)
- ESLint, Prettier, and commitlint configuration for code quality enforcement
- Raspberry Pi deployment guide (`docs/raspberry-pi.md`)
- Release process documentation (`docs/releasing.md`)
- Automated unit tests for Rust backend (~41 new tests) covering shell detection, file utilities, connection config serialization, external file management, and environment variable expansion
- Automated unit tests for TypeScript frontend (~43 tests) covering formatters, panel tree operations, and Zustand store actions
- Vitest test framework for frontend with jsdom environment and coverage support
- Manual test plan document (`docs/manual-testing.md`) for features requiring hardware or live connections
- User documentation: user guide, build instructions, serial setup, SSH configuration, and contributing guide
- X11 forwarding for SSH connections: forward remote GUI applications to local X server
- Environment variable placeholders in connection settings: use `${env:VAR}` syntax for shared configs
- Tab coloring: assign colors to terminal tabs from the connection editor or via right-click context menu
- Status bar shows cursor position, language, line ending, tab size, and encoding for the built-in editor
- Double-click a file in the file browser to open it in the built-in editor
- Right-click context menu on files and directories in the file browser
- New File button in the file browser toolbar to create empty files (local and remote)
- Built-in file editor: edit local and remote files directly in the app with syntax highlighting, search/replace, and Ctrl+S saving
- Open in VS Code: edit local and remote files directly from the file browser
- External connection files: load shared connection configs from JSON files via Settings
- Per-connection horizontal scrolling option with runtime toggle via tab context menu
- Example directory with Docker-based SSH and Telnet test targets
- Virtual serial port testing via socat
- Support for `TERMIHUB_CONFIG_DIR` environment variable to override config directory
- Sidebar file browser automatically shows the working directory of the active terminal tab
- Local filesystem browsing with rename, delete, and create directory support
- Auto-connect SFTP when switching to SSH terminal tabs
- Ping host via right-click context menu on SSH and Telnet connections
- Copy terminal content to clipboard via right-click context menu on tabs
- Save terminal content to file via right-click context menu on tabs
- Clear terminal content via right-click context menu on tabs
- Status bar at the bottom of the application window
- Cross-panel tab drag-and-drop: move tabs between terminal panels by dragging
- Split-by-drop: drag a tab to the edge of a panel to create horizontal or vertical splits
- Visual drag feedback with tab ghost overlay and highlighted drop zones
- Nested split layout supporting both horizontal and vertical terminal arrangements
- VS Code-inspired dark theme with three-column layout (Activity Bar, Sidebar, Terminal View)
- Activity Bar with icon navigation for Connections, File Browser, and Settings views
- Sidebar with collapsible panel and view switching
- Connection List tree view with expandable folders and type-specific icons
- Connection Editor with forms for Local Shell, SSH, Serial, and Telnet connections
- File Browser with virtualized list, directory navigation, and file size display
- Terminal component with xterm.js integration and local echo demo mode
- Tab Bar with drag-and-drop reordering via dnd-kit
- Split View with resizable panels using react-resizable-panels
- Terminal toolbar with New Terminal, Split, and Close Panel actions
- Context menus on connections (Connect, Edit, Delete)
- Keyboard shortcuts: Ctrl+Shift+` (new terminal), Ctrl+W (close tab), Ctrl+Tab / Ctrl+Shift+Tab (switch tabs)
- Zustand-based state management for sidebar, panels, tabs, connections, and files
- Type definitions for terminals, connections, and events
- Real local shell terminals using PTY (zsh, bash, sh on Unix; PowerShell, cmd, Git Bash on Windows)
- Serial port connections with configurable baud rate, data bits, stop bits, parity, and flow control
- SSH connections with password and key-based authentication
- Telnet connections with basic IAC protocol handling
- Backend terminal management with session lifecycle, input/output streaming, and resize support
- Auto-detection of available shells on the current platform
- Auto-detection of available serial ports in the connection editor
- Terminal output streaming via Tauri events
- Process exit detection with "[Process exited]" indicator
- Error display in terminal when connection fails
- Connection persistence: saved connections and folders survive app restarts
- Connection import/export as JSON files
- Folder deletion with automatic reparenting of child connections and subfolders
- Context menu on folders with delete option
- SSH file browser with SFTP: browse, upload, download, rename, and delete remote files
- SFTP connection picker to connect to any saved SSH connection
- Directory creation via the file browser toolbar
- File permissions display (rwx) for remote entries
- Context menus on files (Download, Rename, Delete) and directories (Open, Rename, Delete)

- Right-click context menus on connections (Connect, Edit, Duplicate, Delete) and folders (New Connection, New Subfolder, Delete)
- Duplicate connection via context menu (creates "Copy of <name>" in the same folder)
- Drag-and-drop connections between folders to reorganize them
- Double-click a connection to connect directly

### Fixed
- Black bar visible at the bottom of terminal tabs caused by xterm.js viewport default background color mismatch
- Terminal text appearing doubled on macOS (e.g., "llss" instead of "ls") caused by duplicate Tauri event listeners under React StrictMode
- Local file explorer now loads the user's home directory on first open instead of showing an empty root
- New terminal tabs now start in the user's home directory instead of the system root
- File browser now stays visible when editing a file, showing the parent directory
- Horizontal scroll width now updates dynamically as terminal output arrives
- Key repeat not working on macOS (accent picker shown instead)

### Changed

- SSH monitoring moved from sidebar panel to compact status bar display with connection picker, live stats, and detail dropdown
- Editor language mode can now be changed via a searchable dropdown in the status bar
- Editor indent selector now supports tabs and configurable sizes (1, 2, 4, 8) via a dropdown menu in the status bar
- Connection editor now opens as a tab in the main panel area instead of the sidebar, providing more space for settings forms
- Remote Agent connections are now functional — connect to `termihub-agent` running on remote hosts with auto-reconnect and visual status indicators
- Terminal output events now use a singleton dispatcher with O(1) Map-based routing instead of per-terminal global listeners (O(N) fan-out)
- Terminal output writes are batched via `requestAnimationFrame` to reduce rendering overhead
- Backend output channels now use bounded `sync_channel(64)` with backpressure instead of unbounded channels
- Backend output reader coalesces pending chunks (up to 32 KB) into a single Tauri event to reduce IPC overhead
- All mutex `.unwrap()` calls in terminal backends replaced with proper error propagation
- Development guidelines updated to encourage smaller, more frequent commits per logical step
- Custom application icon replacing default Tauri placeholder
- Proper README replacing Tauri template boilerplate
- SSH password authentication now prompts for password at each connection instead of storing it
- Moved Import/Export connections from connection list toolbar to the Settings gear dropdown menu
- Settings button now opens a Settings tab instead of a sidebar view
- Moved settings button to the bottom of the activity bar, matching VS Code's layout
- Panel layout refactored from flat array to recursive tree for flexible split arrangements
- Connection and folder context menus now open on right-click instead of left-click
- Shell type dropdown in connection editor now only shows shells available on the current platform

### Security

- Removed plaintext SSH password storage from connections file
