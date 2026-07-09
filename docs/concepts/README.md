# Concept Documents

Design documents are sorted into four folders based on **implementation status**, not issue status.

| Folder                         | Meaning                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| [`implemented/`](implemented/) | Feature is fully built and working                               |
| [`partial/`](partial/)         | Work started — something exists, but meaningful gaps remain      |
| [`backlog/`](backlog/)         | Not started yet — realistic and planned for the near/medium term |
| [`future/`](future/)           | Speculative, long-horizon, or may never happen                   |

Each partially implemented concept has an **## Implementation Status** section at the bottom
of its document that lists exactly what exists and what is still missing.

## Concept forms

A concept is either a single `.md` file or a single **HTML** file — chosen by whether it has a
visual surface. Both live in the same status directories.

- **Markdown** (`<name>.md`) — the default for features with **no** visual surface. Prose + inline
  Mermaid diagrams.
- **Single-file HTML** (`<name>.html`) — used when a concept has a **visual surface worth mocking
  up**. One self-contained file holds everything: prose, Mermaid diagrams (rendered client-side),
  the mockups (inline, using the real app class names), and the concept↔code reconciliation ledger
  (`<section id="sync">`). Open it in a browser to review it — it does not render on github.com.

The HTML form is part of the **AI-driven concept workflow** — a design-first artifact that doubles
as Claude Code's implementation target, reconciled via the `/sync-concept <name>` skill where the
**concept is the source of truth**. See
[`backlog/ai-driven-concept-workflow.md`](backlog/ai-driven-concept-workflow.md) for the full
design, [`_assets/`](_assets/) for the shared kit (`concept-template.html`, `concept.css`,
`mockup.css`, `mermaid.min.js`), and [`mockups-index.html`](mockups-index.html) for a browsable
gallery. [`backlog/x-server-provisioning.html`](backlog/x-server-provisioning.html) is the worked
example.

> **Folder form fully retired.** Every concept with a visual surface is now a single-file HTML
> concept. The old folder form (`<name>/` with `concept.md` + `behavior.md` + `mockups/*.html` +
> `sync.md`) is no longer used anywhere.

---

## implemented/

All features in this folder are live in the codebase.

| Document                                                                   | Summary                                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [agent.md](implemented/agent.md)                                           | Remote agent JSON-RPC protocol, daemon, shell/Docker/SSH/serial backends, file browsing, monitoring, state persistence |
| [agent-settings-separation.md](implemented/agent-settings-separation.md)   | Connection editor "Agent" tab separating transport from runtime settings (`AgentSettingsForm`)                         |
| [customize-layout.md](implemented/customize-layout.md)                     | "Customize Layout…" dialog with presets and live preview                                                               |
| [embedded-network-daemons.md](implemented/embedded-network-daemons.md)     | Embedded HTTP, FTP, and TFTP servers with lifecycle management                                                         |
| [guided-manual-testing.md](implemented/guided-manual-testing.md)           | YAML test definitions in `tests/manual/` + interactive Python runner `scripts/test-manual.py`                          |
| [key-combinations.md](implemented/key-combinations.md)                     | Platform-aware keybinding editor with per-action customization and reset-to-defaults                                   |
| [keyboard-cheatsheet-export.md](implemented/keyboard-cheatsheet-export.md) | "Export Cheat Sheet…" button generates a self-contained HTML shortcut reference                                        |
| [network-utilities.md](implemented/network-utilities.md)                   | Ping, traceroute, port scanner, DNS lookup, HTTP monitor, Wake-on-LAN sidebar panels                                   |
| [nicer-settings.md](implemented/nicer-settings.md)                         | Two-panel settings layout with category sidebar, search, and debounced auto-save                                       |
| [portable-mode.md](implemented/portable-mode.md)                           | `portable.marker` detection redirects all config to an adjacent `data/` directory                                      |
| [prepared-connection-setup.md](implemented/prepared-connection-setup.md)   | Workspace system — save/restore named layouts with pre-configured connections                                          |
| [shared-rust-core.md](implemented/shared-rust-core.md)                     | `termihub-core` crate shared between desktop and remote agent                                                          |
| [ssh-tunneling.md](implemented/ssh-tunneling.md)                           | Local, remote, and SOCKS5 dynamic SSH tunnels with sidebar UI and auto-start                                           |
| [tab-groups.md](implemented/tab-groups.md)                                 | Named tab groups — independent panel trees that stay alive when hidden                                                 |
| [workspace-tab-groups.md](implemented/workspace-tab-groups.md)             | Workspace definitions capture and restore multiple tab groups                                                          |

---

## partial/

These features have something built, but there are meaningful gaps. See the
**## Implementation Status** section at the bottom of each document for details.

