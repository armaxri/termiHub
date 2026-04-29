# Concept Documents — Status Overview

All concept documents whose GitHub issue is closed live in [`handled/`](handled/). Each entry
below notes its implementation status: **fully implemented**, **partially implemented** (with
what remains open), or **not implemented** (concept design done, feature not yet built).

## Open Concepts

These documents have no closed concept issue. They represent actively planned features or
ongoing process documents with no specific implementation issue yet.

### in-field-update-mechanism.md

Concept for notifying installed users of available updates and delivering them in-app. Compares
three variants — notify-only (Phase 1), download-and-prompt (Phase 2), fully automatic (Phase 3)
— with full codebase impact and code signing requirement analysis. Proposes a phased adoption
path starting with minimal notify-only implementation.

### release-planning-and-dependency-management.md

Concept for structured release planning, dependency vulnerability monitoring, and security
response workflows. Defines release types (security patch, bug-fix, minor, major) with SLA
targets, Dependabot configuration for npm and Cargo, hardened CI audit checks, and a hotfix
branching model for emergency security patches.

### remote-agent-update-strategy.md

Concept for delivering updated agent binaries to remote hosts. Covers the update delivery
mechanism, version negotiation, and rollback strategy.

### remote-client-mode.md

Concept for accessing termiHub as a web application (browser) and as an iPad app. Defines a
shared transport abstraction layer (TauriTransport vs. WebSocketTransport) so the React frontend
works unchanged across Tauri IPC and WebSocket connections. Covers the agent's embedded HTTP/WS
server, JWT-based auth, TLS, QR-code pairing, touch toolbar for iPad, no-local-shell enforcement
on constrained clients, and a four-phase rollout plan.

### shell-context-menu-integration.md

Concept for OS-level "Open in termiHub" context menu integration on Windows, macOS, and Linux,
plus a `termiHub spawn` CLI subcommand. Covers multi-entry configuration, Windows extended
(Shift+Right-click) variants, an in-app session picker dialog, Docker/Podman container mounting,
IPC architecture (named pipe / Unix socket), and platform-specific registration mechanics.

---

## Handled Concepts

All of these live in [`handled/`](handled/) — their concept issues are closed.

---

### Fully Implemented

#### agent.md

Fully implemented. The remote agent is fully implemented in the `agent/` crate. It includes the
JSON-RPC protocol, session daemon with binary frame protocol, shell/Docker/SSH/serial backends,
file browsing (local, SFTP relay, Docker), system monitoring, and state persistence. No specific
concept issue was filed — the document predates the issue tracker workflow.

#### agent-settings-separation.md (Issue #608)

Fully implemented. The connection editor for remote agents has a second **Agent** tab alongside
**Connection** (transport). `AgentSettingsForm.tsx` renders runtime settings (feature toggles,
defaults, diagnostics) in a dedicated panel. `AgentSettings` is persisted in `connections.json`
as a field on `SavedRemoteAgent`.

#### app-icons.md (Issue #641)

Fully implemented. All required icon assets are present in `src-tauri/icons/`: `icon.icns`
(macOS), `icon.ico` (Windows), a Linux PNG set (16×16, 32×32, 128×128, 128×128@2x), and the
full Windows Store tile set (Square30×30 through Square310×310).

#### customize-layout.md (Issue #196)

Fully implemented. All implementation tickets are closed: #238 (layout state and actions in
Zustand store), #241 ("Customize Layout..." menu entry in Activity Bar), #242
(`CustomizeLayoutDialog` with presets and controls), #243 (`LayoutPreview` component). The
dialog, layout presets, and live preview are all live.

#### embedded-network-daemons.md (Issue #526)

Fully implemented. `src-tauri/src/embedded_servers/` contains HTTP (`http_server.rs`), FTP
(`ftp_server.rs`), and TFTP (`tftp_server.rs`) server implementations, a server manager with
lifecycle management, configuration persistence, status tracking, and Tauri event emission.

#### guided-manual-testing.md

Fully implemented. YAML test definitions live in `tests/manual/` (14 files covering all feature
areas). The interactive Python runner is `scripts/test-manual.py`. Coverage includes SSH, serial,
file browser, network tools, keyboard, connection management, embedded services, credentials,
portable mode, and more.

#### key-combinations.md (Issue #418)

Fully implemented. `src/components/Settings/KeyboardSettings.tsx` provides a full keybinding
editor with per-action customization, platform-specific defaults, and reset-to-defaults support.
`src/services/keybindings.ts` handles serialization and effective-combo resolution.

#### keyboard-cheatsheet-export.md

