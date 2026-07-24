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

## Concept form

Every concept is a **single self-contained HTML file** (`<name>.html`), living in one of the status
directories above. One file holds everything: prose (the standard concept sections), Mermaid
diagrams (rendered client-side), any mockups (inline, using the real app class names), and the
concept↔code reconciliation ledger (`<section id="sync">`). Open it in a browser to review it — it
does not render on github.com, which shows the raw source.

Concepts without a visual surface simply carry prose and Mermaid diagrams and omit the mockups; the
container and styling are the same. (Earlier concepts used a plain `.md` form for non-visual
features — those have all been converted to the single-file HTML form.)

The HTML form is part of the **AI-driven concept workflow** — a design-first artifact that doubles
as Claude Code's implementation target, reconciled via the `/sync-concept <name>` skill where the
**concept is the source of truth**. See
[`implemented/ai-driven-concept-workflow.html`](implemented/ai-driven-concept-workflow.html) for the full
design, [`_assets/`](_assets/) for the shared kit (`concept-template.html`, `concept.css`,
`mockup.css`, `mermaid.min.js`), and [`mockups-index.html`](mockups-index.html) for a browsable
gallery. [`implemented/x-server-provisioning.html`](implemented/x-server-provisioning.html) is the worked
example.

> **Folder form fully retired.** Every concept is now a single-file HTML concept. The old folder
> form (`<name>/` with `concept.md` + `behavior.md` + `mockups/*.html` + `sync.md`) is no longer
> used anywhere.

---

## implemented/

All features in this folder are live in the codebase.