| Document                                                                             | What exists                                                           | What is missing                                                                                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [comprehensive-test-infrastructure.md](partial/comprehensive-test-infrastructure.md) | 13-container Docker Compose setup, pre-generated SSH keys             | Network fault tests, SFTP stress tests, jump-host chain tests                                                                          |
| [credential-encryption.md](partial/credential-encryption.md)                         | `CredentialStore` Rust backend, master password, keychain integration | Frontend API (store, events, UI), connection-flow integration, migration wizard — tracked in issues #249 #253 #255 #258 #259 #262 #263 |
| [in-field-update-mechanism.md](partial/in-field-update-mechanism.md)                 | Version detection infrastructure                                      | Update notification UI, download-and-prompt, auto-install                                                                              |
| [light-color-theme.md](partial/light-color-theme.md)                                 | Dark/Light/System theme engine, CSS variables, xterm.js re-theming    | Custom theme editor, `customThemes` settings field, theme import/export                                                                |
| [persistent-connection-ux.md](partial/persistent-connection-ux.md)                   | `persistent: boolean` field in connection config                      | Start/Attach/Stop mechanics, sidebar status badge, IPC commands                                                                        |
| [session-auto-save.md](partial/session-auto-save.md)                                 | Workspace system (manual save/restore)                                | Auto-snapshot on close, restore-on-startup — tracked in issue #586                                                                     |
| [ssh-key-passphrase.md](partial/ssh-key-passphrase.md)                               | SSH key loading and `strip_ssh_password`                              | Passphrase storage in credential store — tracked in issues #249 #255 #258 #259                                                         |
| [terminal-syntax-highlighting.md](partial/terminal-syntax-highlighting.md)           | Monaco/Shiki highlighting for the file editor                         | xterm.js terminal output highlighting engine                                                                                           |
| [unified-test-system.md](partial/unified-test-system.md)                             | WebdriverIO E2E tests + YAML manual runner (separate systems)         | Shared test inventory, WebdriverIO ↔ YAML bridge                                                                                       |
| [webdriverio-unified-testing.md](partial/webdriverio-unified-testing.md)             | WebdriverIO E2E tests                                                 | `@guided`/`@automated` tag system, guided-mode runner                                                                                  |

---

## backlog/

Not started yet — realistic and planned for the near to medium term.

| Document                                                                                               | Summary                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [ai-driven-concept-workflow.md](backlog/ai-driven-concept-workflow.md)                                 | Design-first loop — per-concept mockups + diagrams as source of truth, human-triggered `/sync-concept` |
| [app-icons.md](backlog/app-icons.md)                                                                   | Custom application icon design — placeholder Tauri icons are in place, not the designed ones           |
| [broadcast-input.html](backlog/broadcast-input.html)                                                   | Synchronised input across multiple terminals simultaneously                                            |
| [cross-platform-testing.md](backlog/cross-platform-testing.md)                                         | Platform-divergent test modules and `XPLAT-*` identifiers for CI                                       |
| [embedded-unix-windows.html](backlog/embedded-unix-windows.html)                                       | Bundle BusyBox-w32 + Unix tools with the Windows build                                                 |
| [ftp-client.html](backlog/ftp-client.html)                                                             | FTP client sessions (distinct from the embedded FTP server)                                            |
| [macro-recording.html](backlog/macro-recording.html)                                                   | Record and replay terminal input sequences                                                             |
| [release-planning-and-dependency-management.md](backlog/release-planning-and-dependency-management.md) | Structured release cadence, Dependabot, hotfix branching                                               |
| [remote-agent-update-strategy.html](backlog/remote-agent-update-strategy.html)                         | Deliver updated agent binaries to remote hosts                                                         |
| [shell-context-menu-integration.html](backlog/shell-context-menu-integration.html)                     | OS "Open in termiHub" context menu + `termiHub spawn` CLI                                              |
| [ssh-jump-host.html](backlog/ssh-jump-host.html)                                                       | First-class ProxyJump / gateway chains in the connection editor                                        |

---

## future/

Speculative features, long-horizon research, or low-priority legacy protocols.
These may eventually be implemented, but there is no active plan.

| Document                                                  | Summary                                           | Why future                                          |
| --------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| [package-manager.html](future/package-manager.html)       | Plugin/tool repository with dependency resolution | Blocked on plugin system                            |
| [plugin-system.html](future/plugin-system.html)           | Dynamic extension API (Rust + JS)                 | Very high complexity, no active demand              |
| [rdp-sessions.html](future/rdp-sessions.html)             | Embedded RDP client sessions                      | Requires native RDP library or FreeRDP binding      |
| [remote-client-mode.html](future/remote-client-mode.html) | termiHub as a browser/iPad app via WebSocket      | Significant architectural change                    |
| [rlogin-rsh.md](future/rlogin-rsh.md)                     | Legacy BSD rlogin/rsh protocol support            | Superseded by SSH; rarely needed                    |
| [vnc-sessions.html](future/vnc-sessions.html)             | Embedded noVNC client with WebSocket-to-TCP proxy | High complexity, niche use case                     |
| [xdmcp-sessions.md](future/xdmcp-sessions.md)             | XDMCP remote desktop sessions                     | Requires X11 server embedding; very high complexity |