Fully implemented. `src/utils/cheatSheetPdf.ts` generates a self-contained HTML cheat sheet
from the current effective keybindings (honoring per-user overrides). The "Export Cheat Sheet…"
button in Settings → Keyboard Shortcuts triggers it. Export uses the Tauri file-save dialog to
write an `.html` file (named `termihub-shortcuts.html`), which the user can open in any browser
and print to PDF. Note: a native PDF was not pursued because `window.print()` is blocked in
Tauri's WebView.

#### network-utilities.md (Issue #525)

Fully implemented. `src/components/NetworkTools/` provides ping (`PingPanel.tsx`), traceroute
(`TraceroutePanel.tsx`), port scanner (`PortScannerPanel.tsx`), DNS lookup (`DnsLookupPanel.tsx`),
HTTP monitor (`HttpMonitorPanel.tsx`), Wake-on-LAN (`WolPanel.tsx`), latency chart
(`LatencyChart.tsx`), open ports panel (`OpenPortsPanel.tsx`), and a network diagnostic panel.

#### nicer-settings.md (Issue #191)

Fully implemented. Two-panel layout with category sidebar (`SettingsNav`), search bar
(`SettingsSearch`), debounced auto-save, responsive compact mode, and version footer are all
present. All four original categories exist: General, Appearance, Terminal, and External Files.
The `SettingsNav` was extended to be generic and reusable (PR #216 applied it to the connection
editor). Related tickets #201 and #199 are closed; #254 (Security settings) extends beyond the
original scope.

#### portable-mode.md (Issue #524)

Fully implemented. `src-tauri/src/utils/portable.rs` detects a `portable.marker` file next to
the executable (or next to the `.app` bundle on macOS). When found, `AppMode::Portable` stores
all config under the adjacent `data/` directory instead of the system profile path. Path
placeholders are resolved via `resolve_portable_path()`.

#### prepared-connection-setup.md (Issue #503)

Fully implemented (as Workspaces). The `WorkspaceSidebar` activity bar section lets users
define, save, and restore named layouts with pre-configured connections. Workspaces are JSON
files (`src/types/workspace.ts`), selectable via CLI argument (`--workspace <name>`). Backend:
`src-tauri/src/workspace/`. Frontend: `src/components/WorkspaceSidebar/` and
`src/components/WorkspaceEditor/`.

#### shared-rust-core.md

Fully implemented. The `termihub-core` crate (`core/`) is production-ready and used by both
the desktop app (`src-tauri/`) and the remote agent (`agent/`). It provides the shared buffer
(RingBuffer), config types, error types, file backend trait, monitoring parsers, output coalescer,
protocol types, and session transport traits.

#### ssh-tunneling.md (Issue #107)

Fully implemented. All three forwarding types (`local_forward.rs`, `remote_forward.rs`,
`dynamic_forward.rs` with SOCKS5), SSH session pooling, tunnel manager with CRUD/start/stop/
auto-start/status tracking, and `tunnels.json` persistence. Frontend: `TunnelSidebar`,
`TunnelEditor`, `TunnelDiagram`, activity bar integration. Auto-start on launch and graceful
shutdown on close are both implemented.

#### tab-groups.md (Issue #546)

Fully implemented. `tabGroups: TabGroup[]` is the core of the Zustand store. `TabGroupChips.tsx`
renders the group selector. Users can add, rename, remove, and switch between named tab groups;
each group has an independent panel tree that stays alive when hidden.

#### workspace-tab-groups.md (Issue #566)

Fully implemented. `WorkspaceDefinition` (in `src/types/workspace.ts`) has a `tabGroups:
WorkspaceTabGroupDef[]` field. Saving a workspace captures all named tab groups; restoring it
recreates them. Backward-compatible with single-layout workspace files (the `layout` field is
optional when `tabGroups` is present).

---

### Partially Implemented

Each of these has an **Implementation Status** section at the bottom of the concept document
that lists what exists and what is still missing.

#### comprehensive-test-infrastructure.md (Issue #377)

Partially implemented. The 13-container Docker Compose setup and pre-generated SSH test keys
are in place. The per-machine capability-detection orchestration scripts, network fault injection
test cases, SFTP stress test cases, and jump-host chain tests are not yet written.

#### persistent-connection-ux.md (Issue #666)

Not implemented (concept written, feature not built). The `persistent: boolean` field exists in
connection config and workspace layouts. The Start / Attach / Stop lifecycle mechanics, sidebar
persistence badge, connection state tracking in the store, and the IPC commands for
`connection.start()` / `connection.attach()` / `connection.stop()` do not exist.

#### session-auto-save.md (Issue #527)