| Document                                                                                           | Summary                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [agent.html](implemented/agent.html)                                                               | Remote agent JSON-RPC protocol, daemon, shell/Docker/SSH/serial backends, file browsing, monitoring, state persistence                                               |
| [agent-settings-separation.html](implemented/agent-settings-separation.html)                       | Connection editor "Agent" tab separating transport from runtime settings (`AgentSettingsForm`)                                                                       |
| [customize-layout.html](implemented/customize-layout.html)                                         | "Customize Layout…" dialog with presets and live preview                                                                                                             |
| [embedded-network-daemons.html](implemented/embedded-network-daemons.html)                         | Embedded HTTP, FTP, and TFTP servers with lifecycle management                                                                                                       |
| [guided-manual-testing.html](implemented/guided-manual-testing.html)                               | YAML test definitions in `tests/manual/` + interactive Python runner `scripts/test-manual.py`                                                                        |
| [key-combinations.html](implemented/key-combinations.html)                                         | Platform-aware keybinding editor with per-action customization and reset-to-defaults                                                                                 |
| [keyboard-cheatsheet-export.html](implemented/keyboard-cheatsheet-export.html)                     | "Export Cheat Sheet…" button generates a self-contained HTML shortcut reference                                                                                      |
| [network-utilities.html](implemented/network-utilities.html)                                       | Ping, traceroute, port scanner, DNS lookup, HTTP monitor, Wake-on-LAN sidebar panels                                                                                 |
| [nicer-settings.html](implemented/nicer-settings.html)                                             | Two-panel settings layout with category sidebar, search, and debounced auto-save                                                                                     |
| [portable-mode.html](implemented/portable-mode.html)                                               | `portable.marker` detection redirects all config to an adjacent `data/` directory                                                                                    |
| [prepared-connection-setup.html](implemented/prepared-connection-setup.html)                       | Workspace system — save/restore named layouts with pre-configured connections                                                                                        |
| [shared-rust-core.html](implemented/shared-rust-core.html)                                         | `termihub-core` crate shared between desktop and remote agent                                                                                                        |
| [ssh-tunneling.html](implemented/ssh-tunneling.html)                                               | Local, remote, and SOCKS5 dynamic SSH tunnels with sidebar UI and auto-start                                                                                         |
| [tab-groups.html](implemented/tab-groups.html)                                                     | Named tab groups — independent panel trees that stay alive when hidden                                                                                               |
| [workspace-tab-groups.html](implemented/workspace-tab-groups.html)                                 | Workspace definitions capture and restore multiple tab groups                                                                                                        |
| [ai-driven-concept-workflow.html](implemented/ai-driven-concept-workflow.html)                     | Single-file HTML concept workflow — mockup kit, `/sync-concept` skill, screenshot + gallery tooling (in active use)                                                  |
| [cross-platform-testing.html](implemented/cross-platform-testing.html)                             | CI test matrix runs across macOS, Linux, and Windows                                                                                                                 |
| [remote-agent-lifecycle-redesign.html](implemented/remote-agent-lifecycle-redesign.html)           | Remote-agent lifecycle state machine — cancellation registry + single-writer fixes (#1131/#1142)                                                                     |
| [remote-monitoring-lifecycle-redesign.html](implemented/remote-monitoring-lifecycle-redesign.html) | Remote system-monitoring state machine — per-host keyed monitors, retired legacy pull path (#1137)                                                                   |
| [sftp-session-and-transfers.html](implemented/sftp-session-and-transfers.html)                     | SFTP session/transfer lifecycle — keyed session map, `close_all`, cancellable transfers (#1132/#1143/#1192)                                                          |
| [ssh-jump-host.html](implemented/ssh-jump-host.html)                                               | First-class ProxyJump / gateway chains in the connection editor                                                                                                      |
| [ssh-tunnel-lifecycle-redesign.html](implemented/ssh-tunnel-lifecycle-redesign.html)               | SSH tunnel supervisor — native session-liveness watch, Connected→Error, reconnect (#1191/#1243/#1297)                                                                |
| [x-server-provisioning.html](implemented/x-server-provisioning.html)                               | Local X server for SSH X11 forwarding — VcXsrv via winget (Win), XQuartz via Homebrew (mac), detect-and-guide (Linux) (#1047)                                        |
| [ftp-client.html](implemented/ftp-client.html)                                                     | FTP/FTPS backend, listing parsers, file-browser CRUD, shared Transfer Queue, insecure-FTP warning, terminal-less tab (epic #1331, #1335)                             |
| [shell-context-menu-integration.html](implemented/shell-context-menu-integration.html)             | Spawn core (IPC + `termiHub spawn` CLI), external-trigger open + focus, per-OS registration, settings panel, Docker/Podman spawn, in-app Session Picker (epic #1363) |
| [elevated-sftp-editing.html](implemented/elevated-sftp-editing.html)                               | Early read-only detection, elevated (sudo) SFTP save via exec channel, `SudoPassword` credential, `SudoPromptDialog` (epic #1323)                                    |
| [remote-agent-update-strategy.html](implemented/remote-agent-update-strategy.html)                 | Coordinated agent updates — update RPCs, version badge/banner, update dialog, deferred-update daemon, SHA-256 integrity (epic #1345)                                 |
| [macro-recording.html](implemented/macro-recording.html)                                           | Record and replay terminal input — storage, recording, playback timing modes, manager panel, import/export (epic #1670)                                              |
| [workflow-automation.html](implemented/workflow-automation.html)                                   | Authored multi-step workflows on macros — typed steps, manual/on-connect/hotkey triggers, import/export, run-local-process (epic #1851)                              |
| [remote-desktop-sessions.html](implemented/remote-desktop-sessions.html)                           | Unified graphical remote-desktop — VNC + RDP behind one shared layer (Rust-side decode), trust store, clipboard/audio (epic #1678)                                   |
| [context-aware-keyboard-shortcuts.html](implemented/context-aware-keyboard-shortcuts.html)         | Context-aware keybinding routing — per-scope shortcut dispatch, editor delegation, scope shown in the shortcuts overlay (#787)                                       |
| [terminal-syntax-highlighting.html](implemented/terminal-syntax-highlighting.html)                 | Terminal output syntax highlighting — engine, rules registry, custom-rule editor, per-connection override, status-bar toggle (epic #1696)                            |
| [git-bash-provisioning.html](implemented/git-bash-provisioning.html)                               | Detect Git for Windows and guide its install; Git Bash as the Windows Unix-tools provider (#1671/#1672) — auto-install UI descoped to guided-terminal path           |
| [ssh-key-passphrase.html](implemented/ssh-key-passphrase.html)                                     | SSH key passphrase handling — encryption detection (#885), connect-time `PasswordPrompt`, secrets in the credential store (not plaintext), `CredentialType::KeyPassphrase` (#121)  |

---

## partial/

These features have something built, but there are meaningful gaps. See the
**## Implementation Status** section at the bottom of each document for details.

| Document                                                                                 | What exists                                                                                                     | What is missing                                                                                                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [comprehensive-test-infrastructure.html](partial/comprehensive-test-infrastructure.html) | 13-container Docker Compose setup, pre-generated SSH keys                                                       | Network fault tests, SFTP stress tests, jump-host chain tests                                                                              |
| [credential-encryption.html](partial/credential-encryption.html)                         | `CredentialStore` Rust backend, master password, keychain integration                                           | Frontend API (store, events, UI), connection-flow integration, migration wizard — tracked in issues #249 #253 #255 #258 #259 #262 #263     |
| [in-field-update-mechanism.html](partial/in-field-update-mechanism.html)                 | Version detection infrastructure                                                                                | Update notification UI, download-and-prompt, auto-install                                                                                  |
| [light-color-theme.html](partial/light-color-theme.html)                                 | Dark/Light/System theme engine, CSS variables, xterm.js re-theming                                              | Custom theme editor, `customThemes` settings field, theme import/export                                                                    |
| [persistent-connection-ux.html](partial/persistent-connection-ux.html)                   | `persistent: boolean` field in connection config                                                                | Start/Attach/Stop mechanics, sidebar status badge, IPC commands                                                                            |
| [session-auto-save.html](partial/session-auto-save.html)                                 | Workspace system (manual save/restore)                                                                          | Auto-snapshot on close, restore-on-startup — tracked in issue #586                                                                         |
| [ui-modernization.html](partial/ui-modernization.html)                                   | Shared token'd primitives (`src/components/ui/`), toast hub, tokens — foundation shipped (#1059–#1063)          | Roadmap phase 4: converting the ~33 dialogs/forms onto the primitives + motion still in progress (#1062)                                   |
| [confirm-dialog-primitive.html](partial/confirm-dialog-primitive.html)                   | `ConfirmDialog` primitive in `src/components/ui/` with a `ConfirmDontAskAgain` opt-out, used by several dialogs | Named call sites (ConfirmDeleteDialog, Port Scanner, WoL) still on raw `Modal`; Port Scanner large-scan "don't warn again" unbuilt (#1391) |

---

## backlog/

Not started yet — realistic and planned for the near to medium term.

| Document                                                                                                   | Summary                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [app-icons.html](backlog/app-icons.html)                                                                   | Custom application icon design — a custom icon already ships, but not the concept's design; app-icon direction is an open maintainer call (UI-icon family still unbuilt) |
| [broadcast-input.html](backlog/broadcast-input.html)                                                       | Synchronised input across multiple terminals simultaneously                                  |
| [macos-code-signing-notarization.html](backlog/macos-code-signing-notarization.html)                       | Developer-ID signing + notarization for the macOS build (only ad-hoc signing today)          |
| [multi-window.html](backlog/multi-window.html)                                                             | Tear tabs out into additional native windows                                                 |
| [release-planning-and-dependency-management.html](backlog/release-planning-and-dependency-management.html) | Structured release cadence, Dependabot, hotfix branching                                     |

---

## future/

Speculative features, long-horizon research, or low-priority legacy protocols.
These may eventually be implemented, but there is no active plan.

| Document                                                                    | Summary                                                  | Why future                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [package-manager.html](future/package-manager.html)                         | Plugin/tool repository with dependency resolution        | Blocked on plugin system                                                          |
| [plugin-system.html](future/plugin-system.html)                             | Dynamic extension API (Rust + JS)                        | Very high complexity, no active demand                                            |
| [remote-client-mode.html](future/remote-client-mode.html)                   | termiHub as a browser/iPad app via WebSocket             | Significant architectural change                                                  |
| [rlogin-rsh.html](future/rlogin-rsh.html)                                   | Legacy BSD rlogin/rsh protocol support                   | Superseded by SSH; rarely needed                                                  |
| [unified-test-system.html](future/unified-test-system.html)                 | Analysis: unify WebdriverIO E2E + YAML manual runner     | Premise (WebdriverIO/tauri-driver) retired by #1027; superseded by Python harness |
| [webdriverio-unified-testing.html](future/webdriverio-unified-testing.html) | All tests in one WebdriverIO/tauri-driver infrastructure | WebdriverIO/tauri-driver stack retired by #1027; superseded by Python harness     |
