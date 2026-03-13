# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- E2E tests for tab management MT-TAB-01 through MT-TAB-04 — covers open tab from connection (double-click and context menu), close tab, rename tab, and switch between tabs; manual test YAML restructured with updated IDs for remaining drag and save-to-file tests (#459)
- E2E tests for connection management CRUD scenarios MT-CONN-01 through MT-CONN-08 — covers create local/SSH connection, edit, delete, create folder, move connection to folder, and import/export menu flow; manual test YAML updated with automation coverage notes (#458)
- SSH key-based authentication E2E test (SSH-02) — Docker entrypoint generates an ed25519 key pair shared with the test runner via a Docker volume, enabling key-based auth tests in both Linux-native and Docker E2E environments (#485)

### Fixed

- Remote monitoring data never reaching the frontend — the `RemoteMonitoringProxy` created a tokio channel but immediately dropped the sender, and `handle_notification()` in `agent_manager` silently ignored `connection.monitoring.data` notifications; now monitoring notifications are routed through the agent I/O thread to registered monitoring channels (#483)
- Paste (Cmd+V) inserting text twice on macOS — the native browser paste event was reaching xterm.js in addition to the custom paste handler, causing doubled input (#444)
- Terminal not auto-scrolling to the newest output line — xterm.js 6's SmoothScrollableElement does not reliably auto-scroll in WKWebView (macOS Tauri); added explicit `scrollToBottom()` after output writes (#444)
- Terminal output not fully scrollable to the bottom on first command after creation — the SmoothScrollableElement cached stale viewport dimensions from the hidden parking element; fixed by deferring `scrollToBottom()` to after the render pass, sending an explicit resize after session creation, and refreshing the scroll layout on every resize (#444)
- Zoom In shortcut now also triggers when pressing Cmd/Ctrl+Shift+= (producing "+"), not just Cmd/Ctrl+= (#452)
- Zoom shortcuts (Cmd/Ctrl+=/-/0) now scale the entire application UI uniformly using Tauri webview zoom, instead of only adjusting terminal font size (#447)
- Directional panel navigation (Cmd/Ctrl+Alt+Arrow) now remembers and restores the last-focused panel when entering a split group, instead of always selecting the first/last child (#448)

### Changed

- Agent cross-compilation reduced from 6 targets (3 glibc + 3 musl) to 2 static musl-only targets (`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`) — agent binaries are now fully portable with zero runtime dependencies; removed armv7 and all glibc targets from build scripts, CI, and release workflows
- Focus Next/Previous Panel shortcuts replaced with directional panel navigation — Cmd/Ctrl+Alt+Arrow keys now navigate up/down/left/right between split panels (#445)
- Clear Terminal macOS shortcut changed from Cmd+K to Cmd+Shift+K to avoid conflict with the Keyboard Shortcuts chord (Cmd+K Cmd+S) (#445)

### Added

- WSL file browser — browse, read, write, rename, and delete files in WSL distributions via `\\wsl$\<distro>\` UNC paths (#484)
- Session-based file browsing — file listing, reading, writing, deleting, and renaming now work through a session's `ConnectionType` trait, enabling file operations on remote agent connections (#482)
- Post-install smoke test script (`scripts/smoke-test.sh` / `.cmd`) — launches the built app, verifies basic UI functionality via WebDriver (Linux/Windows) or osascript (macOS), and confirms clean shutdown (#457)
- Open Settings (Cmd/Ctrl+,), Clear Terminal (Cmd/Ctrl+Shift+K), and Split Right (Cmd/Ctrl+\\) keyboard shortcuts now work (#445)
- Zoom In (Cmd/Ctrl+=), Zoom Out (Cmd/Ctrl+-), and Reset Zoom (Cmd/Ctrl+0) keyboard shortcuts — zoom scales the entire application UI via Tauri webview zoom (#445)
- Find in Terminal (Cmd+F on macOS, Ctrl+Shift+F on Win/Linux) — inline search bar with case-sensitive and regex toggle, previous/next navigation, powered by @xterm/addon-search (#445)
- Split Down keyboard shortcut (Cmd+Shift+\\ on macOS, Ctrl+Shift+\\ on Win/Linux) — splits the active panel vertically, complementing the existing Split Right shortcut (#446)
- Release readiness checklist script (`scripts/release-check.sh` / `.cmd`) — validates version consistency across all manifest files, changelog formatting, test suite, quality checks, git state, branch, and code markers in a single command (#456)

- Comprehensive keyboard shortcut system with platform-aware defaults — macOS uses Cmd-based shortcuts, Windows/Linux uses Ctrl-based shortcuts; all shortcuts are centralized in a KeybindingService with 18 default bindings across 4 categories (General, Clipboard, Terminal, Navigation) (#418)
- Keyboard shortcuts for terminal clipboard operations — macOS uses Cmd+C/V, Windows/Linux uses Ctrl+Shift+C/V; xterm.js key handler intercepts these before the terminal processes them, fixing the longstanding issue where Ctrl+V on Windows sent a raw control character instead of pasting (#418)
- Select All keyboard shortcut for terminals — Cmd+A on macOS, Ctrl+Shift+A on Windows/Linux (#418)
- Keyboard Shortcuts settings panel — new "Keyboard" category in Settings with search filtering, categorized shortcut table, click-to-record key binding mode, conflict detection, and per-action/global reset; custom bindings persist across restarts (#418)
- Keyboard Shortcuts overlay — opened with Ctrl+K Ctrl+S (Win/Linux) or Cmd+K Cmd+S (macOS), shows all shortcuts in a two-column table with Win/Linux and macOS bindings, search filtering, and current platform highlighting (#418)
- Chord key sequence support — the KeybindingService now supports multi-key chord sequences (e.g., Ctrl+K Ctrl+S) with a 1500ms timeout and pending chord indicator in the status bar (#418)
- Large paste confirmation dialog — pasting more than 5000 characters into a terminal shows a confirmation dialog before proceeding (#418)
- Bracketed paste mode support — when the terminal has bracketed paste mode enabled, pasted text is automatically wrapped in the appropriate escape sequences (#418)

### Fixed

- Keyboard shortcuts now use platform-aware modifier detection — Ctrl+B on macOS no longer toggles the sidebar (it correctly passes through to the terminal as a control character); Cmd+B is used on macOS instead (#418)
- Dev server no longer spams `EMFILE: too many open files` on Windows — Vite's dep scanner and file watcher now exclude the `target/` directory (Rust build artifacts)

### Improved

- Terminal right-click context menu now shows "Copy Selection" first when text is selected, otherwise "Paste" is the first option — previously "Copy All" appeared before "Paste" (#425)
- Docker connection editor now filters the Runtime dropdown to only show runtimes installed on the system; when only one runtime is available, the dropdown is auto-selected and locked (#440)

### Changed

- **Breaking**: Reworked connection data model from flat arrays with synthetic IDs to a nested tree format on disk — connections and folders no longer have IDs in the stored JSON; identity is determined by name within the parent folder (like a filesystem), eliminating ID collisions when sharing connection files via git; path-based IDs are generated deterministically at load time for in-memory use; duplicate sibling names are auto-renamed with `(1)`, `(2)` suffixes; credentials are auto-migrated when connections are renamed or moved (#385)

### Added

- Podman Desktop support — Docker sessions now have a **Runtime** dropdown (Auto / Docker / Podman); Auto detects whichever daemon is available; Podman is shown as "Podman: image" in tab titles; existing connections with no runtime field default to Auto for backwards compatibility (#420)
- `CONTAINER_CMD` detection in all test scripts (`test-system.sh`, `test-system-linux.sh`, `test-system-mac.sh`, `test-system-windows.sh`) — auto-detects Docker or Podman; override via `CONTAINER_CMD=podman` env var (#420)
- `setup-agent-cross.sh` / `setup-agent-cross.cmd` now detect Podman as a fallback for cross-rs when Docker is not available; sets `CROSS_CONTAINER_ENGINE=podman` automatically (#420)
- `build-agents.cmd` and `build-agents.sh` now set `CROSS_ROOTLESS_CONTAINER_ENGINE=false` when Podman is detected, fixing "cargo: Permission denied" inside cross-rs containers caused by Podman's rootless `--user` flag making the injected toolchain non-executable (#420)
- `build-agents.cmd` now sets `CROSS_REMOTE=1` when Podman is the container runtime, avoiding the "statfs /mnt/c/…: input/output error" workspace bind-mount failure; also explicitly sets `CROSS_CONFIG=agent\Cross.toml` (#420)
- `agent/Cross.toml` replaced `pre-build` shell hooks with `image` directives pointing to locally pre-built `localhost/termihub-cross:<target>` images — avoids cross-rs building custom Docker images at compile time (which fails on Windows/Podman because Podman Machine cannot `faccessat` Windows-side build contexts) (#420)
- `setup-agent-cross.cmd` and `setup-agent-cross.sh` now build the six `localhost/termihub-cross:<target>` images as part of setup; on Windows with Podman the images are built via `podman machine ssh` so the Dockerfile is delivered over stdin inside the WSL2 machine, bypassing Windows path access entirely (#420)
- Added `agent/docker/Dockerfile.<target>` files (one per cross-compilation target) that extend the official `ghcr.io/cross-rs/<target>:main` base images with `libudev-dev` and, for ARM targets, the target-architecture `pkg-config` wrapper (#420)
- Switchable right-click terminal behavior — new "Right-Click Behavior" setting in Terminal settings lets users choose between "Context Menu" (macOS/Linux default) and "Quick Copy/Paste" (Windows default, copies selection or pastes if nothing selected); uses Tauri clipboard plugin for native clipboard access (#419)
- "Copy All Logs" option in the LogViewer context menu — copies all filtered log entries to clipboard (#419)
- Frontend debug logging utility (`frontendLog`) that emits messages into the LogViewer for in-app debugging (#419)
- Drag-and-drop reordering for remote agents in the sidebar — agents can now be rearranged by dragging their header; the new order is persisted to disk (#423)
- Right-click "Paste" option in the terminal context menu — reads clipboard text and sends it as terminal input (#416)
- File browser CWD tracking for bash/WSL sessions — the app now injects an OSC 7 `PROMPT_COMMAND` hook when spawning bash, Git Bash, or WSL sessions, so the file browser automatically follows the terminal's working directory; zsh already emits OSC 7 natively and is unaffected (#408)
- Right-click context menu on the terminal area with "Copy Selection" to copy only the selected text, plus "Copy All" for the entire buffer — previously only the tab context menu's "Copy to Clipboard" (entire history) was available (#407)
- Guided manual test runner (`python scripts/test-manual.py`) — a cross-platform CLI tool that walks developers through manual test items one at a time with platform filtering, lazy infrastructure setup (Docker, virtual serial ports), automated verification checks, interactive pass/fail/skip collection, resume support, and JSON report generation; test definitions live in `tests/manual/*.yaml` covering 176 test items across 11 categories (#384)
- Graceful recovery from corrupt configuration files: if `settings.json`, `connections.json`, or `tunnels.json` contain invalid JSON, the app backs up the corrupt file to `.bak`, replaces it with defaults (or recovers individual valid entries for connections), logs the error, and shows a recovery notification dialog on startup — the app never crashes due to corrupt config files (#383)
- Comprehensive Rust integration test suite (52 tests across 7 files) exercising termiHub's SSH, telnet, SFTP, monitoring, and network resilience backends against Docker test containers — tests skip gracefully when containers are not running
- E2E infrastructure tests for SSH banner/MOTD display, SSH key auth UI flow, and Windows shell sessions (PowerShell, cmd.exe, WSL)
- Per-machine system test orchestration scripts (`test-system-mac.sh`, `test-system-linux.sh`, `test-system-windows.sh`) that start Docker containers, run unit + integration + E2E tests, and tear down infrastructure

### Fixed

- All six `agent/docker/Dockerfile.*` images now install `lld` so that GCC's `-fuse-ld=lld` flag (emitted by Rust's gnu-lld linker flavour) can find `ld.lld` in PATH when Rust's bundled `rust-lld` wrapper lacks execute permission after being injected from Windows via `podman cp` (DrvFs strips all +x bits); the entrypoint chmod loop also now scans `/root` in addition to `/cross` to cover `~/.rustup` toolchain placements (#420)
- `build-agents.cmd` CROSS_REMOTE workspace copy fails with "Falscher Parameter (os error 87)" when a file named `NUL` (or other Windows reserved device names) exists in the project root — the previous `bash -c` cleanup ran in the wrong directory when `bash` resolved to WSL bash (which cannot `chdir` to `/mnt/c/…`), silently skipping deletion; fixed by passing the project dir to bash via an env var (`_CROSS_WORKDIR=%CD:\=/%`) so bash explicitly `cd`s there — Git Bash accepts `C:/path`-style paths, WSL bash silently fails and skips deletion; also added `podman container prune -f` before the build loop (and after each failure) to remove stopped containers from previous failed builds and prevent OOM pressure on Podman Machine that caused subsequent targets to be killed with a signal (#420)
- File browser fails in Git Bash on Windows — Git Bash sets `$HOME` to MSYS-style Unix paths like `/c/Users/username` which Windows APIs cannot resolve; now detects and converts MSYS drive paths to native Windows paths (`C:/Users/username`) in `home_dir()` and filesystem operations (#422)
- Build warning on Windows: unused `socket_path` variable in X11 forwarding code — inlined into the `#[cfg(unix)]` branch so it's not created on non-unix platforms (#434)
- SFTP file browser and monitoring fail on SSH connections with `invalid type: sequence, expected a map` — the `sftp_open` and `monitoring_open` Tauri commands tried to deserialize the frontend config directly as `SshConfig`, but the `env` field is stored as an array of `{key, value}` pairs by the schema-driven form; now both commands accept raw JSON and use `parse_ssh_settings` (the same parser used by `create_connection`) for consistent handling (#421)
- SFTP file browser doesn't follow the current working directory in SSH sessions — the SSH backend was missing the OSC 7 `PROMPT_COMMAND` injection that local shell and WSL backends already had; now injects the same `__termihub_osc7` hook after opening the SSH shell channel, so `cd` commands in the remote session are tracked and the SFTP file browser follows along (#421)
- VS Code not recognized on Windows — `code.cmd` is not found by Rust's `CreateProcessW`; now routes through `cmd.exe /c code` so the shell resolves `.cmd` extensions (#417)
- Terminal could not be scrolled when the mouse was in the narrow gap at the bottom of the terminal area — the legacy `.xterm-viewport` element (from xterm.js 5.x) was intercepting wheel events before they reached the xterm.js 6.0 custom scrollbar; made the viewport inert and stretched the scrollable element to cover the full terminal area (#429)
- Agent connection fails with "Parse capabilities: missing field `connectionTypes`" — the desktop `AgentCapabilities` struct expected `connection_types` as plain strings, but the agent sends full `ConnectionTypeInfo` objects (with typeId, displayName, icon, schema, capabilities); updated desktop to accept the rich objects and pass them through to the frontend (#412)
- File browser now works with WSL sessions instead of showing "missing field host" error — WSL tabs are routed to the local file browser mode using `\\wsl$\<distro>\` UNC paths instead of attempting SFTP (#404)
- Remote agent fails to start after successful installation — the SSH exec command used a bare `termihub-agent` binary name that relies on PATH, but `~/.local/bin` is typically not on PATH in non-interactive SSH sessions; now uses the full resolved path (`$HOME/.local/bin/termihub-agent`) for exec, reconnect, and probe commands; added optional `agentPath` field to agent config for custom install locations (#406)
- Collapsed sidebar sections (Connections, remote agents) now fold down to header height instead of occupying equal vertical space — expanded sections fill remaining space like VS Code's sidebar panels; sections are resizable by dragging the separator between them and each section's content scrolls independently (#398)
- WSL connections now correctly show the penguin icon in the sidebar and tab bar — the dedicated `wsl` connection type was falling through to the generic type icon lookup instead of returning the penguin icon (#403)
- WSL distributions no longer appear in the local shell connection dropdown on Windows — they are now only available through the dedicated WSL connection type (#400)
- Local shell connections now display the correct shell-specific icons (PowerShell, Git Bash, WSL) in the sidebar and tab bar — the frontend icon resolution and config creation used a legacy `shellType` key that didn't match the backend schema's `shell` key; old saved connections with `shellType` are handled via backward-compatible fallback (#397)
- Connections can now be dragged out of a folder back to the root level — the folder drop target was covering the entire folder subtree (header + children), preventing the root drop zone from receiving the drop; now only the folder header row is a drop target (#394)
- Duplicate connection names now auto-renamed with `(1)`, `(2)` suffixes in all scenarios: adding, renaming, duplicating, folder deletion, and import — the frontend now reloads from the backend after every persist operation to sync dedup renames; the backend also deduplicates when folder deletion reparents children (#388)
- Grey screen / app crash when dragging a connection into a folder that already contains a connection with the same name — the backend now recomputes the connection's path-based ID after a folder change and correctly migrates credentials; the frontend reloads connections after a move to sync dedup renames
- System crash when creating a connection with a duplicate name — the connection editor now validates names in real-time and shows a red-bordered input with an error message when a duplicate is detected; validation is scoped per folder so the same name is allowed in different folders (#380)
- Default local shell no longer labeled with "(default)" in the connection editor after schema-driven form refactor — the shell option label in the backend schema now includes the suffix again

### Changed

- **Breaking**: Replaced typed `ConnectionConfig` enum (Rust) and discriminated union (TypeScript) with a generic `{type, config}` struct/interface — removes `LocalShellConfig`, `RemoteSessionConfig`, `SshConfig` (TS), `TelnetConfig`, `SerialConfig`, `DockerConfig` type definitions and per-type `expand()` impls; on-disk JSON format is preserved (no data migration required); removes `fromConnectionConfig()`/`toConnectionConfig()` helper functions (#363)
- Connection editor settings UI is now schema-driven — the six hardcoded settings components (SshSettings, SerialSettings, TelnetSettings, DockerSettings, ConnectionSettings, AgentSettings) are replaced by a single generic `ConnectionSettingsForm` that renders fields dynamically from the backend's `SettingsSchema`; connection type capabilities (monitoring, file browser) are now resolved from the backend registry instead of hardcoded type checks (#362)

- **Breaking**: Desktop `SessionManager` replaced legacy `TerminalManager` — sessions now use `Box<dyn ConnectionType>` from `termihub-core` instead of the old `TerminalBackend` trait; per-type desktop backends (local_shell.rs, ssh.rs, serial.rs, telnet.rs, docker_shell.rs, remote_session.rs) removed in favor of core backends; `RemoteProxy` implements `ConnectionType` by forwarding to agents via JSON-RPC; frontend `createTerminal` now maps to the new `create_connection` Tauri command (#361)
- **Breaking**: Agent refactored as thin proxy over `termihub_core::ConnectionType` — the agent no longer contains its own shell/SSH/Docker/serial backend implementations; instead it instantiates `ConnectionType` implementations from core and forwards all calls via JSON-RPC. JSON-RPC protocol migrated from `session.*` to `connection.*` namespace (`session.create` → `connection.create`, `session.input` → `connection.write`, etc.), notifications renamed (`session.output` → `connection.output`), file methods renamed (`files.*` → `connection.files.*`), monitoring renamed (`monitoring.*` → `connection.monitoring.*`), protocol version bumped to 0.2.0. Desktop client updated to match new protocol. (#360)
- Agent Docker backend and Docker file backend marked as deprecated — canonical implementations now live in `termihub_core::backends::docker` (#358)
- Desktop SSH, SFTP, monitoring, X11 forwarding, and SSH auth/key-convert code marked as deprecated — canonical implementations now live in `termihub_core::backends::ssh` (#357)
- Completed shared-rust-core migration (#317): final verification (238 core + 179 agent + 383 frontend tests passing), cleanup, and documentation updates for the `termihub-core` crate — 5,624 lines across 23 source files and 8 modules, 32 public types/traits shared between desktop and agent, spanning 19 issues (#298–#317) across 5 phases
- Agent now implements core transport traits (`OutputSink`, `ProcessSpawner`, `ProcessHandle`, `FileBackend`, `StatsCollector`) via `JsonRpcOutputSink`, `DaemonSpawner`, `DaemonClient`, and updated file/monitoring backends — completing the shared-core architecture where the agent becomes a thin transport adapter (#316)
- Agent file backends (`DockerFileBackend`, `SshFileBackend`, `LocalFileBackend`) now implement the core `FileBackend` trait directly, replacing the agent's own trait definition; `FilesStatResult` is now a type alias for `FileEntry` (#316)
- Agent monitoring collectors (`LocalCollector`, `SshCollector`) now implement the core `StatsCollector` trait, returning `SystemStats`; the monitoring task adds the `host` field when building `MonitoringData` (#316)
- Desktop terminal backends now delegate to `termihub-core` session helpers instead of duplicating logic inline — shell uses `build_shell_command()`, Docker uses `build_docker_run_args()`/`validate_docker_config()`, serial uses `parse_serial_config()`/`open_serial_port()`, SSH uses `validate_ssh_config()`, manager uses `OutputCoalescer`/`contains_screen_clear()`/`osc7_setup_command()` (#310)
- Agent SSH backend now delegates to `termihub_core::session::ssh::{build_ssh_args, validate_ssh_config}` instead of maintaining a local `build_ssh_args()` function and tests — removes ~130 lines of duplicated code (#311)
- Agent Docker backend now delegates to `termihub_core::session::docker::{build_docker_run_args, build_docker_exec_args, validate_docker_config, DockerContainer}` instead of manually building CLI arguments — adds config validation and uses shared container lifecycle helpers (#311)
- Agent serial backend now delegates to `termihub_core::session::serial::{parse_serial_config, open_serial_port, serial_reader_loop}` instead of maintaining local `SerialPortSettings`, `ReaderContext`, `reader_thread()`, and `reconnect_loop()` — removes ~150 lines of duplicated code (#311)
- Agent shell backend now delegates to `termihub_core::session::shell::build_shell_command()` for platform-aware shell resolution instead of a local `detect_default_shell()` function, and supports `initial_command` via `initial_command_strategy()` (#311)
- Removed redundant quality job from Agent CI workflow — formatting, linting, and tests are already covered by the workspace-wide `code-quality.yml` workflow; updated CLAUDE.md individual commands to use workspace-level Cargo commands (#290)
- Desktop crate now imports `FileEntry`, `list_dir_sync`, `chrono_from_epoch`, `format_permissions`, and `normalize_path_separators` from `termihub-core` instead of defining them locally — local `files/utils.rs` module removed entirely (#304)
- Desktop crate now imports `SystemStats`, `CpuCounters`, `parse_stats`, `parse_cpu_line`, `cpu_percent_from_delta`, `parse_meminfo_value`, and `MONITORING_COMMAND` from `termihub-core` instead of defining them locally (#304)
- Agent crate now imports `RingBuffer`, file utilities (`chrono_from_epoch`, `format_permissions`), and monitoring types/parsers (`CpuCounters`, `parse_stats`, `parse_cpu_line`, `cpu_percent_from_delta`, `parse_meminfo_value`, `parse_df_output`, `MONITORING_COMMAND`) from `termihub-core` instead of maintaining local copies — removes ~680 lines of duplicated code (#305)
- Desktop crate now imports `EnvVar`, `VolumeMount`, `SshConfig`, `SerialConfig`, `DockerConfig` from `termihub-core` instead of defining them locally (#298)
- Desktop `expand_tilde()` and `expand_env_placeholders()` now delegate to `termihub-core` instead of duplicating the implementation (#298)

### Added

- Desktop `SessionManager` with `ConnectionTypeRegistry` — creates sessions from the core registry for local connections or via `RemoteProxy` for agent-mediated connections; type-agnostic `create_connection`, `get_connection_types`, `send_input`, `resize_terminal`, `close_terminal` Tauri commands; frontend `createConnection()` and `getConnectionTypes()` API functions with backward-compatible `createTerminal()` adapter (#361)
- `Wsl` backend in `termihub-core` implementing the unified `ConnectionType` trait — Windows-only WSL distribution sessions via `wsl.exe` with PTY support, dynamic distribution picker (detected via `wsl --list --quiet`), settings schema with distribution, starting directory, and initial command fields, file browser capability flag, and async output streaming via tokio channels; `WslConfig` added to core config module (#359)
- `Docker` backend in `termihub-core` implementing the unified `ConnectionType` trait — Docker container sessions via the `bollard` crate (async Docker API), with interactive shell exec, in-container file browsing via `FileBrowser` trait (using exec for `find`/`stat`/`base64`/`rm`/`mv`), dynamic settings schema with `ObjectList` for volume mounts and `KeyValueList` for environment variables, container lifecycle management (create on connect, optionally remove on disconnect), and async output streaming via tokio channels (#358)
- `Ssh` backend in `termihub-core` implementing the unified `ConnectionType` trait — full SSH connection with three authentication methods (agent, key, password), OpenSSH key conversion, X11 forwarding, SFTP file browsing via `FileBrowser` trait, system monitoring via `MonitoringProvider` trait, dynamic settings schema with conditional visibility for auth fields, and async output streaming; uses separate SSH sessions for terminal (non-blocking), SFTP (blocking), and monitoring (blocking) (#357)
- `Telnet` backend in `termihub-core` implementing the unified `ConnectionType` trait — TCP connection with telnet IAC protocol handling, dynamic settings schema (host + port), async output streaming via tokio channels; `TelnetConfig` moved to core, desktop telnet backend marked for deprecation (#356)
- `Serial` backend in `termihub-core` implementing the unified `ConnectionType` trait — serial port connection with dynamic settings schema (port, baud rate, data bits, stop bits, parity, flow control), async output streaming via tokio channels, and cross-platform serial port access via the `serialport` crate; desktop and agent serial backends marked for deprecation (#355)
- `LocalShell` backend in `termihub-core` implementing the unified `ConnectionType` trait — the first concrete backend migration, with dynamic shell detection, settings schema for UI form generation, portable-pty PTY management, and async output streaming via tokio channels; shell detection functions (`detect_available_shells`, `parse_wsl_output`) consolidated from the desktop crate into core (#354)
- Unified `ConnectionType` trait, `SettingsSchema` types, `Capabilities` struct, `MonitoringProvider` trait, `FileBrowser` trait, and `ConnectionTypeRegistry` in `termihub-core` — the foundation for the architecture redesign where all connection backends implement one trait, the UI renders settings forms generically from schemas, and a runtime registry enables connection type discovery (#353)
- Desktop transport trait adapters: `TauriOutputSink` (delivers terminal output/exit/error via Tauri events), `PtySpawner`/`PtyHandle` (spawns shells via `portable-pty`), `SftpFileBackend` (implements `FileBackend` for SFTP), and `MonitoringSession` `StatsCollector` — completes the transport injection pattern where the desktop becomes a thin adapter over the shared core engine (#315)
- Shared core `FileBackend` async trait and `LocalFileBackend` implementation in the `termihub-core` crate — defines a unified file operations interface (`list`, `read`, `write`, `delete`, `rename`, `stat`) that can replace duplicated file backend logic in the desktop and agent crates (#313)
- Shared core serial session helpers (`parse_serial_config`, `open_serial_port`, `list_serial_ports`, `serial_reader_loop`, `ParsedSerialConfig`, `SerialStatus`) in the `termihub-core` crate — unified serial config parsing, port opening, port listing, and reconnect-capable reader loop that can replace duplicated logic in the desktop and agent crates (#308)
- Shared core transport traits (`OutputSink`, `ProcessSpawner`, `ProcessHandle`) in the `termihub-core` crate — abstraction layer that decouples session I/O delivery and process spawning from the desktop (Tauri events, portable-pty) and agent (JSON-RPC, daemon) implementations (#312)
- Shared core session/Docker helpers (`build_docker_run_args`, `build_docker_exec_args`, `validate_docker_config`, `DockerContainer`) in the `termihub-core` crate — unified Docker CLI argument building, config validation, and container lifecycle commands that can replace duplicated logic in the desktop and agent crates (#307)
- Shared core SSH session helpers (`build_ssh_args`, `validate_ssh_config`) in the `termihub-core` crate — unified SSH CLI argument building and config validation that can replace duplicated logic in the desktop and agent crates (#309)
- Shared `RingBuffer` module in the `termihub-core` crate — circular byte buffer moved from the agent so it can be reused by the desktop for reconnect replay and serial capture (#302)
- Shared core session/shell helpers (`detect_default_shell`, `shell_to_command`, `build_shell_command`, `osc7_setup_command`, `initial_command_strategy`) in the `termihub-core` crate — unified shell command building, OSC 7 CWD tracking injection, and initial command strategy that can replace duplicated logic in the desktop and agent crates (#306)
- Shared core monitoring types and parsers (`SystemStats`, `CpuCounters`, `parse_stats`, `parse_cpu_line`, `cpu_percent_from_delta`, `parse_meminfo_value`, `parse_df_output`, `MONITORING_COMMAND`) in the `termihub-core` crate — canonical implementation that replaces duplicated monitoring code in the desktop and agent crates (#301)
- Auto-lock timeout for master password credential store: automatically locks the store after a configurable period of inactivity, with backend timer thread and frontend settings integration (#263)
- Shared core output processing (`OutputCoalescer`, `contains_screen_clear`) in the `termihub-core` crate — unified output coalescing and ANSI screen-clear detection that can replace duplicated logic in the desktop and agent crates (#303)
- Shared core file types and utilities (`FileEntry`, `list_dir_sync`, `chrono_from_epoch`, `format_permissions`, `normalize_path_separators`) in the `termihub-core` crate — unified file entry struct and utility functions that replace duplicated code across the desktop and agent crates (#300)
- Encrypted export/import of connections with credentials: optionally encrypt saved passwords with a user-provided password (Argon2id + AES-256-GCM) when exporting, and decrypt them when importing on another machine — includes Export and Import dialogs with password validation, preview, and error handling (#260)
- Shared core error types (`CoreError`, `SessionError`, `FileError`) in the `termihub-core` crate — unified error definitions that replace duplicated enums across the desktop and agent crates (#297)
- Agent cross-build scripts: `build-agents.sh`/`.cmd` and `setup-agent-cross.sh`/`.cmd` for cross-compiling the remote agent to 6 Linux targets (x86_64/aarch64/armv7 × glibc/musl) from Linux, macOS, or Windows (#276)
- Agent deployment and updates: automatic detection, deployment, and updating of the agent binary when connecting to a remote host — probes for existing agent, deploys if missing, and updates if version is incompatible, with user-visible progress events
- Agent graceful shutdown: new `agent.shutdown` JSON-RPC method lets the desktop shut down the agent cleanly before deploying an update, detaching active sessions for recovery by the next agent instance
- Agent binary download: automatically downloads the correct agent binary from GitHub Releases (with local caching in `~/.cache/termihub/agent-binaries/`) when the bundled binary is not available
- Agent version reporting: `connectAgent` now returns `agentVersion` and `protocolVersion` from the agent handshake for version compatibility checking
- Remote agent file browsing: the agent now supports connection-scoped file browsing via `files.list`, `files.read`, `files.write`, `files.delete`, `files.rename`, and `files.stat` JSON-RPC methods — browse the agent's local filesystem, Docker containers (via `docker exec`), or SSH jump targets (via SFTP relay)
- Remote agent Docker container sessions: the agent can now create interactive terminal sessions inside Docker containers on the remote host, with container lifecycle management, session persistence, and automatic recovery after agent restart
- Inline SSH key file validation: selecting a key file in the SSH connection editor now shows immediate feedback — detects public keys, PuTTY PPK files, unrecognized formats, and missing files before you attempt to connect (#204)
- SSH tunneling with local, remote, and dynamic (SOCKS5) port forwarding — create, edit, start/stop tunnels from a dedicated sidebar panel with live status indicators, traffic stats, and visual tunnel diagrams (#107)
- Tunnel auto-start on app launch and graceful shutdown on window close
- SSH session pool: tunnels sharing the same SSH connection reuse a single session
- Dark, Light, and System color theme support — switch via Settings > Appearance > Theme; System mode auto-follows the OS preference (#193)
- Concept document for SSH tunneling feature: local, remote, and dynamic (SOCKS5) port forwarding with visual diagram-driven configuration UI (#107)
- Concept document for plugin system: plugin API, lifecycle, custom terminal backends, protocol parsers, theme extensions, and plugin management UI (#28)
- Concept document for SSH key passphrase handling: encryption detection, runtime passphrase prompting, session caching, and secure storage options (#121)
- Concept document for cross-platform testing: platform-specific test matrix, CI E2E expansion to Windows, release verification checklists, and platform-aware test infrastructure (#15)
- Concept document for credential encryption: OS keychain integration, master password portable storage, encrypted import/export, and migration from plaintext (#25)
- `CredentialStore` trait, `CredentialKey`/`CredentialType` types, and `NullStore` implementation — foundation for credential encryption with pluggable storage backends (#246)
- `KeychainStore` credential backend using the `keyring` crate — stores credentials in the OS-native keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service) (#250)
- `credentialStorageMode` and `credentialAutoLockMinutes` settings in `AppSettings` (Rust + TypeScript) — controls which credential store backend is active and master password auto-lock timeout (#248)
- Credential store integration in `ConnectionManager`: passwords marked with `savePassword` are routed to the credential store before being stripped from disk, and stored credentials are cleaned up on connection/agent delete (#249)
- `LayoutConfig` type definitions (TypeScript + Rust) with `DEFAULT_LAYOUT` constant and `LAYOUT_PRESETS` (default, focus, zen) — foundation for customizable UI layout (#237)
- Layout state and actions in Zustand store: `layoutConfig`, `layoutDialogOpen`, `updateLayoutConfig`, `applyLayoutPreset` — with debounced persistence to backend settings (#238)
- Layout-aware rendering in `App.tsx`: Activity Bar (left/right/hidden), Sidebar (left/right, toggleable visibility), and Status Bar (toggleable visibility) now render conditionally based on layout config — Activity Bar indicator flips to right edge when positioned right (#239)
- "Customize Layout..." menu entry in Activity Bar settings dropdown — opens the layout customization dialog (#241)
- `savePassword` optional field on `SshConfig` and `RemoteAgentConfig` (Rust + TypeScript) — preparatory for credential encryption (#25, #247)
- `CredentialStore` trait, credential types (`CredentialKey`, `CredentialType`, `CredentialStoreStatus`, `StorageMode`), `NullStore` implementation, and `create_credential_store` factory function — foundation for pluggable credential storage (#246)
- Horizontal Activity Bar mode: when `activityBarPosition` is set to `"top"`, the Activity Bar renders horizontally above the main content area with icons in a row, bottom-edge indicator, and downward-opening settings dropdown (#240)
- Customize Layout dialog: preset cards (Default, Focus, Zen) with mini schematics, Activity Bar/Sidebar/Status Bar visibility and position controls with immediate-apply changes (#242)
- Layout Preview in Customize Layout dialog: live miniature schematic showing Activity Bar, Sidebar, Terminal Area, and Status Bar positions — updates in real-time as layout settings change (#243)
- `MasterPasswordStore` credential backend — encrypts all credentials into a single file using Argon2id key derivation and AES-256-GCM authenticated encryption, with setup/unlock/lock/change-password lifecycle and atomic file writes (#251)
- `CredentialManager` runtime wrapper with `StorageMode` switching, settings-based initialization, and Tauri IPC commands for credential store status, lock/unlock, setup, password change, backend switching with credential migration, and keychain availability check (#252)
- Frontend credential store integration: TypeScript types, API wrappers for all 7 credential store commands, event listeners for lock/unlock/status-changed, and Zustand state with automatic status loading on startup (#253)
- "Save password" and "Save passphrase" checkboxes in SSH and Agent connection editors — shown when a credential store is configured (keychain or master password), with mode-dependent hints; when no store is configured, a hint directs users to enable secure storage in Settings (#255)
- Security settings panel in Settings UI: choose credential storage mode (OS Keychain, Master Password, or None) with radio group, keychain availability indicator, master password setup/change dialogs, auto-lock timeout dropdown, and credential migration feedback (#254)
- Master password unlock dialog on app startup when credential store is locked, setup/change password dialog with strength indicator and validation, and status bar lock/unlock indicator for the credential store (#257)
- Credential store integration in connection flow: SSH and agent connections now automatically resolve stored credentials before prompting the user, with stale credential detection and cleanup on auth failure (#258)
- External connection file credential migration: plaintext passwords in external JSON files are now automatically routed to the credential store and stripped from disk on first load, matching the existing migration for the main connections file (#262)
- Unified configuration types in `termihub-core` crate: `ShellConfig`, `SerialConfig`, `DockerConfig`, `SshConfig`, `PtySize`, `EnvVar`, `VolumeMount` — superset types shared between desktop and agent, with config value expansion utilities (`expand_tilde`, `expand_env_placeholders`, `expand_config_value`) (#295)
- JSON-RPC 2.0 protocol types and error codes in `termihub-core` crate: `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcErrorResponse`, `JsonRpcErrorData`, `JsonRpcNotification` message types (all with `Serialize` + `Deserialize`) and standard/application error code constants — shared between desktop and agent (#296)

### Fixed

- `credentialStorageMode` TypeScript type now uses `"master_password"` (snake_case) matching the Rust backend's `StorageMode::to_settings_str()` — was incorrectly `"masterPassword"` (camelCase)
- Theme switching in Settings > Appearance now applies immediately instead of requiring an app restart (#224)
- Eliminated white flash on startup — window now starts with dark background (#1e1e1e) instead of flashing white before the theme loads (#192)
- Terminal input not working on new connections: a React StrictMode race condition could route keyboard input to the wrong backend session, making it appear as if typing had no effect; terminals now also auto-focus when created or switched to (#198)
- Vertically split panels can now be resized — the resize handle between top/bottom panels was invisible due to missing CSS height (#213)

### Changed

- Reorganized Rust crates into a Cargo workspace with a new shared `termihub-core` crate (empty scaffolding for future code sharing between desktop and agent) (#283)
- `ConnectionManager` now routes credentials to the active `CredentialStore` via `prepare_for_storage` before stripping passwords on disk — with `NullStore` as default, behavior is identical to before; credentials are cleaned up when connections or agents are deleted (#249)
- Split view panels now have a visible 1px border between them, making it easier to distinguish adjacent panels (#189)
- Active tabs now show a colored top border: bright blue in the focused panel, dimmed in unfocused panels, following VS Code's tab highlight pattern (#190)
- External connection files now display in a unified tree alongside local connections instead of separate sections; storage location is configurable via an Advanced dropdown in the connection editor (#210)

### Added

- Default user and SSH key path from General Settings are now applied when creating new SSH and Remote Agent connections, pre-filling username and switching to key authentication when configured (#201)
- General Settings "Default SSH Key Path" field now uses the same `~/.ssh/` file suggestion dropdown as the connection editor (#201)
- SSH key path file suggestions: the Key Path field in SSH and Agent settings now scans `~/.ssh/` and shows a dropdown of available private key files with type-ahead filtering, arrow-key navigation, and Tab/Enter to accept (#118)
- Connection editor now uses a categorized two-panel layout matching the global settings panel: Connection, Terminal, and Appearance categories with sidebar navigation and responsive compact mode
- Per-connection terminal overrides: font family, font size, scrollback buffer, cursor style, cursor blink, and horizontal scrolling can be configured per-connection, overriding global defaults
- Sidebar toggle button in the terminal toolbar and `Ctrl+B` (`Cmd+B` on Mac) keyboard shortcut to quickly hide/show the sidebar (#194)
- Per-SSH-connection monitoring and file browser settings: each SSH connection can now override the global defaults with Enabled/Disabled/Default, configured in the SSH connection editor
- Power monitoring and file browser can now be independently disabled in Settings > Advanced (#199)
- Redesigned Settings panel with a categorized two-panel layout: General, Appearance, Terminal, and External Files categories with a sidebar navigation, search bar, and version footer (#191)
- New settings: default user, default SSH key path, default shell, theme, font family, font size, horizontal scrolling default, scrollback buffer, cursor style, and cursor blink
- Terminal settings (font, cursor, scrollback) are applied live to existing terminals when changed
- Settings search filters across all categories with keyword matching
- Responsive compact mode: settings navigation collapses to horizontal tabs when the panel is narrow
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