Not implemented. The concept issue is closed; active implementation issue:
[#586 — persist open tabs and restore last session on startup](https://github.com/armaxri/termiHub/issues/586).
The workspace system is the correct foundation — a "last session" snapshot is essentially an
auto-saved, unnamed workspace. The session history sidebar, quick-connect bar, and history
deduplication are further out.

#### terminal-syntax-highlighting.md (Issue #522)

Not implemented (xterm.js terminal output highlighting). Monaco/Shiki syntax highlighting for
the **file editor** exists and is unrelated. The xterm.js output highlighting engine, ANSI
decoration injection, built-in rule set, and per-connection settings panel do not exist.

#### unified-test-system.md (Issue #390)

Not implemented as a unified system. The concept recommended a hybrid approach (YAML registry +
dual execution backends). The YAML manual test files and Python runner were built
(see guided-manual-testing.md). The WebdriverIO ↔ YAML bridge, shared test inventory, and
test coverage gap analysis were not.

#### webdriverio-unified-testing.md

Not implemented. WebdriverIO E2E tests and the Python/YAML guided runner remain two separate
systems. The `@automated`/`@guided`/`@visual` tag system, `runGuided()` helper, and unified
`wdio.guided.conf.ts` do not exist.

---

### Not Implemented — Planned Future Features

These concepts are well-defined designs for features not yet started.

#### broadcast-input.md (Issue #516)

Not implemented. Architecture designed — input mirroring across multiple terminals via a shared
broadcast channel. No `BroadcastState` in the store, no broadcast toolbar, no xterm.js input
routing.

#### embedded-unix-windows.md (Issue #519)

Not implemented. No BusyBox-w32 bundle, no standalone Unix tools, no isolated PATH management
for Windows builds.

#### ftp-client.md (Issue #518)

Not implemented. FTP client sessions (distinct from the embedded FTP server in
`embedded-network-daemons`) have no backend in `core/src/backends/`.

#### macro-recording.md (Issue #517)

Not implemented. No macro engine, recording UI, or playback system.

#### package-manager.md (Issue #521)

Not implemented. Builds on the plugin system concept (also not implemented). No repository
format, dependency resolution, tool installer, or plugin manager UI.

#### ssh-jump-host.md (Issue #520)

Not implemented. `SshConfig` in `core/src/config/` has no `jump_host` / `proxy_jump` field.
No ProxyJump chain support in the SSH backend or connection editor.

---

### Not Implemented — Legacy / Protocol Concepts

#### rlogin-rsh.md (Issue #523)

Not implemented. Legacy BSD protocols (rlogin, rsh). Low priority given SSH ubiquity;
no backend in `core/src/backends/`.

---

### Not Implemented — Remote Desktop Concepts

These are long-horizon or technically complex features; treat as future vision.

#### rdp-sessions.md (Issue #513)

Not implemented. Requires native RDP client library integration or FreeRDP binding. No code
exists.

#### vnc-sessions.md (Issue #514)

Not implemented. Design uses noVNC (JavaScript VNC client) with a Rust WebSocket-to-TCP proxy.
No code exists.

#### xdmcp-sessions.md (Issue #515)

Not implemented. Requires X11 / XDMCP protocol handling. No code exists. Most realistic
path would be embedding an X11 server — very high complexity.

---

### Not Implemented — Credential / Security Concepts

#### credential-encryption.md (Issue #25)

Active implementation tickets. The concept is closed and has spawned open implementation
tickets: #249 (replace `strip_ssh_password` with `prepare_for_storage`), #253 (frontend
credential store API, events, Zustand state), #255 ("Save password" checkbox in Connection
Editor), #258 (integrate credential store into connection/reconnection flow), #259 (plaintext
migration wizard), #262 (route external file credentials through `CredentialStore`), #263
(auto-lock timeout).

#### ssh-key-passphrase.md (Issue #121)

Active implementation tickets. Tightly coupled with credential-encryption work. Open tickets:
# 249, #255, #258, #259 (shared with credential-encryption concept).

---

### Not Implemented — Older / Infrastructure Concepts

#### cross-platform-testing.md (Issue #15)

Not implemented. No platform-specific test modules, no `XPLAT-*` identifiers, no
`needs-platform-testing` labels. CI runs a 3-platform matrix but without the explicit
platform-divergent testing this concept proposes. No follow-up issues were created.

#### plugin-system.md (Issue #28)

Not implemented. No `PluginManager`, `PluginRegistry`, or `PluginManifest` in Rust; no
`src/types/plugin.ts`; no `src/components/Plugins/`; no `libloading` dependency; no
`window.termihub` frontend API; no `.termihub-plugin` package format. The most ambitious
concept (7 planned PRs) — no follow-up implementation issues exist.

#### light-color-theme.md (Issue #193)

Partially implemented. Core theme engine done (PR #223): `ThemeEngine` with Dark/Light/System
themes, CSS variable refactoring, xterm.js live re-theming, Appearance settings panel. Missing:
`ThemeEditor` component, `customThemes` on `AppSettings`, theme import/export. No follow-up
issue for the remaining custom-theme work.
