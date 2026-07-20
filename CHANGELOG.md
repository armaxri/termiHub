# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!--
  Do NOT add entries here on a develop-targeted branch. Record user-facing changes in a
  per-branch fragment under docs/changes/<branch-name>.md instead — see docs/changes/README.md.
  Fragments are consolidated into this section at release time. Only hotfix branches cut
  directly from a main tag edit this file directly.
-->

## [0.1.0] - 2026-07-20

First public beta release of termiHub — a cross-platform terminal hub for local shells, SSH (with ProxyJump/jump-host support), serial, telnet, Docker, SFTP/FTP file transfer, embedded servers, network diagnostics, and remote-desktop (VNC/RDP) connections, unified in one workspace.

### Added

- Testing: **ported the Windows-shells & WSL infrastructure suite to the Python bridge harness** (#975, part of #814 / #803, epic #799). The old `tests/e2e/infrastructure/windows-shells.test.js` (MT-LOCAL-02/04/06/11..20) could only assert that the `.xterm` element existed — it could not read the GPU canvas — so most of its cases degenerated into "a terminal opened". The new `tests/system/tests/test_windows_shells.py` reads the reconstructed terminal buffer and asserts the **actual** behaviour: a selected shell spawns, accepts input, and echoes a marker (PowerShell / cmd.exe), the Local editor's shell dropdown defaults to PowerShell and offers the Windows shells, rapidly-created shells each accept input, the toolbar opens the default shell, and the local file browser follows a Windows shell's cwd. A second class drives **WSL** through the dedicated, Windows-only `wsl` connection type (the codebase moved WSL out of the Local shell dropdown into its own type with a `field-distribution` selector): launch + POSIX input, no `clear: command not found` startup error, the file browser's WSL initial path, cwd-following on `cd`, and `/mnt/<drive>` → native Windows-path translation. The whole module is **Windows-only** (the inverse of `test_cross_platform.py`'s skip), and the WSL cases skip cleanly when no WSL2 distribution is installed — gated by a new pure `parse_wsl_distros` helper (mirrors the backend's `parse_wsl_output`, unit-tested in `test_wsl_detect.py`) over `wsl.exe --list --quiet`. New `ConnectionsUi` helpers back the suite: a `shell=` argument + `select_shell` on `create_local_connection`, and `open_wsl_editor` / `create_wsl_connection`. The original WebdriverIO spec is removed and [docs/testing.md](docs/testing.md)'s coverage map points at the new home. (Closes #975)

- Testing: **guided-manual visual follow-ups — startup/connect white-flash, terminal black bar & OS app icon** (#1003, follow-up to #915 / PR #943, part of epic #913). The deferred timing- and OS-level visual items were added to `tests/system/tests/test_visual_rendering.py`: **MT-UI-01** (no white flash on a cold app start — the harness does a real kill-and-relaunch via `restart_app`, operator confirms the dark `#1e1e1e` background is already painted), **MT-LOCAL-05** (no setup-command flash on SSH connect — the harness drives the full password-SSH connect via `connect_ssh_password`, operator confirms the remote prompt appears cleanly; needs the Docker `ssh_fixtures`, skips without a container runtime), **MT-UI-16** (no black bar at the bottom of the terminal pane — harness opens a terminal and prints a line, operator checks the bottom edge), and **MT-UI-19** (the OS dock/taskbar/launcher app icon — harness ensures the app is running, operator confirms the custom termiHub icon). Each is a paint-timing / OS-chrome artefact the DOM/store bridge cannot assert, so all stay operator-confirmed, but the harness automates everything around the look (relaunch, connect, terminal, screen). Marked `manual` + `integration`, so they skip on CI and run under `./pytest.sh --manual -k visual -s`. [docs/testing.md](docs/testing.md) (Closes #1003)

- Testing: **guided-manual native-dialog follow-ups** (#1004, the items deferred from #916 / delivered alongside the #931 suite). `tests/system/tests/test_native_dialogs.py` gains the four remaining native-OS-dialog flows that the in-webview bridge cannot drive: **encrypted export+import round-trip** (MT-CONN-12..16) — the harness sets up a master-password store, saves an SSH password into it, exports **with credentials** (typing the export password) and imports the same file back, asserting the import dialog reports the credential imported, so the real Argon2id + AES-256-GCM round-trip is exercised rather than re-implemented in a fixture; **Open in Editor → Save As + the unsaved-changes warning** (MT-TAB-17/18/19) — captures terminal scrollback into a scratch editor, asserts the Unsaved badge, Save As writes the buffer and clears the dirty state, and a second unsaved capture's close raises the unsaved-changes dialog (Cancel keeps / Just Close discards); **portable config export to a directory** (MT-PORT-04) — drives Settings → Portable Mode export + the migration Copy dialog and asserts the files land in the chosen directory; and **add external connection file** (MT-CONN-23) — registers an external-store JSON fixture and asserts it appears in settings and its connection loads. Following the guided-manual contract, the harness automates every bridge-drivable half and asserts the in-app outcome (imported credential, saved-file content, copied config files, registered external file); the operator performs **only** the native file pick / save. Two `data-testid`s were added — `external-files-add` (the External Files "Add File" button) and `import-dialog-success` (the import-result message). Marked `manual` + `integration`, so they skip on CI / normal runs and run under `./pytest.sh --manual -k native_dialog -s`. [docs/testing.md](docs/testing.md) (Closes #1004)

- Testing: **ported the remote-agent infrastructure E2E suite to the Python bridge harness** (#974, part of #803 / epic #799). The exercisable cases from `infrastructure/remote-agent.test.js` now live in `tests/system/tests/test_remote_agent.py` (driven by a new `AgentUi` harness mixin): creating a remote-agent definition via the experimental **New Remote Agent** button, the connection-error feedback dialog a failed connect raises (unreachable host, wrong password, host with no agent binary — each waited-for and dismissed, not the old vacuous `if exists` checks), and the agent-setup wizard reaching its form after SSH arch-detection. All run against the existing password-SSH container (port 2201) + an unreachable local port. The old suite created agents via a removed "remote" connection-editor type; the port uses the current dedicated create button and finds agents in the `remoteAgents` store. Cases that need a deployed agent (successful connect + child sessions) are deferred to **#995**; the `agent-missing` "Setup Agent" button stays covered by the `classifyAgentError` / `ConnectionErrorDialog` unit tests (a no-agent host classifies as generic "Connection Failed"). The MT-AGENT-03/05/06/08 selector-string tautologies are dropped. The old WebdriverIO spec is removed. All 5 ported cases pass against the built app. (Closes #974)

- Credentials: **native OS credential store backend** (#956). A new **OS Keychain** credential-storage mode stores connection passwords and SSH key passphrases in the platform's native secret store — macOS **Keychain**, Windows **Credential Manager**, or Linux **Secret Service** — via the maintained [`keyring`](https://crates.io/crates/keyring) crate. It joins the existing **Master Password** (encrypted vault) and **None** modes in Settings → Security; selecting it requires no master password and is effectively always unlocked (the OS manages access). The status bar shows a static "Keychain" indicator while this mode is active. Entries are keyed by a fixed `termiHub` service name plus a `<connection-id>:<type>` account name. Switching _to_ OS Keychain migrates existing credentials; migration _out of_ it is not yet supported because the OS stores cannot be portably enumerated (deferred). (Closes #956)

- Testing: **guided-manual suite for input routing & drag-and-drop** (#920, part of the guided-manual epic #913). New `tests/system/tests/test_input_routing.py` covers the interactions that depend on the real OS input pipeline or on drop targets the synthetic bridge cannot reproduce: shell-conflict key pass-through (MT-KB-09/10/11 — Ctrl+W / Ctrl+\\ / tmux Ctrl+B), the pass-through toggle and context-aware Find routing (MT-KB-12/13/14), the terminal right-click context menu vs Quick Copy/Paste over the real clipboard (MT-UI-26..30), tab drag to a panel edge → split, drag across groups, and divider resize (MT-TAB-06/07/16), dragging a connection into a folder (MT-CONN-01/24), dragging an editor tab between panels (MT-FB-20), and an OS file drop onto a pane (MT-UI-34). Following the guided-manual contract, the harness automates all setup and asserts the resulting layout / store state, prompting the operator only for the irreducible gesture or clipboard/PTY effect. Two drivable `data-testid`s were added — `split-view-resize-handle` (the split divider) and `terminal-context-trigger-<tab>` (the terminal context-menu trigger). Marked `manual` + `integration`, so they skip on CI and run under `./pytest.sh --manual`. (Closes #920)

- SSH: **live per-hop status in the "Show Connection Path" popover** (#962). The popover (opened from a connection's context menu) previously showed the jump-host chain statically (`You → edge → bastion → target`). It now runs a live **probe** of the full path while open: each gateway hop and the target shows a status indicator that steps from pending → connecting (spinner) → connected (check) or failed (red X with the failure reason), and a broken hop is flagged while later nodes stay pending. The probe reuses the real per-hop connect primitives (`probe_connection_path` in core, mirroring the pooled connect path's first-hop-direct / channel-tunnelled-rest stepping) so it exercises the same reachability/auth the eventual session would, but opens no lasting session — it tears its connections down on completion, and closing the popover cancels an in-flight probe. (Closes #962)

- Testing: **ported the live Network Tools E2E cases to the Python bridge harness** (#946, part of #803 / epic #799). The live diagnostic cases from `network-tools-live.test.js` now live in `tests/system/tests/test_network_tools_live.py`, driving real network I/O and asserting on the streamed results via the result-row `data-testid`s added in #934: **MT-NET-10** (ping stats stream in + latency chart, then final Sent/Received summary on stop), **MT-NET-12** (port scan finds an open port + completion footer), **MT-NET-14** (DNS resolves `localhost` → `127.0.0.1`), **MT-NET-17** (HTTP monitor records a 200 check + response-time chart), and **MT-NET-18** (the running monitor appears in the sidebar Monitors section). Targets are kept local and deterministic with **no dependency on the Docker `network` profile** (following the embedded-services precedent #947/#964): ping/DNS hit loopback, the port scan targets a throwaway TCP listener the test opens, and the HTTP monitor targets a stdlib `http.server` the test starts. A new set of `NetworkToolsUi` live-flow helpers (`start_ping`/`run_port_scan`/`run_dns_lookup`/`start_http_monitor` + stops) backs the suite. **MT-NET-13** (large-range warning) stays a manual carve-out — it is a native `window.confirm()` with no `data-testid`. Porting surfaced a real crash, fixed below (#982). The old WebdriverIO spec is removed and the `perf`/`infra` wdio suites updated. All 5 cases pass against the built app. (Closes #946)

- SSH: **deletion protection for connections used as a jump host** (#941). Deleting a saved SSH connection that other connections reference as a jump host (via `connectionId`, the #940 saved-reference mode) now warns first — "This connection is used as a jump host by N other connection(s): …" — and requires confirmation, since deleting it would silently break those connections' chains. Unreferenced connections still delete immediately. Bulk deletes are covered too (references _within_ the deleted set don't count). (Closes #941)

- Testing: **ported the performance suite (PERF-01..04) to the Python bridge harness** (#811, part of #803 / epic #799). The two WebdriverIO specs (`performance.test.js` + `performance-stress.test.js`) both validated termiHub's 40-concurrent-terminal design target; they are merged into one cross-platform `tests/system/tests/test_performance.py` that stands up 40 terminals once and reuses them: **PERF-01** creates 40 from empty and logs creation throughput, **PERF-02** asserts tab-switch latency to the first/middle/last tab (<2s each), **PERF-03** confirms terminal input still works with 40 open and the 41st opens promptly (<5s), and **PERF-04** tears them all down and logs cleanup timing. The suite waits on tab registration rather than fixed sleeps, so it is both faster and less flaky than the originals, and — running on the bridge instead of `tauri-driver` — it now runs on macOS too. A new reusable `TerminalUi.open_new_terminal` primitive backs it, and `TabsUi.close_all_tabs` now scales its drain loop to the tab count (the old fixed cap of 20 could not close 40). The Chromium-only JS-heap check (`performance.memory` via `browser.execute`) is dropped — the cross-platform bridge has no JS-eval/metrics verb, so it is surfaced back to #800. Both old WebdriverIO specs are removed and the `perf` wdio suite is emptied. (Closes #811)

- SSH: **a jump host can now reference a saved SSH connection** instead of inline configuration (#940). Each hop in the **Jump Host** editor gained a per-hop source toggle — **Saved connection** | **Inline configuration** — where "Saved connection" picks an existing SSH connection from a dropdown (listed by folder path, e.g. `Work / bastion`, excluding the connection being edited). The choice is stored as the hop's `connectionId`. At connect time the desktop layer expands every reference into the referenced connection's host/port/username/auth fields and its saved credential **before** the chain reaches core (which only connects with inline hops), reusing the shared gateway pool keyed on the saved connection. Resolution is recursive — a referenced connection's own jump-host chain becomes the outer hops — and rejects **circular references** (`A → B → A`, or a hop routing back through the connection being edited) both on save (editor validation) and at connect time. A reference to a missing/deleted or non-SSH connection is flagged on save; a referenced password-auth gateway with no saved password fails with a clear hop-named error. Resolution is applied on every SSH provider path (terminal, SFTP, monitoring, tunnels). Designed in #872 (concept `docs/concepts/backlog/ssh-jump-host/`). (Closes #940)

- Testing: **end-to-end integration test for a hung intermediate jump hop** (`SSH-JUMP-06` in `core/tests/ssh_advanced.rs`). Where the fast unit tests bound `run_hop_step` in isolation, this drives a real two-hop chain through the Docker bastion fixture where the second hop targets a black-holed address (`192.0.2.1`, RFC 5737 TEST-NET-1) — the bastion's `direct-tcpip` connect is silently dropped, so the channel-open never confirms. Asserts the connect aborts within the hop's per-hop `connectTimeoutSecs` budget (well under the multi-minute OS TCP timeout) and that the error names the offending hop, closing the integration-test gap left by #938/#951. Gated behind `require_docker!` like the other jump cases. (Closes #950)

- Testing: **ported the config-recovery E2E suite to the Python bridge harness, with real corruption injection** (part of #814 / #803, epic #799). The original `infrastructure/config-recovery.test.js` could neither restart the app nor touch its config files, so its `MT-RECOVERY-*` cases degenerated into "the app still loads" smoke checks. The new `tests/system/tests/test_config_recovery.py` (driven by a new `ConfigRecoveryUi` harness mixin) drives the real path: it corrupts a config file on disk in the app's isolated `TERMIHUB_CONFIG_DIR`, restarts, and asserts what startup recovery actually did — a fresh start writes the **v2 nested** `connections.json` (MT-RECOVERY-06); a **partially** corrupt connections file keeps the valid connections, drops the broken node, raises the `RecoveryDialog`, and writes a `.bak` (MT-RECOVERY-03/05); a **completely** corrupt connections file resets to empty with a warning + backup (MT-RECOVERY-02); and corrupt `settings.json` / `tunnels.json` reset to defaults, warn, and back up the original (MT-RECOVERY-01/04). The mixin adds a reusable stop → mutate-disk → restart → re-acquire-bridge primitive (`restart_with_config_change`). The non-recovery cases from the old spec (duplicate-name, credential migration, import/export, external-files) are already covered by `test_connection_crud.py` / `test_credential_store.py` / `test_export_import.py` / `test_external_files.py`, so they are dropped rather than duplicated. The old WebdriverIO spec is removed. Also retired the superseded `infrastructure/credential-store-infra.test.js` — its scenarios are a strict subset of the far more rigorous `test_credential_store.py` (#857); its one remaining gap (CRED-06: an unchecked "Save password" box re-prompts on reconnect) is added there. All 5 recovery cases + the 12-case credential suite pass against the built app. (#814)

- SSH: **a "Setup SSH Agent" button in the connection editor**. When an SSH connection uses the **agent** auth method, the editor now shows a dedicated _Setup SSH Agent_ button that opens a helper terminal to start the SSH agent and add your keys — so agent authentication can find them. Previously the helper handler existed but was dead-coded (no button called it); the only way to reach it was the _Setup Agent_ button that appeared in the connection-error dialog _after_ an agent-auth connection had already failed. The helper command is now cross-platform: PowerShell service elevation on Windows, `eval "$(ssh-agent -s)" && ssh-add` on macOS/Linux. (Closes #955)

- SSH: **per-hop connect timeout on each jump host**. Each bastion hop in a `ProxyJump` chain can now carry its own **Connect Timeout (s)**, so a slow bastion can be given a longer connect budget than a fast one. `JumpHostConfig` (core) gained an optional `connectTimeoutSecs` mirroring the target `SshConfig`'s field (#841), carried through `to_ssh_config` so `connect_gateway_chain` bounds each hop by its own value instead of always falling back to the default (20 s). The Jump Host editor's hop fields gained a per-hop **Connect Timeout (s)** input (empty = default). Previously only the final target's timeout was user-configurable; intermediate hops were stuck on the default (#938). (Closes #951)

- SSH: **a connecting session can now be cancelled mid-handshake**. Previously, starting a shell to a target behind a slow or blackholed bastion meant waiting out the per-hop connect timeout — the connect path ignored cancellation. A `CancellationToken` is now threaded end-to-end (`SshConnector::open_shell` → `connect_and_authenticate_cancellable` for direct connects and the now-cancellable pooled jump-host path, each hop bounded via #938's `run_hop_step`), driven by a new `ConnectionType::connect_cancellable`. The session manager registers a per-connect token (keyed by a caller-supplied `connect_id`) and exposes a `cancel_connecting` command; the frontend passes the tab id as the `connect_id`, so **closing or hitting Cancel on a still-connecting terminal now aborts the in-flight handshake promptly** instead of letting it run to completion. Connecting sessions are also surfaced in the **Open Connections** panel under a new "Connecting" section, each cancellable from there. (Closes #952)

- Testing: **ported the Embedded Services E2E suite (SVC-01..13)** from WebdriverIO to the Python bridge harness (#947, part of #803 / epic #799) — the largest remaining UI spec. A new `tests/system/tests/test_embedded_services.py` (driven by a new `EmbeddedServicesUi` harness mixin) covers the Services sidebar + New Service button & empty state, the create/cancel dialog, HTTP start/stop, the status-bar services indicator (show / reopen-sidebar / hide), edit pre-populate + rename persistence, duplicate, delete, FTP/TFTP lifecycle (badge + running), the File Browser **Share via HTTP** quick-share, and the bind-address dropdown + 0.0.0.0 LAN-security warning. The **live transfer** cases run a real client against the server the app starts on `127.0.0.1` (no Docker fixture needed): SVC-03 verifies an HTTP GET returns the file (stdlib `urllib`), and SVC-12/13 download over **FTP/TFTP via `curl`** (matching the original spec; skipped if `curl` lacks the protocol). Server _state_ is read from the Zustand store (`embeddedServers` / `embeddedServerStates`) rather than scraped from the status-dot class. All 17 ported cases pass against the built app. Porting surfaced a real bug — the HTTP server 404s direct file downloads when directory listing is on (filed as #961); the file-serving case turns listing off and the listing case asserts the directory index, so both paths are covered. The original `tests/e2e/embedded-services.test.js` is removed. (Closes #947)

- Testing: **extended the Embedded Services bridge suite with the FTP/TFTP quick-share and per-server context-menu actions** (#965, follow-up to #947). The port only exercised **Share via HTTP** (SVC-10) and drove servers through the inline action buttons. Added: **SVC-14/15** — the File Browser **Share via FTP** / **Share via TFTP** quick-share (`context-file-share-ftp` / `context-file-share-tftp`), mirroring the HTTP flow, plus **SVC-14b/15b** which drop a file into the shared folder and verify a **real transfer** against the running quick-share server on `127.0.0.1` (FTP via stdlib `ftplib`, TFTP via the maintained `tftpy` RRQ — reusing the `transfers.py` checkers added under #964, never a host-`curl` dependency); and **SVC-16..19** — the per-server right-click context menu (`EmbeddedServerItem`): start/stop (`ctx-start` / `ctx-stop`), delete (`ctx-delete`, restoring the empty state), Copy URL (`ctx-copy-url`, present and selectable), and Open-in-Browser shown for HTTP (`ctx-open-browser`) but **absent for non-HTTP**. New `EmbeddedServicesUi` context-menu helpers (`open_server_menu` / `ctx_start_server` / `ctx_stop_server` / `ctx_delete_server`) back the suite; all selectors already existed in the catalog. (Closes #965)

- Testing: **stable `data-testid`s on the Network Tools diagnostic results & controls** (#934), the prerequisite for porting the **live** Network Tools E2E cases (#946) to the Python bridge harness. Diagnostic results are DOM-only (component-local state fed by Tauri events), so the harness must assert on rendered rows/controls — which previously had no selectors. Added: Ping `ping-stop` / `ping-stats` / `ping-chart`; HTTP Monitor `http-monitor-stop` / `http-monitor-history` / `http-monitor-entry-*` / `http-monitor-chart`; the Monitors sidebar section `network-monitors-section`; and per-row / footer ids for the shared `DiagnosticResultsTable` via new `rowTestIdPrefix` / `footerTestId` props (Port Scanner → `port-scanner-result-*` / `port-scanner-footer`, DNS Lookup → `dns-result-*`). The catalog (`tests/system/testid-catalog.md`) is regenerated and the new shared-table prop logic is unit-tested (`DiagnosticResultsTable.test.tsx`). The Port Scanner's large-range warning stays a manual carve-out — it is a native `window.confirm()`, which cannot carry a `data-testid`. (#934)

- SSH: **the SFTP file browser and remote monitoring now work over a jump host.** Previously the ProxyJump chain was wired only into the terminal/shell connection, so for a jump-host connection the **file browser** and the **monitoring** panel tried to reach the bastion-only target directly and failed. Both now route through the connection's jump-host chain, reusing the **shared gateway session** (so a connection's shell, SFTP, and monitoring share one bastion connection instead of opening three). A new `connect_target` core helper centralizes the direct-vs-jump decision for every SSH provider. (Closes #939)

- Testing: **guided-manual tests for external-app & OS integration** (#917, part of epic #913) — the behaviours that hand off to another application or an OS service the in-webview bridge cannot reach, ported onto the guided-manual harness (#914). A new `tests/system/tests/test_external_app.py` covers **Open in VS Code** (local MT-FB-04/14, SFTP MT-FB-15, and the "not installed → menu item hidden" path MT-FB-16), **SSH agent auth** (connecting with the `agent` auth method MT-SSH-07, and the "Setup Agent" launcher in the connection-error dialog MT-SSH-09), **X11 forwarding** (enabling `enableX11Forwarding`, asserting the flag persists and the session connects, then confirming a remote X11 window appears — MT-SSH-14/15/16/18, MT-XPLAT-03), and **clipboard** copy/paste via the tab menu and the platform shortcuts (MT-KB-01..04). Each does all the automatable work — builds the connection/file/setting, triggers the action, and verifies the in-app side (the menu item exists, the X11 flag persisted, the session connects) — then asks the operator only to confirm the external result. Marked `manual` + `integration`, so they skip on CI/normal runs and run under `./pytest.sh --manual -k external_app -s`; the SSH/SFTP/X11/agent cases use the Docker SSH fixtures (skipped cleanly without a container runtime). **MT-CRED-01/02/03 (OS credential stores) are documented as not-applicable** — the app implements only `master_password` / `none` credential modes, with no native OS keychain backend, so there is nothing to verify in an OS store (the real saved-credential behaviour is covered by `test_credential_store.py`). [docs/testing.md](docs/testing.md) (#917)

- Build (CI): a new **Auto-Close Referenced Issues** workflow (`.github/workflows/auto-close-issues.yml`) closes `Closes #N` / `Fixes #N` / `Resolves #N` issues when their PR merges into **`develop`**. GitHub only auto-closes referenced issues on merges into the default branch (`main`), so day-to-day `develop`-targeted PRs left fixed issues lingering open — repeatedly causing already-done work to be re-investigated. On a merged `develop` PR the workflow parses the PR title/body for the standard closing keywords and closes each still-open issue with a comment linking the PR; PRs into `main` are untouched (GitHub handles those). The keyword parser is factored into `scripts/internal/parse-issue-refs.mjs` and unit-tested (`parse-issue-refs.test.mjs`). Documented in [docs/contributing.md](docs/contributing.md). (Closes #935)

- SSH: **first-class jump host (ProxyJump) support**. An SSH connection can now reach a target that is only accessible through a bastion, mirroring OpenSSH's `-J` / `ProxyJump` — no remote agent required. The core SSH backend gained a `proxyJump` chain on `SshConfig` and a `connect_through_jump_hosts` path that handshakes the target session over a `direct-tcpip` channel opened on the bastion (reusing the same russh primitive as the tunnel forwarders), and the connection editor gained a **"Jump Host"** section: tick _Connect through a jump host_ and configure the bastion inline (host, port, username, auth method, key/password), with a live `You → bastion → target` connection-path summary. **Multi-hop chains** are supported — "Add another hop" appends numbered, removable hop cards ordered outermost → innermost — with on-save validation (missing host/username are blocked; chains deeper than 5 hops are warned about). Referencing a _saved_ SSH connection as a hop follows in a later phase. Designed in #872 (concept `docs/concepts/backlog/ssh-jump-host/`). (Closes #922, #923, #925)

- SSH: **jump-host visual indicators, status bar & context menu**. Connections routed through a bastion now show an accent hop badge (lucide `ArrowLeftRight`) in the connection tree, with a full-path tooltip (`Via: edge → bastion → target`) and a hop-count label for multi-hop chains. When such a connection is the active terminal, the status bar shows the chain (`SSH: deploy@app-server via bastion`). The connection context menu gains two jump-host-only actions: **Open Jump Host Terminal** (opens a terminal directly on the innermost gateway — reached through the same outer hops, so it shares the pooled gateway session — for debugging connectivity) and **Show Connection Path** (a dialog rendering the full `You → … → target` hop chain with each hop's `user@host:port`). A dropped gateway surfaces through the existing reconnect banner, and reconnecting re-establishes the full chain through the pool (one gateway session even when several terminals reconnect at once). (Closes #926)

- SSH: **jump-host gateway sessions are now pooled and shared**. Multiple connections that reach their targets through the same bastion reuse a single, reference-counted gateway `russh` session instead of each opening its own — created once and shared across terminals **and** SSH tunnels, with concurrent reconnects through one gateway collapsing to a single creation (single-flight). The reference-counted session pool moved into the core crate (`RefPool` / `shared_gateway_pool`) so both the terminal connect path and the tunnel manager draw from one pool; a gateway closes automatically once its last consumer disconnects. SSH **tunnels** (local/remote/dynamic) configured with a `proxyJump` chain now actually connect through the jump host (previously the chain was ignored) and share its pooled gateway. (Closes #924)

- Testing: **guided-manual tests for visual / rendering verification** (#915, part of epic #913) — the pixel- and timing-level rendering the DOM/store bridge cannot assert, ported onto the guided-manual harness (#914) and paired with the screenshot verb (#900). A new `tests/system/tests/test_visual_rendering.py` covers ANSI colours (MT-SSH-02), 256-colour swatches, box-drawing joins (MT-UI-31), Nerd Font / Powerline glyphs (MT-SER-01/02), light-theme application (MT-UI-02..09), and vertical scrollbar appearance (MT-UI-35/36). The harness sets up the **exact** state — opens a terminal and emits the precise escape sequences, or switches the theme via Settings and waits for `settings.theme` to update — then asks the operator only to _look_ and confirm, capturing a screenshot to the report through `manual_observe`. Marked `manual` + `integration`, so they skip on CI/normal runs and run under `./pytest.sh --manual -k visual -s`. The harness-setup portion (the colour/glyph/box commands emit their markers, the theme store round-trips, the scrollback fills and scrolls) was verified end-to-end against the built app. Startup/connect white-flash (MT-UI-01, MT-LOCAL-05) and OS-level app-icon checks remain follow-ups. [docs/testing.md](docs/testing.md) (#915)

- Testing: **ported the Network Tools panel-UI E2E suite** from WebdriverIO to the Python bridge harness (part of #810 / epic #799). The `network-tools.test.js` cases (NT-01..09 — the sidebar's quick actions + New Monitor, and each tool panel: Ping, Port Scanner, DNS Lookup, Open Ports, Traceroute, Wake-on-LAN, HTTP Monitor — opening, control presence, and disabled-while-empty) now live in `tests/system/tests/test_network_tools.py` behind a new reusable `NetworkToolsUi` mixin, asserting on the live DOM and the `disabled` attribute. Open Ports' Refresh is exercised against the local machine (the idle placeholder is replaced by a result or error). The original WebdriverIO spec is removed. The live-network cases (`network-tools-live.test.js`, NT-10/12/13/14/17/18) are **not** ported yet — several reference result-row/control `data-testid`s that don't exist (tracked in #934). (#810)

- Testing: **ported the SSH tunnels editor/list E2E suite** from WebdriverIO to the Python bridge harness (part of #810 / epic #799). The `ssh-tunnels.test.js` cases (TUNNEL-01..10 — open the tunnels sidebar, open the editor, each tunnel type's diagram + form fields, reactive port-in-diagram, double-click-to-edit, duplicate, delete) now live in `tests/system/tests/test_ssh_tunnels.py`, asserting on the live DOM (`get_text`/`get_value`) and the store rather than scraping; the original WebdriverIO spec and its orphaned `helpers/tunnels-infra.js` are removed. The live start/stop coverage (from the already-ported `-infra` spec) is unchanged. (#810)

- Testing: **guided-manual tests for native OS file/save dialogs** (#916, part of epic #913) — the flows that open a native dialog the in-webview bridge cannot drive, ported to the guided-manual harness (#914). A new `tests/system/tests/test_native_dialogs.py` covers **Export** (MT-CONN-09) and **Import** (MT-CONN-08) connections, the SSH key **Browse** button (MT-CONN-17), and **Save terminal to file** (MT-TAB-08). Each follows the guided contract: the harness does all the automatable work — launches the app, builds the state, and opens the dialog-triggering control so the native dialog is already up — then asks the operator only to pick/save the exact path it names, and **verifies the outcome automatically** (the exported JSON contains the connection, the imported connection appears in the store, the key-path field fills in, the saved file holds the terminal output). They are marked `manual` + `integration`, so they skip on CI/normal runs and run under `./pytest.sh --manual -k native_dialog -s`. The harness-setup portion (menus, dialogs, the SSH editor's key-auth Browse button, the tab right-click → Save) was verified end-to-end against the built app. Encrypted import (MT-CONN-12..16), Open-in-Editor → Save As (MT-TAB-17..19) and portable export (MT-PORT-04) remain follow-ups. [docs/testing.md](docs/testing.md) (#916)

- Testing: **a `screenshot` bridge verb for visual carve-outs and failure bundles** (roadmap item **P5** of `docs/system-test-local-workflow.md`). The in-webview test bridge could read state and terminal text but not _see_ the rendered UI, so visual checks (pixel geometry, theme rendering) stayed manual. The new verb rasterizes the live DOM to a `data:image/png;base64,…` URL via [`html-to-image`](https://github.com/bubkoo/html-to-image) — lazy-imported so it stays a test-mode-only chunk and never weighs down the normal bundle — and is wired through the whole catalog: protocol, dispatcher (an injected `screenshot` dep, stubbed in unit tests like `resizeWindow`), the TS `Driver`, and the Python harness `Driver.screenshot()`. The failure-artifact bundle now writes a `screenshot.png` alongside `state.json` / `terminal.txt` whenever the app supports the verb (best-effort, like the other probes), and a new `tests/system/tests/test_screenshot.py` integration test captures the real app and asserts a valid, non-trivial PNG. The Python bridge raises its single-frame size cap to 32 MiB so a large window's screenshot is not truncated, and `screenshot_to_png_bytes` decodes the data URL. DOM rasterization does not capture the xterm GPU canvas or native OS dialogs (terminal text is read via `readTerminal` instead); a native window-capture backend could lift that in future. [docs/test-bridge.md](docs/test-bridge.md) (Closes #900)

- Testing: **a generated `data-testid` catalog for system-test authors** — `scripts/build-testid-catalog.py` scans `src/**` for every `data-testid` and writes a checked-in catalog at `tests/system/testid-catalog.md` (roadmap item **P4** of `docs/system-test-local-workflow.md`), so an author can confirm a selector exists — and its exact form — without reading component source (the #1 authoring error when porting tests). Ids are classified as **literal** (exact), **dynamic** (templates rendered as `*` globs, e.g. `file-row-${name}` → `file-row-*`), or **indirect** (supplied by a prop at the call site). A `--check` mode runs in the Code Quality CI job so the catalog never drifts from the source, and the classification/scan logic is covered by a no-build unit test (`tests/system/tests/test_testid_catalog.py`). (Closes #899)

- Testing: **guided-manual test mode in the Python system-test harness** — human-in-the-loop tests are now first-class `pytest` tests that share the harness's app/agent orchestration, fixtures, and reporting instead of living in the standalone `scripts/test-manual.py` + `tests/manual/*.yaml` runner. A new `@pytest.mark.manual` marker plus a `ManualUi` mixin (`manual_step` / `manual_confirm` / `manual_observe`) let a normal test do all the automatable setup through the existing mixins and then prompt the operator for only the irreducibly-manual step (a native OS dialog, xterm-canvas color fidelity, cursor blink). Without `--manual` (or with no interactive TTY) these tests **skip** with a clear reason, so `pytest -m manual` lists/skips them in CI without failing; `./pytest.sh --manual -k <id> -s` walks an operator through one test, and `--manual-platform=<os>` selects platform-scoped items. Each `--manual` session writes a `manual-<ts>-<platform>-<arch>.{json,md}` report (pass/fail/skip + notes, platform, timestamps) to `tests/reports/`. Ships three worked examples in `tests/system/tests/test_manual_examples.py` (a visual ANSI-color check, a native-dialog connection export, and a yes/no cursor-blink confirm), proving the harness-setup-then-prompt pattern. `manual_observe` will attach a screenshot once the bridge gains the verb (#900). This begins subsuming the YAML runner; remaining items migrate incrementally (epic #913). [tests/system/README.md](tests/system/README.md), [docs/testing.md](docs/testing.md) (Closes #914)

- Testing: **a one-command runner for the Python bridge system-test harness** — `scripts/test-system-py.sh` (+ `.cmd`) replaces the manual build → fixtures → `pytest.sh` dance with a single entry point (roadmap item **P3** of `docs/system-test-local-workflow.md`). It builds the app only when the binary is missing or stale (honoring `--debug` for the fast loop from #891), pins the harness to that profile via `TERMIHUB_TEST_APP_BINARY`, brings up only the `--fixtures` you name, and forwards every remaining argument to `pytest.sh` (`--` forwards a token that looks like a runner flag). `--dry-run` prints the resolved plan with no side effects, and is covered by a no-build unit test (`tests/system/tests/test_runner_script.py`). The `.cmd` delegates to the same script via Git Bash/WSL. (Closes #898)

- Testing: **bridge coverage for the restored SSH key-file validation hint** (#896, implemented in #907). A new `tests/system/tests/test_connection_editor.py::test_key_path_validation_hint` drives the real connection editor through the harness — typing a missing path shows the **File not found.** error hint, an existing non-key file (`/etc/hosts`) shows the **Not a recognized…** warning, and clearing the path removes the hint — asserting against the live `validate_ssh_key` backend (the unit tests in #907 mock it). Fulfills #896's request to cover the `field-keyPath-key-path-validation` hint in the bridge suite. (#896)

- Testing: **the local-shell `pwd` / starting-directory / cwd checks are now cross-platform too**, completing the Windows-safety pass started in #886 (so the previously `@skip_on_windows`-gated tests run on Windows). `ShellCommands` gained `pwd`-equality marker builders (POSIX `[ "$(pwd)" = … ]` vs PowerShell `if ((Get-Location).Path -eq …)`), per-platform scratch directories for the cwd-following tests (`/tmp`,`/etc` vs `$env:TEMP`,`$env:WINDIR`) and starting-directory values, plus an `is_absolute_path()` that accepts a POSIX root, a Windows drive, or a UNC path. All nine gated tests in `test_local_shell.py` / `test_file_browser_local.py` are un-gated and routed through these (the `skip_on_windows` marker is removed); the new builders are unit-tested for both dialects with no app or Windows needed, with execution verified on Windows CI (#804). (Closes #902)

- Documentation: **reconciled `docs/testing.md` with the actual test-file inventory** after the bridge-port epic (#799). The "Test Suites" table no longer points at the removed `ssh-banner.test.js` / `ssh-keys.test.js` E2E specs (now `tests/system/tests/test_ssh_banner.py` / `test_ssh_keys.py`), the "E2E Coverage Map" SSH rows point at their `tests/system/tests/test_ssh*.py` homes instead of the deleted `infrastructure/ssh*.test.js`, and the aggregate count is corrected (10 WebdriverIO files, was a stale 25). No row references a non-existent test file. (Closes #855)

- Build (CI): a checked-in **`.cargo/config.toml` that hardens crates.io downloads** against the intermittent `curl failed [16] Error in the HTTP2 framing layer` flake that spuriously reddened unrelated CI jobs (Security Audit, Windows agent cross-build). It forces HTTP/1.1 (`[http] multiplexing = false` — the targeted fix for the HTTP/2 framing error) and raises download retries (`[net] retry = 5`, up from the default 3). Living at the repo root, it applies to local builds and to `cross`/native CI builds alike. (Closes #897)

- Testing: **local UI system suites now author files cross-platform**, so they can run on Windows (#804) instead of assuming a Unix shell. A new `ShellCommands` builder (`tests/system/termihub_harness/shell.py`) plus a `ShellFsUi` mixin emit the POSIX **or** PowerShell command for the host's default shell (`printf`/`touch`/`rm` ↔ `[System.IO.File]::WriteAll…`/`New-Item`/`Remove-Item`), and `test_editor.py` + the file-authoring half of `test_file_browser_local.py` route their create/cleanup through it. The POSIX output is pinned byte-for-byte to the previous commands, so Linux/macOS runs are unchanged; both dialects are unit-tested with no app or Windows needed. Checks that assume Unix paths or POSIX `pwd`/`test` syntax (the `cd /tmp` cwd-following and `[ "$(pwd)" = … ]` starting-directory tests in `test_local_shell.py` / `test_file_browser_local.py`) were initially gated `@skip_on_windows` and are made cross-platform in #902. (Closes #886)

- Testing: **restored the two-shell CWD-follow file-browser system test** (`tests/system/tests/test_file_browser_local.py`). The `file-browser-extended` "follows each CWD when switching between two local shell tabs" check (PR #39 coverage) was dropped in #809 as too OSC 7-timing-flaky; it now runs robustly through the bridge harness — two local shells sit in `/tmp` and `/etc`, and switching the active terminal tab re-targets the browser to each shell's cwd, waiting for the displayed path to settle after every switch so it never races zsh's OSC 7 emission. (Closes #873)

- Testing: ported the **connection editor/forms, credentials & export/import UI E2E suites** from WebdriverIO to the Python bridge harness (`tests/system/tests/test_connection_forms.py`, `test_connection_editor.py`, `test_export_import.py`, and four added scenarios in `test_credential_store.py`), removing the five original specs (`connection-forms`, `connection-editor-extended`, `credential-store`, `encrypted-export-import`, `ssh-agent-warning`). Coverage now asserts real behavior via the bridge rather than DOM/CSS scraping: per-type editor field visibility and default ports, the shell-dropdown "(default)" label, the SSH X11 backward-compat default (read from the persisted connection), the credential store's wrong-password/Skip/indicator-visibility flows, the export dialog's mode switch + password validation, folder-context-menu placement, the SSH key-path combobox, and schema-driven dynamic field visibility. Three editor controls gained stable `data-testid`s for this (`export-mode-plain`/`export-mode-encrypted`, `export-warning`, `export-password-error`, `settings-default-user`). Parts of the originals targeted UI that has since changed or been removed and are dropped by design (each was defensively written and had become a silent no-op): SSH key-file **validation hints** (PR #204, gone from `src`), **host:port auto-extraction** (PR #195 — `parseHostPort` exists but is not wired into the editor), the **monitoring/file-browser per-type toggles** (not in the SSH schema), and the key-path **suggestion-dropdown contents** (populated from `~/.ssh`, so environment dependent — only the combobox structure is asserted). The encrypted **import** flow stays a manual test (it opens a native OS file picker). The Settings → General **default user / SSH key pre-fill** tests are ported but skipped pending a regression they surfaced (#889). [docs/test-bridge.md](docs/test-bridge.md) (Closes #838)

- Testing: ported the **SFTP file-browser & remote-editor infrastructure E2E suites** from WebdriverIO to the Python bridge harness (`tests/system/tests/test_sftp_infra.py`), replacing `infrastructure/sftp-extended.test.js`, `infrastructure/file-browser-infra.test.js`, and `infrastructure/editor-infra.test.js`. The Docker `ssh-password` container stays as a **fixture** (`ssh_fixtures`, port 2201); only the driver changes, reusing the existing `SftpUi` / `FilesUi` / `EditorUi` mixins. Covered: SFTP lists the remote filesystem, the Upload control is present in SFTP mode, a remote file's right-click menu offers **Download**, editing a remote file shows the **[Remote]** badge and keeps the browser on the file's parent directory, **New File** creates a remote file, and double-clicking a remote file opens an editor tab. The serial "no filesystem" placeholder (MT-FB-06; the virtual socat PTY is not OS-enumerated, so it cannot be selected through the bridge) and mid-session SFTP loss / real upload-download transfer (MT-FB-17; OS-native dialog + fault injection) are retained as manual tests in [docs/testing.md](docs/testing.md). (#814)

- Testing: the **Python system-test harness iterates faster and fails legibly**. It now runs against a **debug build** — `orchestrator.app_binary_path()` resolves `TERMIHUB_TEST_APP_BINARY` (explicit override) → release → `target/debug` (from `pnpm tauri build --debug`, much faster to rebuild than release), tightening the frontend-change → run loop. And on an **integration test failure** the harness writes a diagnostic bundle to `tests/system/artifacts/<nodeid>/` (git-ignored) — `state.json` (store snapshot), `terminal.txt` (terminal buffer), and `app.log` (captured app stdout/stderr, tee'd so `-s` still streams live) — so a CI or headless failure is debuggable after the app is torn down. New machinery unit tests cover both (no build needed). See [docs/system-test-local-workflow.md](docs/system-test-local-workflow.md).

- Documentation: a **system-test local workflow & improvement strategy** ([docs/system-test-local-workflow.md](docs/system-test-local-workflow.md)) for the Python bridge harness — the efficient run/implement/analyze iteration loop (build once, keep fixtures warm, targeted `pytest -k … -x -s --lf`, `--delay4user` watch-along, `--collect-only` preflight) plus a prioritized roadmap of harness tooling gaps (fast debug-build support, automatic failure-artifact capture, a one-command runner, a `data-testid` catalog, an optional screenshot verb). Linked from [tests/system/README.md](tests/system/README.md).

- Testing: the **editor binary / non-UTF-8 graceful-error check is now automated** (`tests/system/tests/test_editor.py`), completing the editor suite's bridge parity — it was the last editor case still listed as a manual test. The harness authors an undecodable file from the terminal (`printf '\xff\xfe\x00\x01'`, a sequence `localReadFile`'s UTF-8 decode rejects), opens it through the file browser, and asserts `FileEditor` surfaces its `file-editor__error` panel rather than crashing. `FileEditor`'s error panel gained a `file-editor-error` `data-testid` so the bridge can address it, and `EditorUi` gained an `open_file_expecting_error` helper. (Closes #881)

- Testing: the test bridge's **`pressKey` verb now supports modifier chords** (`ctrl` / `meta` / `shift` / `alt`) and gives the dispatched event a real legacy **`keyCode`** (set via `Object.defineProperty`, since it is read-only and absent from `KeyboardEventInit`). A synthetic key event otherwise leaves `keyCode` `0`, and Monaco's `StandardKeyboardEvent` reads `e.keyCode` to resolve keybindings — so without it `Ctrl+S` resolves to `Unknown` and does nothing. With it, keybinding-driven editors respond as they do to real input. Wired through the whole catalog (protocol, dispatcher, TS `Driver`, scenario runner, Python `Driver.press_key(..., ctrl=…, meta=…)`), and `FileEditor` tags Monaco's hidden input `editor-input` so the bridge can target it. This **restores the editor E2E checks #809 had to skip**: cursor movement (`ArrowDown` → `editorStatus.line` updates) and the **Save keybinding** (`Cmd+S`/`Ctrl+S` clears the dirty flag) now run in `tests/system/tests/test_editor.py`. [docs/test-bridge.md](docs/test-bridge.md) (Closes #866)

- Testing: ported the **terminal, editor & local-files UI E2E suites** from WebdriverIO to the Python bridge harness (`tests/system/tests/test_local_shell.py`, `test_file_browser_local.py`, `test_editor.py`, `test_external_files.py`, `test_terminal_auto_scroll.py`), removing the seven original specs (`local-shell`, `local-shell-extended`, `file-browser-local`, `file-browser-extended`, `editor`, `external-files`, `terminal-auto-scroll`). Two new bridge verbs make the auto-scroll port possible — **`scrollTerminal`** / **`getTerminalViewport`** drive and read an xterm viewport through xterm's own scroll, firing the same `onScroll` the auto-scroll guard keys off, so the #504 "don't yank a scrolled-up user" behavior is testable without canvas wheel events; the editor/file-browser "activate" gestures reuse the existing **`doubleClick`** verb (#830). The new verbs are wired through the whole catalog — protocol, dispatcher, the in-process TS `Driver`, the declarative scenario runner (`scrollTerminal` step + `terminalAtBottom` check), and the Python `Driver` (`scroll_terminal`, `terminal_viewport`) — and the editor/file-browser flows are driven through new `EditorUi` / `FilesUi` suite mixins. Assertions map to store state (`editorStatus` line/indent/EOL/language, `editorDirtyTabs`, `terminalExitedTabs`) and the displayed `file-browser-current-path` / `file-row-*` rather than scraping Monaco or the GPU canvas — so where the old WebdriverIO tests could only check "the xterm container still exists", these assert the real behavior (e.g. that `pwd` lands in the configured starting directory). Cursor-move Ln/Col, the Ctrl+S keybinding, and binary-file handling — all needing keystrokes routed into Monaco's canvas — are retained as manual tests in [docs/testing.md](docs/testing.md) (follow-up #866). [docs/test-bridge.md](docs/test-bridge.md) (#809)

- Testing: the **credential-store system-test suite** gained four more scenarios — a **stale stored credential** is detected on the next connect (auth fails), cleared, and recovered via a fresh prompt; the **auto-lock timeout** setting round-trips; the **master password can be changed** (lock + unlock with the new password proves the vault re-encrypted); and a **master-password store migrates back to no-storage**. `CredentialStoreUi` gained `change_master_password`, `set_auto_lock_timeout`, and `migrate_to_no_store`; the change-password dialog inputs/button and the switch-to-no-storage confirm button in `SecuritySettings` gained stable `data-testid`s. (Auto-lock options start at 5 minutes, so the lock actually firing stays a manual test.) (Closes #862)

- Testing: a new **Docker-fixtures integration CI lane** (`.github/workflows/integration-fixtures.yml`) brings the `tests/docker` stack up (`compose up --wait`, now viable thanks to the repaired healthchecks; stress/fault/network profiles) and runs the `core/tests` integration suite **serially** against the live containers. The regular Run Tests job runs `cargo test` with no containers up, so every `require_docker!`-gated test silently skipped — which is how the telnet daemon break and the `nc`-based healthchecks rotted unnoticed; this lane fails CI when a fixture is broken. It runs nightly, on manual dispatch, and on changes to `tests/docker/**` or `core/tests/**` (not every PR). It runs serially because the suites share single-instance containers (parallel runs collide on the network-fault-proxy's `tc` qdisc). Four pre-existing fixture-content failures it surfaced — missing sftp-stress symlink/unicode files and an empty jumphost marker — are `#[ignore]`d and tracked in #864. (Closes #858)

- Testing (CI): the **Rust Code Quality** job now compiles `termihub-core` **without `--all-features`** (`cargo test -p termihub-core --no-run`, plus `--features ssh` and `--features telnet`), guarding the #868 fix from regression. The Docker-dependent `core/tests/` files are feature-gated so a plain `cargo test -p termihub-core` compiles to a no-op; but every other Rust job runs `--all-features`, where cargo feature unification would silently hide a newly-added un-gated test file and re-break the bare `cargo test` a contributor naturally types. This compile-only check (the tests need Docker fixtures to actually run) catches that, and the partial `ssh`/`telnet` builds verify the gates resolve correctly (telnet's suite needs both). (Closes #877)

- Testing: a new **credential-store system-test suite** (`tests/system/tests/test_credential_store.py`) exercises the master-password store end-to-end through the bridge harness — a subsystem previously covered only by Rust unit tests and manual tests. It verifies that master-password mode **persists across an app restart** (and re-locks, then re-opens with the original password), that a **saved password is reused on reconnect** (no second prompt), and that a **locked store raises the unlock dialog before a connect proceeds**. `CredentialStoreUi` gained `lock_credential_store` / `unlock_credential_store` / `handle_unlock_dialog` (driving the status-bar lock indicator + unlock dialog), and `setup_master_password_store` now recovers a locked store by unlocking it. A `ConnectionsUi.require_stable_connection` helper waits for the editor's optimistic `conn-…` id to be replaced by the persisted id, so a credential is stored under the id the reconnect will resolve. (Closes #857)

- Testing: the **serial & telnet infrastructure E2E suites are now ported to the Python system-test harness** (`tests/system/tests/test_serial.py`, `tests/system/tests/test_telnet.py`), replacing the WebdriverIO `serial.test.js`, `serial-extended.test.js`, and `telnet.test.js` so they run natively on macOS too. **Telnet** covers connect-and-open-a-tab, the live server **login banner** (which the WebdriverIO suite could not read off the xterm canvas), an interactive send→receive round-trip (typing a username advances `login:` → `Password:`), and graceful failure to an unreachable host; the `telnet-server` container stays as a **fixture** via a new session-scoped `telnet_fixtures` (port 2301). Fixing this also repaired the long-broken telnet container — on Ubuntu 24.04 the `telnetd` package is a shim for `inetutils-telnetd`, whose daemon lives at `/usr/sbin/telnetd` (not `/usr/sbin/in.telnetd`), so xinetd accepted connections then immediately dropped them. **Serial** ports the editor-UI checks (the port field plus the baud/data-bits/stop-bits/parity/flow-control selectors round-tripping non-default values via `getValue`); the live-I/O scenarios (connect / echo / device-disconnect) stay as **manual tests** (`MT-SER-09`) because the port field is a detection-only `<select>` and a virtual socat PTY is not OS-enumerated, so it cannot be selected through the bridge. The original WebdriverIO specs were removed. (#813)

- Testing: the Python system-test harness can now **set up and unlock a master-password credential store** (new `CredentialStoreUi.setup_master_password_store`), which drives the Settings → Security panel exactly as a user would. This un-skips the **SSH key-passphrase prompt** system test (`test_passphrase_protected_key_prompts_then_connects`): a passphrase-protected key is saved with **Save credentials** on, connected via a sidebar double-click, and the harness answers the resulting passphrase prompt. The `savePassword` editor field only renders when the credential-store mode is not `"none"`, so this was unreachable until the harness could switch modes. The two master-password setup inputs and the confirm button in `SecuritySettings` gained stable `data-testid`s for this. (Closes #851)

- Testing: the in-app test bridge gained two interaction verbs — **`doubleClick`** and **`resizeWindow`** — that unblock faithful E2E ports. `doubleClick` dispatches the full gesture a real double-click produces (two pointer→mouse→click rounds followed by a `dblclick` event), so it reaches React `onDoubleClick` handlers like **connecting a saved connection from the sidebar** — the only path that raises the **SSH key-passphrase prompt** (`ConnectionList.requestPassword`). `resizeWindow` drives the real **Tauri window** via `getCurrentWindow().setSize(...)` so resize-triggered behavior runs exactly as it does interactively (xterm's fit addon re-fits the terminal and re-sizes the PTY). Both are wired through the whole catalog: protocol, dispatcher, the in-process TS `Driver`, the declarative scenario runner, and the Python harness `Driver` (`double_click`, `resize_window`). `resizeWindow` also needed the `core:window:allow-set-size` Tauri capability. This re-enables the previously skipped terminal window-resize system test (`test_terminal_survives_window_resize`) and adds a sidebar double-click connect test (`test_sidebar_double_click_connects_password`) that drives the real `ConnectionList.onDoubleClick` → `handleConnect` path. (The SSH key-passphrase-prompt test stays skipped: that prompt only fires when the `savePassword` field is set, and that field is hidden whenever the credential-store mode is `"none"` — the mode the system-test app launches in — so it needs credential-store setup beyond this issue's scope.) [docs/test-bridge.md](docs/test-bridge.md) (Closes #830)

- Testing: the test bridge's **`dragTo` verb now reliably drives @dnd-kit reordering**, so the previously skipped tab drag-reorder system test (`test_reorder_tabs_by_dragging`) is un-skipped and green. Driving @dnd-kit with synthetic pointer events needs two things a back-to-back event burst does not provide: a **wake move** past the `PointerSensor` activation distance (5px for tabs), and **frame yields** after activation and between moves so `DndContext` can measure droppable rects and resolve the drop target (`over`) — without those yields the drop reorders nothing. `dragTo` now does both. The dnd-kit behavior is documented in [docs/test-bridge.md](docs/test-bridge.md). (Closes #832)

- Testing: the in-app test bridge gained a **`getValue` command** that reads the live `value` of an `<input>`/`<textarea>`/`<select>` — the DOM _property_ a React-**controlled** field updates, which `getAttribute` (markup attribute only) cannot observe, so it could not assert e.g. "the port field shows `22`" or "the auto-lock select is `Never`". Returns `el.value`; fails with an agent-readable error for non-value elements or a missing testid. Wired through the whole catalog: protocol, dispatcher, the in-process TS `Driver`, the declarative scenario runner (`valueEquals` check), and the Python harness `Driver` (`get_value`). [docs/test-bridge.md](docs/test-bridge.md) (Closes #833)

- Testing: the **UI E2E suite was ported from WebdriverIO to the Python bridge harness** (`tests/system/tests/`), and the bridge gained three new verbs to make faithful ports possible. **`drag`** (pixel delta — resize handles), **`getComputedStyle`** (computed CSS incl. theme custom properties like `--bg-primary`, which `getAttribute` cannot see), and **`dragTo`** (pointer-based element-to-element drag, e.g. @dnd-kit tab reordering) are available on the TS `Driver`, the Python `Driver`, and the declarative scenario runner (plus a `computedStyleEquals` check); right-click menus, keyboard, and native `<select>`s use the shared **`contextMenu`** / **`pressKey`** / **`select`** verbs. Ten UI specs now run via the harness with assertions mapped to store state (`sidebarCollapsed`, `rootPanel`, `sidebarWidth`, `settings.theme`, `layoutConfig`, `tabColors`, `tabHorizontalScrolling`, …) rather than DOM scraping: sidebar toggle/resize/sections, split views, tab management, tab horizontal scroll, theme & layout, UI state, settings, and cross-platform. Pure-visual or OS-window assertions that the in-webview bridge cannot drive (pixel geometry, OS window resize, xterm-canvas text selection/scroll-wheel) are retained as manual tests in [docs/testing.md](docs/testing.md). The original WebdriverIO specs were removed. [docs/test-bridge.md](docs/test-bridge.md) (#808)

- Testing: ported the **connection-CRUD UI E2E suite** to the Python bridge harness (`tests/system/tests/test_connection_crud.py`, replacing `tests/e2e/connection-crud.test.js`): create/edit/delete/duplicate connections, folder creation, editor-as-tab behavior, duplicate-name validation, the ping context menu, SSH creation, and the export dialog. To drive these the in-app test bridge gained two verbs — **`contextMenu`** (open a right-click menu, for the connection context menu) and **`pressKey`** (dispatch a key such as `Escape` to dismiss menus/dialogs) — reusing the existing `select` verb and the `SystemTest` helpers (`create_ssh_connection`, `find_tab`, `tab_count`, `open_new_connection_editor`). Connections and folders carrying UUID `data-testid`s are resolved by **name** through `getState` via a new `termihub_harness.ui` module (`find_connection`, `find_folder`) and a focused `ConnectionsUi` suite mixin. [docs/test-bridge.md](docs/test-bridge.md) (#807)

- Testing: the **SSH infrastructure E2E suite is now ported to the Python system-test harness** (`tests/system/tests/test_ssh.py`), replacing the WebdriverIO `tests/e2e/infrastructure/ssh.test.js` so it runs natively on macOS too. It covers password authentication, the password-prompt modal (appear / cancel-leaves-no-tab / connect), key-based auth, graceful connection failure, interactive session output, and monitoring show/hide across SSH and local tabs. The SSH containers (`ssh-password`, `ssh-keys`) stay as **fixtures**: the harness gained a runtime-agnostic `ComposeFixture` + a session-scoped `ssh_fixtures` that brings them up with **Docker or Podman** (auto-detected like `scripts/test-system.sh`, overridable with `CONTAINER_CMD`; readiness confirmed by a TCP port probe rather than `compose --wait`, which Podman's compose provider may not support) and **skips the suite cleanly when no container runtime is available**, and `SystemTest` gained reusable SSH connection / password-prompt / tab / monitoring helpers. (#812)

- Testing: the in-app test bridge gained a **`select` command** that drives native `<select>` dropdowns (connection type, SSH auth method) the same way `type` drives inputs — native value setter plus a `change` event so React's controlled select observes it, with agent-readable failures for non-select elements and unknown option values. Wired through the whole catalog: protocol, dispatcher, the in-process TS `Driver`, the declarative scenario runner step, and the Python harness `Driver`. [docs/test-bridge.md](docs/test-bridge.md) (#800, #812)

- Testing: a new **Python system-test harness** (`tests/system/`) that drives the **real built app** over the cross-platform WebSocket bridge and owns the lifecycle of the app and agent processes — the foundation for system/resilience tests that run identically on Linux, Windows, and **macOS** (where the WebDriver E2E path cannot). It is a black-box `pytest` client of the bridge protocol: a `Bridge` server the app connects out to, a synchronous `Driver` (`click`, `type`, `terminal_input`, `read_terminal`, `get_state`, …) kept in parity with the TypeScript dispatcher, and an `Orchestrator` (`AppInstance`/`AgentInstance` with `start`/`stop`/`restart`, process-tree teardown via `psutil`). The first lifecycle test launches the app, opens a shell, writes a command via `terminalInput`, reads the xterm buffer back, then **kills and restarts the app and re-acquires the bridge** — proving the kill/restart/reconnect concept end-to-end. Harness machinery is also covered by fast tests against a fake app (no build needed). See [`tests/system/README.md`](tests/system/README.md). (#802)

- Testing: the in-app bridge's `getState` command now treats an explicit JSON `null` path the same as an omitted one, returning the whole state snapshot. Remote JSON clients (the Python harness) serialize an absent optional as `null` rather than `undefined`, which previously crashed the path walker. (#802)

- Testing: the Python harness gained a **`SystemTest` base class** for integration suites. A test class subclasses it to get a clean environment per suite — a fresh isolated config dir and a freshly launched app, set up once and shared by the suite's tests (run in order), then torn down before the next suite. It also provides the polling/terminal helpers every suite needs (`wait`, `ensure_terminal`, `run_command`, `wait_for_output`, `restart_app`), so a test method is just the steps it cares about. A `delay4user(seconds, reason)` helper inserts watch-along sleeps **only** when pytest is run with the boolean `--delay4user` flag, so a human can follow the UI step by step; normal / CI / AI-agent runs skip them and run at full speed. See [`tests/system/README.md`](tests/system/README.md). (#802)

- Testing: the WebSocket test bridge now supports **sequential app connections within one runner session**, so system tests can assert kill/restart recovery (e.g. kill the app → relaunch → it re-acquires the bridge and restores its session). The runner server previously accepted only the first app connection per run and rejected any later one; it now tracks a monotonic **connection generation** and applies **last-writer-wins** — a newly launched app supersedes its predecessor and becomes the live driver. A new `awaitNextApp()` resolves with a fresh transport for the next connection after the one last handed out (the restart seam), while `waitForApp()` keeps returning the current app's transport and then waits for the next once it disconnects. The in-app `wsClient` detaches all socket listeners on `close()` (idempotently) so a restarted app boots cleanly with no leaked listeners. The TS server and the Python harness (#802) share this contract. [docs/test-bridge.md](docs/test-bridge.md) (Closes #817)

- Testing: the in-app test bridge gained a **`terminalInput` command** that sends a command **into a running terminal session**, so a test (or coding agent) can drive a live shell and then assert on `readTerminal` output. The existing `type` command targets `<input>`/`<textarea>` elements, but an xterm terminal renders to a **canvas**, so it could never write to a shell. `terminalInput` (`{ action: "terminalInput", text, tabId? }`, defaulting to the active tab) routes through the session's backend `send_input` — the same choke point as interactive keystrokes and paste — rather than synthesizing canvas key events. A trailing newline is appended and normalized to the session's configured line ending, exactly like pressing Enter, so `terminalInput("ls")` runs `ls`. It is available on the TS `Driver` (`driver.terminalInput(text, { tabId? })`) and as a declarative scenario step. [docs/test-bridge.md](docs/test-bridge.md) (Closes #818)

- Testing: the in-app test bridge gained a **cross-platform WebSocket transport** so an external test runner can drive the running app over a socket on **every** OS — Linux, Windows, and macOS — with no platform automation driver. In test mode, when the backend supplies a bridge port (`TERMIHUB_TEST_BRIDGE_PORT`, injected into the webview before boot), the app opens a WebSocket _out_ to the runner's server, runs each incoming command through the existing in-process dispatcher, and returns the response over the socket. The runner side adds a `WebSocketBridgeTransport` (with `{ id, command/response }` correlation for concurrent commands) and a `ws`-backed server, so a `Driver` targets a remote app exactly as it does in-process. This removes the macOS gap (ADR-5) for the bridge. [docs/test-bridge.md](docs/test-bridge.md) (Closes #801)

- Testing: a new **in-app UI test bridge** that drives and introspects the running app from inside the webview, so automated UI tests work on **every platform — including macOS**, where no WKWebView WebDriver exists (the existing `tauri-driver` E2E path is Linux/Windows only; see ADR-5). When test mode is enabled (build flag `VITE_TEST_BRIDGE=1`, a `?testBridge=1` query parameter, a `localStorage` opt-in, or a backend-injected global) the app installs `window.__termihubTestBridge`, exposing a small command vocabulary — press a control by `data-testid`, type into a field, read an element's text/attribute, read the **terminal buffer** (via the registry's logical-line reconstruction, not GPU-canvas scraping), and read app state. A platform-agnostic `Driver` abstraction (`src/testbridge/driver.ts`) lets tests and coding agents program against these verbs over a pluggable transport (in-process / WebDriver `browser.execute` today; a backend WebSocket channel for headless macOS to follow). The bridge is inert and uninstalled in normal use. This lays the groundwork for AI-assisted feature development with a UI-level feedback loop. [docs/test-bridge.md](docs/test-bridge.md)

- Testing: a **declarative scenario runner** on top of the test bridge. A test (or coding agent) authors a `Scenario` as plain data — an ordered list of UI **steps** (`click`, `type`, `waitFor`, `pause` by `data-testid`) followed by **checks** (`terminalContains`, `terminalMatches`, `textEquals`, `exists`, `stateEquals`) — and `runScenario` drives it through a `Driver` and returns a structured `ScenarioResult` instead of throwing. The first failing step aborts the rest; when all steps pass, every check is evaluated so a single run reports all assertions at once, and a terminal snapshot is attached on failure. This is the agent-readable feedback layer: `passed` plus per-check `expected`/`actual` and the captured terminal output. (#800)

- Session: the app now **restores your last session on startup**. Open tabs and the full split/tab-group layout are auto-saved (debounced) to a dedicated `last-session.json` on every change and rehydrated the next time the app launches — so an unexpected WebView reload (e.g. after the system wakes from hibernation in dev mode) or a normal restart no longer wipes all open tabs. Restored terminal tabs reconnect where possible; a tab whose target can no longer be reached (host down, agent offline) is shown in a disconnected/error state rather than being silently dropped. A workspace launched from the CLI takes precedence over the saved session. Controlled by a new **Settings → General → Restore Last Session on Startup** toggle (default on); turning it off starts the app fresh and discards any stored session. The auto-saved session reuses the existing workspace capture/restore machinery but never appears in the workspace list. (Closes #586)

- Terminal: configurable **line endings** (PuTTY-style). A new **Settings → Terminal → Line Ending (Enter & Paste)** dropdown (LF / CR / CRLF, default **CR**) controls the byte sequence sent when pressing Enter and is used to normalize line endings in pasted text. CR (`\r`) is the byte every terminal natively sends for Enter and what Windows ConPTY / Unix PTYs expect to submit a command, so the Enter key keeps working everywhere out of the box. This also fixes the long-standing bug where pasting multi-line Windows (CRLF) text into a Unix SSH or serial session inserted a blank line between every row (pasted CRLF collapses to a single CR per line). Normalization is applied centrally in the backend, so it covers all interactive input — typed Enter, paste, and in-app command injection (e.g. the file browser's "go to current path") — uniformly across local, SSH, serial, and telnet terminals. The ending can be overridden per connection (**Connection → Terminal → Line Ending**, with a "use global default" option). (#791)

- Documentation: Windows remote-agent support is now documented across [`docs/architecture.md`](docs/architecture.md) (agent runs on Windows hosts; deployment diagram, binary-target table, and auto-deploy text now cover the Windows install path and named-pipe daemon transport), [`docs/remote-protocol.md`](docs/remote-protocol.md) (new **Platform Notes (Windows)** section covering Windows deployment, named-pipe vs Unix-socket daemon transport, and the PowerShell/ConPTY default-shell behavior), and [`docs/testing.md`](docs/testing.md) / `tests/manual/remote-agent.yaml` (new manual tests MT-AGENT-24…26 for Windows persistent-session reconnect, file browsing, and SSH/Docker jump sessions from a Windows agent). Part of #771 (Closes #770).

- Terminal: the tab right-click menu has a new **Open in Editor** entry (next to **Save to File** / **Copy to Clipboard**) that captures the full terminal scrollback and opens it in a Monaco editor tab that is **not yet saved to disk**. The captured output can be searched, navigated, folded, annotated, and edited like any editor tab; the tab is marked unsaved (an **Unsaved** badge and dirty indicator) until you save it. Saving a captured-output tab opens a native **Save As** dialog, after which it behaves like a normal on-disk file editor. Closing it before saving warns about losing the content. (Closes #785)

- Terminal: after saving terminal content to a file (tab/pane **Save to File**), an **Open Saved File in Tab** dialog now offers to open the saved file in a Monaco editor tab. The dialog has an **Ask again** checkbox bound to a new persisted setting (**Settings → Terminal → Open Saved File in Tab**, default on). When the setting is off, files are saved silently with no dialog and no editor tab; unchecking **Ask again** in the dialog only affects future saves.

- Terminal: saving terminal content to a file now reconstructs logical lines instead of preserving the terminal's width-based wrapping. In addition to xterm's own soft wraps, rows that completely fill the terminal width are rejoined with the following row, so lines that a program hard-wrapped at the terminal width are saved as single lines. Deliberate blank lines are preserved. (Copy-to-clipboard keeps its existing soft-wrap-only behavior.)

- Agent (Windows): the session daemon's IPC transport is now cross-platform. A new `DaemonTransport` abstraction (`agent/src/daemon/transport.rs`) drives the daemon over a Unix domain socket on unix and a **Windows named pipe** on windows, behind erased `AsyncRead`/`AsyncWrite` halves. The named pipe is secured with a per-user DACL (`GENERIC_ALL` to the current user's SID and `LocalSystem` only) — the direct security analog of the Unix socket's `0o700` permissions, with no exposed TCP port. The session daemon (`--daemon` mode) and its binary frame protocol now compile and run on Windows. Persistent sessions on Windows agents are not yet wired end-to-end (the Windows daemon launcher follows separately); non-persistent Windows agent sessions continue to run in-process.

- Agent (Windows): **persistent (reconnectable) remote-agent sessions now work on Windows.** The session daemon's IPC transport is cross-platform — a new `DaemonTransport` abstraction (`agent/src/daemon/transport.rs`) drives the daemon over a Unix domain socket on unix and a **Windows named pipe** on windows, behind erased `AsyncRead`/`AsyncWrite` halves. The named pipe is secured with a per-user DACL (`GENERIC_ALL` to the current user's SID and `LocalSystem` only) — the direct security analog of the Unix socket's `0o700` permissions, with no exposed TCP port. The agent's `DaemonClient` is transport-agnostic, and the `SystemDaemonLauncher` spawns a fully **detached** daemon process on Windows (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`) that survives the agent exiting and is reconnected on restart. No `nix` fork/setsid/signal usage on any daemon path.

- Remote agent (Windows): `#[cfg(windows)]` integration tests for the ConPTY-backed local-shell path. The agent's Windows shell flow goes through `NativeLocalShellSpawner` → `portable_pty::native_pty_system()` → ConPTY, which behaves differently from Unix PTYs around resize and teardown. The new tests pin the shell to `powershell` and `cmd` and exercise spawn, I/O round-trip, back-to-back resizes, and clean teardown so regressions in ConPTY shell defaults fail fast on the Windows CI matrix. `NativeLocalShellSpawner` also gained a doc-comment block describing the ConPTY-specific behavior (`ResizePseudoConsole` firing `WINDOW_BUFFER_SIZE_EVENT`, `ClosePseudoConsole` on drop). Two manual tests (MT-AGENT-21 / MT-AGENT-22) cover the same flow end-to-end through the agent. Part of #771 (Closes #765).

- Remote agents: Windows remote hosts are now detected for agent deployment. The desktop probes `uname` first (covering Linux, macOS, and MinGW/MSYS/Cygwin shells) and falls back to `%PROCESSOR_ARCHITECTURE%` (cmd.exe) / `$env:PROCESSOR_ARCHITECTURE` (PowerShell) when `uname` is absent, so a Windows host whose default OpenSSH shell is cmd.exe or PowerShell is recognized as Windows instead of being misdetected as Linux. x64 and ARM64 Windows hosts resolve to the `windows-x64` / `windows-arm64` agent binaries. Part of #771 (Closes #762).

- Remote agents: the agent can now be deployed and installed on **Windows** hosts over SSH. The desktop detects the remote's default OpenSSH shell (`cmd.exe` vs PowerShell) and issues shell-appropriate install commands — no POSIX-only commands (`mkdir -p`, `mv -f`, `chmod`, `/tmp`) are sent to a Windows remote. The binary is uploaded to the SFTP home and moved into `%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe` (created with `cmd`'s `md`/`move` or PowerShell's `New-Item`/`Move-Item`), then verified with `--version`. Both the interactive **Setup Agent** flow and the programmatic deploy/update path are covered; for Phase 1 the agent launches on demand via `--stdio` (no Windows service is installed). The Setup Agent dialog gained `windows-x64`/`windows-arm64` targets and, for Windows hosts, fixes the install path and hides the systemd-service option. Agent launch/version commands now skip POSIX `$HOME` expansion and the `2>/dev/null` redirect for Windows agent paths. Part of #771 (Closes #763).

- Build tooling: the remote-agent build pipeline can now produce Windows agent binaries. `scripts/build-agents.sh --native --targets x86_64-pc-windows-msvc` (and the new `scripts/build-agents.cmd --native`) build `termihub-agent.exe` for `x86_64-pc-windows-msvc`, with best-effort `aarch64-pc-windows-msvc` support. Because cross-rs cannot target the MSVC ABI, Windows agents are built natively on a Windows host with the MSVC toolchain; the scripts fail fast with a clear message when a Windows target is requested without `--native` or on a non-Windows host. Part of #771 (Closes #761).

- CI / releases: the remote agent is now built and tested on Windows in CI, and the Windows agent binary ships with every release. A `build-windows` job in the Agent workflow builds `x86_64-pc-windows-msvc` natively and runs the `termihub-agent`/`termihub-core` test suites on `windows-latest`, and a new `agent-binaries-windows` release job attaches `termihub-agent-windows-x64.exe` alongside the Linux and macOS agent binaries. The system/E2E suite stays Linux-only (`tauri-driver` + Docker, ADR-5), so Windows agent coverage is unit/integration plus manual tests — this caveat is now documented in [`docs/testing.md`](docs/testing.md). Part of #771 (Closes #769).

- Keyboard shortcuts: terminal-focus pass-through. When a terminal pane has focus, common shell, tmux, vim, and SSH-to-remote keys (`Ctrl+<letter>`, `Ctrl+\`, `Ctrl+[`, `Ctrl+]`, `Alt+<letter>`) are sent to the PTY instead of triggering an app shortcut, even if the user has rebound an action to one of those combos. Toggle in Settings → Keyboard Shortcuts → "Pass through shell keys when terminal is focused" (on by default).

- Keyboard shortcuts: "Reset to Safer Defaults" button in Settings → Keyboard Shortcuts clears all user overrides and re-applies the new conflict-avoiding defaults.

- Documentation: [`docs/keyboard-shortcuts.md`](docs/keyboard-shortcuts.md) describes the conflict-avoidance defaults, pass-through behavior, and SSH-to-remote implications.

- UI: confirmation dialog when closing a tab or tab group via keyboard shortcut (`close-tab` / `close-tab-group`). Default Cancel button focus protects against accidental Enter. The X-button on tabs is unaffected. A new "Confirm Close Tab on Shortcut" toggle in **Settings → General** disables the dialog. Closes #750.

- Network tools: the Port Scanner now accepts CIDR ranges (e.g. `192.168.0.0/24`), single IP/host names, or a comma-separated mix of the two as its target. Results are grouped per host when multiple targets are scanned. Backed by the `ipnet` crate; capped at 65 536 expanded hosts per scan to prevent runaway internet-scale scans. Closes #732.

- Connection Editor: the dynamic connection form now uses `react-hook-form` for field state management and `zod` for client-side validation. Invalid port values (out of 1–65535), empty required text fields, and out-of-range numbers now show inline error messages next to the relevant field without requiring a connection attempt.

- Network tools: `pnet_packet` is now used to validate ICMP/ICMPv6 reply types in traceroute. Only Time Exceeded and Destination Unreachable packets are accepted as valid hop replies; unrelated ICMP packets received on the raw socket are silently ignored. Improves correctness and lays the groundwork for better Windows raw-socket support.

- Dev scripts: `dev.sh` and `dev.cmd` now read per-checkout settings from a gitignored `dev.local.json` file (`dev_port`, `dev_name`). On Unix/macOS, setting `dev_agent_port` auto-builds the agent binary, starts a local `sshd`, and registers a "Dev Agent" entry directly in termiHub's `connections.json` — enabling zero-config local agent testing without a remote machine. Multiple parallel workspaces coexist via port-scoped agent IDs.

- Agent: macOS is now a supported agent target (`macos-arm64`, `macos-x64`). The desktop resolves the correct binary when connecting to a macOS remote host via SSH agent mode. The agent setup dialog shows macOS arch options when connecting to a Darwin host.

- Agent: five local TCP integration tests (`cargo test -p termihub-agent --test local_agent_integration`) that spawn the agent in `--listen` mode on localhost — no SSH, no cross-compilation, no Raspberry Pi required. These make it fast to iterate on agent behavior on any dev machine (macOS, Linux, Windows).

- Agent: six additional integration tests covering shell session lifecycle (create, attach, receive output, persist across client disconnect, reattach after reconnect) and persistent shell buffer replay — verifying that the daemon ring buffer is replayed correctly on same-connection reattach and after full TCP reconnect.

- CI: macOS agent binaries are now built and published in all CI pipelines (agent PR checks, dev builds, releases) using native `macos-latest` runners. The `build-agents.sh` help text now documents macOS native build targets.

- Develop-branch builds are now marked in the status bar with a purple "develop" badge next to the version, and automatically download agent binaries from the `dev-develop-latest` GitHub release instead of `dev-latest`.

- Open Connections panel: proxy sessions (desktop connections routed through a remote agent) are now shown in a "Connections via &lt;agent&gt;" section, grouped by agent, with individual Kill and Kill All buttons. They were previously invisible in the panel.

- Serial port scan prefixes: the full list of Linux `/dev` prefixes scanned to discover serial ports (e.g. `ttyAMA*` on Raspberry Pi, `ttyTHS*` on Jetson, `ttymxc*` on i.MX, and 39 more) is now configurable via Settings → General. Built-in prefixes can be toggled on or off; custom prefixes can be added or removed. Changes take effect immediately when opening the serial port dropdown in a connection editor.

- Persistent connections scrollback replay: when a tab re-attaches to a running persistent session, the agent queries the daemon's ring buffer via a new `MSG_QUERY_BUFFER` / `session.getBuffer` protocol exchange. The buffer lives on the agent machine and survives desktop restarts, correctly solving the offline-desktop use case. The ring buffer size is now configurable per agent in Agent Settings (1–64 MiB, default 1 MiB) (#666).

- Persistent connections: SSH, serial, Docker, and WSL connections can now be started as persistent background sessions that keep the process running after the tab is closed. A `∞` badge and a colour-coded state dot appear on each persistent connection in the sidebar. Inline hover buttons and a state-aware context menu let you Start, Attach a new tab, or Stop the session. Multiple tabs can attach to the same running backend session simultaneously; closing a tab detaches without killing the process. A new `persistent-session-state-changed` Tauri event drives real-time state updates in the sidebar and store (#666).

- Open Connections panel: a new "Open Connections" option in the settings wheel menu lists all active connections across every subsystem — local terminal sessions, connected agents, sessions running on agents, SSH tunnels, SFTP, and monitoring. Each row has a Kill button; each section has a Kill All button for bulk teardown. This is the primary place to inspect and free connection resources.

- Serial port cleanup: closing a serial session now explicitly calls `disconnect()` on the backend before dropping it, ensuring the reader thread stops and the serial port is released immediately.

- Themes: added Solarized Dark and Solarized Light as built-in themes, selectable from Appearance Settings. Both themes use the canonical Ethan Schoonover palette with full ANSI 16-color and UI chrome support (#578).

- Terminal: the scrollback buffer default is now 10 000 lines (previously 5 000) and the maximum is now 1 000 000 lines (previously 100 000). The global and per-connection scrollback settings now show a memory trade-off hint — roughly 1–2 MB per 10 000 lines of typical output (#665).

- Concept document for modern, transparency-aware application icons (`docs/concepts/app-icons.md`): covers app icon design (deep navy gradient, accent-blue prompt glyph, hub connector lines), UI icon family conventions, per-platform size requirements, style guidelines, icon state machine, AI generation prompts, and export pipeline (#641).

- Settings: added an "About" page (accessible from the Settings panel) showing the app name, current version, git hash, project tagline, GitHub repository link, and MIT license details (#631).

- Connection sidebar: connections now support multi-select — Ctrl/Cmd+Click toggles individual selection, Shift+Click range-selects, and dragging a selected group moves all selected connections into the target folder at once. Escape or clicking empty space clears the selection (#638).

- Agent setup: a new "Branch build" binary source option lets you install an agent binary built directly from a PR/feature branch. When the desktop itself is a feature-branch build, the option is pre-selected and the branch name pre-filled. The computed download URL updates live as you type. Branch binaries are published to a short-lived `agent-branch-{branch}` GitHub pre-release on every push to the PR branch, and cleaned up automatically when the branch is deleted (#666).

- Agent setup: the setup dialog now detects the remote host's architecture automatically before opening, and defaults to downloading the agent binary from GitHub (using `dev-latest` for dev builds or `v{version}` for releases). A local file picker remains available as a fallback. The detected architecture and download URL are shown in the dialog.

- CI: dev build artifacts are now published automatically on every push to `main` as a rolling GitHub pre-release tagged `dev-latest`, providing downloadable installers for all supported platforms and agent binaries without building from source (#637)

- Serial: the port field in the serial connection editor is now a dropdown populated with currently detected serial ports. If the previously configured port is no longer detected (e.g. USB adapter unplugged), it still appears in the list marked as "(not connected)". When editing a serial session on a remote agent, the dropdown shows the ports detected on the remote machine.

- Terminal: a unified "Connecting…" overlay now appears on every terminal tab while the backend session is being established, for all connection types (SSH, Telnet, serial, agent sessions). The overlay shows a spinner and a Cancel button (which closes the tab). If the initial connection fails, the overlay transitions to an error state with a Retry button and contextual hints for common failure modes (SSH agent not running, timeout, serial port not found, port permission denied, port in use).

- Terminal: for agent-mediated sessions (sessions running on a remote agent), connection failures trigger automatic background retry instead of showing an error immediately. The overlay shows the current attempt number. The user can cancel at any time by closing the tab.

- Terminal: tabs that are created while their parent agent is still connecting now show a "Waiting for agent…" spinner overlay and automatically start their session once the agent connects, instead of failing immediately with an error.

- Serial: error messages for common failure modes (port not found, permission denied, port in use) now include the port name and a plain-English explanation of how to fix the issue.

- Terminal: when a session exits unexpectedly (e.g. remote host reboots), a semi-transparent overlay appears over the terminal with a "Session disconnected" message, a Reconnect button that starts a fresh session with the same connection config, and a Dismiss button to hide the overlay and scroll the preserved history

- Remote Agents: agent runtime settings (feature toggles, session defaults, diagnostics) are now stored per-agent and configured in a dedicated "Agent" tab in the connection editor. Settings include enabling/disabling monitoring, file browser (SFTP), and Docker support; setting a default shell and starting directory; and configuring log level and verbose protocol tracing. Settings are sent to the agent on connect and can be updated live without reconnecting.

- File browser: drag files from OS file managers (Finder, Explorer, etc.) directly onto the file browser panel to upload them (SFTP/session) or copy them (local mode). A dashed overlay confirms the drop target.

- Terminal: drag files from OS file managers onto any terminal panel to insert their shell-safe quoted path(s) at the cursor.

- Version display: dev builds now show a `-dev` suffix (e.g. `v0.1.0-dev`) in the status bar, Settings footer, and Update Settings panel; a git commit hash is shown alongside the version in the Settings panel and Update Settings for both dev and release builds. Dev builds are offered an update when the matching stable release (`v0.1.0`) becomes available.

- Agent: external connection files — agent transport settings now support configuring a list of remote file paths. Enabled files are passed to the agent at connect time via the `initialize` JSON-RPC call; the agent loads connections from those files and merges them into the connection list as read-only entries tagged with their source file path.

- Sidebar: right-clicking on the empty area of the connection list now opens a context menu with **New Connection** and **New Folder** options

- Agent: ARMv7 (arm32) support — a new `termihub-agent-linux-armv7` binary is now built and released for 32-bit ARM devices such as older Raspberry Pi models (Pi 2 B, Pi 1 B+). Includes cross-compilation Dockerfile, Cross.toml entry, updated build and setup scripts, and CI pipeline changes.

- Update checker (Variant A — notify only): termiHub now checks the GitHub Releases API on startup (with a 5-second delay) and every 24 hours for new versions. When a newer release is found, an amber dot appears on the version chip in the status bar and a non-blocking notification popup offers to open the GitHub downloads page. Security releases (marked `<!-- security -->` in the release notes) show a red dot and cannot be silently skipped. Users can skip a specific version, clear a skipped version, or disable automatic checks entirely in **Settings → Updates**.

- Connection settings: a **Shell Integration** toggle is now available for local shell, SSH, and WSL connections (enabled by default). Disabling it skips all OSC injection at startup.

- Connection settings: boolean fields now support an optional **help icon (?)** that opens an explanation dialog. The Shell Integration toggle uses this to explain what OSC 7 tracking is and why it's useful.

- Tests: `core/tests/ssh_banner.rs` — two new Rust integration tests (SSH-BANNER-01, SSH-BANNER-02) for the `ssh-banner` Docker container, verifying that the pre-auth banner text is delivered and that standard SSH servers send no banner

- Tests: ECDSA-384 and ECDSA-521 passphrase-protected key fixtures (`tests/fixtures/ssh-keys/`) and corresponding integration tests (SSH-AUTH-13, SSH-AUTH-14), completing passphrase coverage across all supported ECDSA curve sizes

- Terminal: `lineHeight` is now a user-configurable setting (0.8–2.0) in Appearance Settings, also available per-tab via `TerminalOptions` (#579)

- UI: all password input fields now have a show/hide toggle (eye icon) on the right side, allowing users to verify what they typed before submitting

- Network Tools: built-in network diagnostic utilities accessible from the "Network Tools" activity bar entry (experimental, #525):
  - **Port Scanner** — TCP connect scan with port-spec syntax (`22`, `80,443`, `8080-8090`), streaming results, large-range warning
  - **Ping** — ICMP ping with TCP fallback when raw sockets require elevated privileges; live latency chart (up to 2 min history); configurable interval and count
  - **DNS Lookup** — A/AAAA/MX/CNAME/NS/TXT/SRV/SOA/PTR/ANY record types with optional custom nameserver
  - **Traceroute** — TTL-limited hop-by-hop trace with three RTT columns per hop
  - **Open Ports** — lists TCP/UDP listening ports on the local machine with process name and PID
  - **Wake-on-LAN** — sends magic packets; save/delete named device presets; per-send history
  - **HTTP Monitor** — periodic HTTP/HTTPS checks with response-time chart, status history, configurable method, interval, expected status code
  - All diagnostic logic lives in `termihub-core` so the remote agent can use it; HTTP monitoring is desktop-only
  - Agent now supports `network.port_scan`, `network.ping`, `network.dns_lookup`, `network.open_ports`, `network.traceroute`, `network.wol` JSON-RPC methods

- Services: "Bind Address" in the New/Edit Service dialog is now a dropdown listing all local network interfaces (loopback, real interface IPs, all-interfaces) instead of a fixed read-only field with a checkbox — makes it easy to expose a service on a specific secondary network adapter (e.g. a test bench connected to a different NIC)

- Services: new embedded network daemon panel accessible from the activity bar — spin up lightweight HTTP, FTP, or TFTP servers that serve a local directory with a single click; servers auto-start on launch, persist across restarts, and can be toggled, edited, duplicated, or deleted from the sidebar (#526)

- File browser: right-click a local directory → "Share via HTTP/FTP/TFTP Server" to instantly create and start an embedded server for that path and switch to the Services panel (#526)

- Status bar: running embedded services count indicator in the left section; clicking it opens the Services sidebar panel (#526)

- Settings: **Save HTML Cheat Sheet** button added to the Keyboard Shortcuts settings panel — saves a compact, self-contained A4-landscape HTML file of all shortcuts grouped by category; bindings that have been customised by the user are marked with a dagger (†) so overrides are immediately visible.

- Portable mode: termiHub now automatically detects when it is running from a USB drive or self-contained directory. If a `portable.marker` file or `data/` directory exists next to the executable (or next to the `.app` bundle on macOS), all configuration (connections, settings, tunnels, credentials, workspaces) is stored in that `data/` subfolder instead of the OS app-data directory. A "Portable" badge appears in the status bar showing the data directory path on hover. A new "Portable Mode" section in Settings displays the active status, data path, config file presence, and Export/Import buttons for migrating config between installed and portable locations. Paths can use the `{PORTABLE_DIR}` placeholder to remain valid when the drive letter or mount point changes. (#524)

- Settings: new **Language Packages** section under Editor settings — browse and install any of the ~235 Shiki/TextMate grammar packages (the same set VS Code uses) for additional syntax highlighting in the file editor; packages install immediately without a restart; the built-in packages (CMake, TOML, Nginx, Nix) are always active and listed for reference (#556)

- Settings: new **Custom Language Grammars** section under Editor settings — import your own `.tmLanguage.json` (JSON-format TextMate grammar) files to add syntax highlighting for custom or proprietary languages; grammar content is stored in settings so the original file is not needed after import; the language ID can be used in File Type Mappings to associate extensions with the grammar (#556)

- Panel zoom overlay: press `Ctrl+Shift+Enter` (macOS: `⌘⇧↵`) to temporarily expand the active terminal tab into a full-screen overlay while all other panel sessions keep running in the background. Dismiss with the same shortcut, `Escape`, or by clicking the backdrop. (#569)

- Workspaces now support multiple tab groups: save and restore a full set of named tab groups (each with its own independent split-panel layout) as a workspace. The workspace editor gains a group strip for adding, renaming, and removing groups. "Save Current" shows a scope selector (all groups vs. active only) when multiple groups are open. The workspace list shows group count for multi-group workspaces. (#566)

- Tab Groups: workspaces can now contain multiple named tab groups, each with its own independent split-panel layout. Switch instantly between groups — all PTY sessions in inactive groups stay fully alive (hidden via `display: none`). Chips appear in the toolbar left side when two or more groups exist; double-click a chip to rename, right-click for context menu, drag chips to reorder. Keyboard shortcuts: `Ctrl/Cmd+Shift+T` (new group), `Ctrl/Cmd+Shift+W` (close group), `Ctrl/Cmd+Shift+]` (next group), `Ctrl/Cmd+Shift+[` (previous group) (#546)

- File browser: new "cd here" toolbar button (terminal icon) sends `cd <current-browser-path>` to the active terminal session, making it easy to navigate the terminal to the directory you are browsing; supports local shells, remote agent sessions, and SFTP-backed SSH terminals, with automatic WSL path conversion

- File browser: toolbar now has a "Go to Terminal CWD" button (folder-sync icon) that jumps back to the terminal's current working directory after manually browsing elsewhere; the button is disabled when no CWD has been reported yet

- File browser: multi-file selection — Ctrl/Cmd+click to toggle individual files, Shift+click for range selection, plain click to select one; right-clicking a multi-selection shows bulk Copy, Cut, and Delete actions; copy/cut clipboard now supports multiple entries and paste applies each in turn (#554)

- Settings: file-type mappings editor now shows a copy button (⎘) on each built-in row to pre-fill the override form, and an "overridden" badge on rows that already have a custom mapping covering them (#498)

- Settings: language ID input in the file-type mappings editor now has autocomplete — suggestions are drawn from the full Monaco language registry (#498)

- File editor: automatic syntax highlighting for special filenames (e.g. `Dockerfile`, `Jenkinsfile`, `Makefile`) and dotfiles (e.g. `.gitignore`, `.env`, `.bashrc`) that Monaco does not detect from extensions alone; user-configurable overrides available under Settings → Editor (#498)

- Workspace editor: configurable panel sizes — click percentage badges on split children to set custom proportions, redistribute remaining space automatically, reset to equal with one click; sizes persist across save/load and apply as `defaultSize` at runtime (#544)

- Concept: Package manager for extensions and tools — design document covering repository browsing, dependency resolution, automatic updates, tool packages, and size management (#521)

- Workspaces — reusable terminal layouts with pre-configured connections that open automatically; create, edit, duplicate, delete, launch, and save the current layout as a workspace (#503)

- Workspace editor — visual layout designer for building workspace panel trees with split/tab management and connection picker (#503)

- Workspace sidebar — dedicated sidebar view in the activity bar listing all workspaces with launch, edit, duplicate, and delete actions (#503)

- Workspace CLI integration — launch a workspace by name with `--workspace`/`-w`, list all workspaces with `--list-workspaces`, or load from a JSON file with `--workspace-file` (#503)

- Workspace import/export — export workspaces as portable JSON with connection names (instead of IDs) for sharing across machines; import resolves names back to local connections (#503)

- Initial command support — workspace tabs can specify a command to run automatically after the terminal session connects (#503)

- Shell support: PowerShell (`pwsh`) detection on macOS and Linux — detects via Homebrew, snap, and apt installation paths

- Shell support: Fish and Nushell detection on macOS and Linux with proper `--login` flags

- Shell support: Custom shell path option — select "Custom..." in the shell dropdown and provide an arbitrary shell executable path

- File browser: Copy, Cut, and Paste operations for files and directories — works within local mode, within SFTP mode, and cross-mode (local↔SFTP) (#500)

- File browser: Download now available in local mode (save file to a user-chosen location via save dialog) (#500)

- File browser: Paste toolbar button with tooltip showing clipboard contents and operation type (#500)

- File Browser "Copy Name" / "Copy Path" context menu actions — right-click or use the kebab menu on any file or directory to copy its name or full path to the clipboard (#502)

- Resizable sidebar — drag the edge handle to adjust sidebar width between 170px and 600px, width persists across collapse/expand cycles (#499)

- `scripts/test-system.cmd` — Windows cmd.exe dispatcher for system tests; delegates to `test-system-windows.sh` via Git Bash or WSL, enabling `scripts\test-system.cmd --skip-serial --skip-e2e` from a standard Windows terminal (#462)

- Podman support in `test-system-windows.sh` — compose availability check with actionable error, `podman.exe` detection for Git Bash contexts, and `--skip-serial` flag accepted as a no-op for cross-platform compatibility (#462)

- Podman-on-Windows BuildKit auto-detection in `test-system-windows.sh` — detects when Podman is in use without `docker buildx` (no Docker Desktop), auto-skips integration tests with a clear explanation, and continues running unit tests; eliminates cryptic `docker-compose.exe` failures when Docker Desktop is absent (#462)

- E2E tests for local file browser MT-FB-01 (Browse local files) and MT-FB-02 (Navigate directories) — covers toolbar visibility, current path display, file entry listing, Up button navigation, double-click directory entry, and round-trip navigation; manual test YAML updated with automation coverage notes (#460)

- E2E tests for tab management MT-TAB-01 through MT-TAB-04 — covers open tab from connection (double-click and context menu), close tab, rename tab, and switch between tabs; manual test YAML restructured with updated IDs for remaining drag and save-to-file tests (#459)

- E2E tests for connection management CRUD scenarios MT-CONN-01 through MT-CONN-08 — covers create local/SSH connection, edit, delete, create folder, move connection to folder, and import/export menu flow; manual test YAML updated with automation coverage notes (#458)

- SSH key-based authentication E2E test (SSH-02) — Docker entrypoint generates an ed25519 key pair shared with the test runner via a Docker volume, enabling key-based auth tests in both Linux-native and Docker E2E environments (#485)

- `test-system-windows.cmd` wrapper for running Windows system tests from a native CMD prompt (delegates to WSL or Git Bash)

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

- Environment variable placeholders in connection settings: use `${VAR}` syntax for shared configs (originally `${env:VAR}`; updated to standard shell syntax in #726)

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

### Changed

- Testing: **removed the per-suite / per-category test-count columns from `docs/testing.md`.** The hand-maintained numbers provided no decision value (nobody acts on "SSH Auth: 15 tests") yet were a recurring cost: every branch that added or removed a test edited the same numeric cells, so the tables conflicted on nearly every merge, and the counts had already drifted into self-contradiction (the manual **Total** said `155` while its rows summed to `158` and the YAML files held `162`). The Test Suites and Manual Test Categories tables stay as an index — **File**/**YAML**, **Docker Containers**, **ID Prefix**, and **Description** columns are stable and describe _what_ is covered — just without the brittle counts. The test files and `tests/manual/*.yaml` remain the source of truth for how many.

- Testing: **parallel test isolation — several checkouts can now run all of their test environments at once without conflict.** A committed `default.dev.local.json` template (copy to the gitignored `dev.local.json`) adds two keys to the existing `dev_port`/`dev_agent_port`/`dev_name`: **`compose_project`** (namespaces every Docker container, network and volume) and **`test_port_offset`** (added to every published / looked-up test port). A single resolver — `termihub_harness.dev_local` (Python) and `scripts/internal/dev-local-env.sh` (shell) — turns those into a canonical env contract that every entry point honours: `tests/docker/docker-compose.yml` (and the `examples/docker` quick-start target) interpolate the project name and offset ports; the Python bridge harness brings containers up under `-p <project>` on matching ports; the Rust integration tests resolve their container ports from `TERMIHUB_TEST_*_PORT` and address the jump-host hops by their Compose service-name aliases / the network-fault container by `<project>-network-fault`; `scripts/test*.sh` source the resolver; the virtual serial PTYs are project-suffixed; and `tauri-driver` (E2E) takes `4444 + offset`. Every default reproduces the historical single-checkout behaviour exactly, so CI and a lone checkout need no config. See [`docs/testing.md`](docs/testing.md) → _Parallel test isolation_.

- Testing: **the Embedded Services live FTP/TFTP transfer checks (SVC-12 / SVC-13) no longer depend on the host's `curl` build.** They previously shelled out to `curl ftp://…` / `curl tftp://…`, but `curl`'s TFTP — and sometimes FTP — support is build-dependent, so on hosts shipping a `curl` without `tftp://` the TFTP transfer case (SVC-13) silently **skipped** instead of verifying the download. FTP now uses Python's stdlib `ftplib` and TFTP uses the maintained `tftpy` library (new `termihub_harness.transfers` helpers), making both transfers deterministically verified on Linux/macOS/Windows CI. Added a new app-independent test (`tests/system/tests/test_transfer_checkers.py`) that exercises the checkers against in-process `tftpy` / `pyftpdlib` servers, plus `tftpy` (required) and `pyftpdlib` (test-only) to `tests/system/requirements.txt`. (Closes #964)

- Testing: **removed the unreachable `serial-echo` Docker fixture** (`tests/docker/serial-echo/` and its `serial-echo` service + `serial-ports` volume). Its socat virtual serial ports lived inside a named Docker volume, so a host-native termiHub could never open them — the actual host serial-testing path creates socat PTYs directly on the host via `scripts/test-system.sh` (and `examples/serial/`). The container was dead infrastructure left over from an in-container test-runner design; the docs (`tests/docker/README.md`, `docs/testing.md`) no longer imply the host app uses it. (Closes #859)

- Serial: the **serial port field is now an editable combobox** instead of a detection-only dropdown. Detected ports are still offered as one-click suggestions (via a native `<datalist>`), but you can now **type any device path** — a path the OS does not enumerate (an uncommon `/dev` node, a virtual/socat PTY), or a port on a machine where detection comes up empty — matching the field's "select a detected serial port, or type a device path directly" intent. A "not connected" hint still flags a value that is not a currently-detected port. (Closes #854)

- Terminal: added a small horizontal inset (8 px) inside the terminal viewport so the first and last characters of each line are no longer flush against the container edge or the vertical scrollbar. This makes it easier to drag-select characters at the line edges. xterm's FitAddon reads the padding so column counts remain accurate; horizontal-scroll mode keeps zero padding to avoid clipping the imperatively sized canvas.

- **Breaking — Keyboard shortcuts**: Windows/Linux defaults relocated to avoid common shell, tmux, vim, and SSH-to-remote conflicts. `Toggle Sidebar` → `Ctrl+Shift+B` (was `Ctrl+B`; freed up for tmux prefix), `Close Tab` → `Ctrl+Shift+W` (was `Ctrl+W`; freed up for readline `delete-word-backward` and vim `<C-w>` window prefix), `Close Tab Group` → `Ctrl+Shift+Q` (was `Ctrl+Shift+W`), `Split Right` → `Alt+Shift+\` (was `Ctrl+\`; freed up for SIGQUIT), `Split Down` → `Alt+Shift+-` (was `Ctrl+Shift+\`), `Focus Panel ↑↓←→` → `Alt+Shift+<Arrow>` (was `Ctrl+Alt+<Arrow>`; freed up for GNOME/KDE workspace switching), `Keyboard Shortcuts` → `F1` (was `Ctrl+K Ctrl+S`; the chord leader `Ctrl+K` is readline `kill-to-end-of-line`). macOS Cmd-based bindings are unchanged. Users who prefer the old IDE-style shortcuts can rebind via Settings → Keyboard Shortcuts. See [`docs/keyboard-shortcuts.md`](docs/keyboard-shortcuts.md).

- Serial: replaced the `serialport` crate with [`serial2`](https://crates.io/crates/serial2) / [`serial2-tokio`](https://crates.io/crates/serial2-tokio). Serial I/O is now fully async (no `std::thread` bridge, no `Arc<Mutex<Box<dyn SerialPort>>>`); a dedicated writer task drains a channel so the sync `write()` trait method stays non-blocking. Agent musl cross-compilation targets (x86_64/aarch64/armv7) no longer require `libudev`. Removes ~15 transitive dependencies.

- Embedded servers: the hand-rolled ~490-line RFC 959 FTP server has been replaced by [`libunftp`](https://crates.io/crates/libunftp) 0.20 backed by [`unftp-sbe-fs`](https://crates.io/crates/unftp-sbe-fs) 0.2. The new implementation is async/tokio-based (using a per-thread runtime to stay compatible with the existing `EmbeddedServerManager` thread model), preserves all existing config options (root directory, optional credentials, read-only mode, bind address, port), and tracks connection and transfer stats via libunftp's notification hooks. Passive mode, authentication, and path sandboxing are handled by the library. Closes #728.

- **Breaking — Connection config placeholders**: environment-variable placeholders in connection fields have changed from `${env:VAR}` to standard shell syntax `${VAR}` (also `$VAR`), now backed by the [`shellexpand`](https://crates.io/crates/shellexpand) crate. Unknown variables now expand to an empty string instead of being left as the literal placeholder. Existing connections that used `${env:VAR}` must be edited to use `${VAR}`. Tilde expansion (`~` / `~/...`) is unchanged. Closes #726.

- Agent: the hand-rolled JSON-RPC 2.0 dispatch layer (~5 k LOC) has been replaced by [`jsonrpsee`](https://crates.io/crates/jsonrpsee) 0.24. All 35 protocol methods are now registered via `RpcModule`; routing, error formatting, and response serialisation are handled by the library. Custom request/response/error structs in `core/src/protocol/` have been removed; only `JsonRpcNotification` (agent → desktop push) remains. Closes #727.

- Core: the internal `RingBuffer` (1 MiB capture buffer used by serial sessions and the agent daemon) is now backed by the [`ringbuf`](https://crates.io/crates/ringbuf) crate (`HeapRb<u8>`) instead of a custom circular-byte-buffer implementation. Public API is unchanged. The wrapper now uses `HeapRb` directly (no producer/consumer split) and delegates `write()` to `push_slice_overwrite`, reducing the implementation from ~60 to ~40 lines.

- Core: the ANSI screen-clear detector used to gate startup-output buffering is now backed by the [`vte`](https://crates.io/crates/vte) crate (the canonical Rust VT parser, maintained by the Alacritty team) instead of a hand-rolled byte-window substring scan. The new stateful `ScreenClearDetector` retains parser state across `feed()` calls, so escape sequences split across chunk boundaries are detected correctly; the session manager no longer needs to re-scan the cumulative startup buffer on every chunk. Also adds detection of `CSI 3 J` (xterm "erase display + scrollback") which the substring scanner missed. Closes #729.

- SSH backend: replaced `ssh2` (C-backed, vendored OpenSSL) with `russh` (pure-Rust async SSH) across the core library, src-tauri desktop backend, and agent crate. All SSH authentication methods (password, RSA/Ed25519/ECDSA keys, keys with passphrase, SSH agent), SFTP, port forwarding (local, remote, dynamic SOCKS5), X11 forwarding, and monitoring continue to work; no user-visible behaviour changes.

- Cross-compilation: agent cross-build Docker images (x86_64/aarch64/armv7 musl) no longer pre-build static OpenSSL. The `russh` switch removed the last C-crypto dependency from the agent (`openssl-sys` is gone from `Cargo.lock`); the custom images now only install `libudev-dev` (required by `serialport`). Build times for fresh image layers drop by ~2 minutes per target. `libssl-dev` has been removed from Ubuntu CI job dependencies for the same reason.

- Settings: "Updates" and "About" are no longer sub-tabs inside the Settings panel. They are now direct entries in the settings gear dropdown menu and open in a focused overlay panel instead.

- CI: upgraded `docker/setup-buildx-action` from v3 to v4 and `docker/build-push-action` from v5 to v7 (Node.js 24); upgraded `pnpm/action-setup` from v5 to v6; upgraded CI Node.js version from 20 to 22 (LTS) — eliminates all "Node.js 20 actions are deprecated" warnings in GitHub Actions runs.

- CI: replaced hardcoded `--platform=linux/amd64` with `--platform=$BUILDPLATFORM` in all three agent cross-compilation Dockerfiles — eliminates `FromPlatformFlagConstDisallowed` Docker lint warnings.

- Connection sidebar: the expand/collapse chevron for folders is now displayed on the right side of the folder row. This aligns folder icons and connection icons in the same column at each indent level, making the tree hierarchy unambiguous at a glance (#640).

- Settings: all settings panels and connection editor tabs now use a consistent visual design — fields are grouped under titled category sections, boolean options use a pill toggle switch (label on top, toggle below, hint text underneath), and spacing between fields is uniform across the entire UI.

- Connection editor: the Connection tab is now structured in named sections (General, schema-defined groups, Session, External Files), matching the look and feel of all other tabs.

- File browser: toolbar now shows the current directory path on its own line, with action buttons on a second line that wraps when the panel is narrow

- Terminal disconnect overlay: the Dismiss button is now labelled "View Scrollback" and keeps the session marked as ended (instead of silently clearing the state). After dismissing, a thin non-blocking banner at the bottom of the terminal indicates the session is dead and offers a Reconnect button, while the full terminal content remains selectable and copyable.

- Terminal disconnect overlay: pressing Enter while in view mode (scrollback-only) now opens a small reconnect prompt instead of sending the keystroke to the dead session. The prompt offers "Reconnect" and "Stay in View Mode" choices.

- Terminal disconnect overlay: the overlay now has three distinct variants — a spinner overlay while the agent is auto-reconnecting, an error-state overlay (with error details and a "Try Again" button) when all reconnect attempts have been exhausted, and the standard "Session disconnected" overlay for normal exits.

- Agent: when the automatic reconnect loop exhausts all retries, the disconnect overlay now shows the reason (e.g. "Failed to reconnect after 10 attempts") so the user knows why the reconnect stopped.

- Agent: tabs belonging to a reconnecting agent now show a "Reconnecting…" spinner overlay during automatic reconnect attempts, so the terminal no longer appears frozen/dead while recovery is in progress.

- SSH: Shell Integration and X11 Forwarding now default to enabled for new connections

- Settings: General settings now include SSH defaults section to control whether Shell Integration and X11 Forwarding are pre-enabled for new SSH connections

- UI: Remote Agents now have their own collapsible "Remote Agents" section header in the connections sidebar, with a dedicated "+" button for adding new agents

- UI: "Remote Agent" removed as a connection type from the connection type dropdown — agents are managed exclusively through the Remote Agents section

- UI: The connection type selector is hidden when editing remote agent SSH transport settings (it was always "remote" and had no meaning there)

- DI testing infrastructure: extracted `LocalShellSpawner`, `SshConnector`, `SessionManagerApi`, `DaemonLauncher`, `ConnectionStoreApi`, `MonitoringManagerApi`, `EventEmitter`, and `AgentRpcClient` traits across `core`, `agent`, and `src-tauri`. Concrete types are unchanged; tests can now inject mocks without real PTY/SSH/Tauri runtimes. Tauri agent commands now depend on `Arc<dyn AgentRpcClient>` in state.

- UI: Comprehensive design refresh — new Geist typeface, deeper cool-tinted dark palette, generous border radii (4–14 px), richer multi-layer shadows, and premium `cubic-bezier(0.16, 1, 0.3, 1)` transitions throughout

- UI: All dialogs now animate in with a smooth scale-up fade (CSS `@keyframes`) and feature frosted-glass overlays (`backdrop-filter: blur(8px)`)

- UI: Primary buttons have tactile press feedback (`translateY + scale(0.98)`) and a soft glow shadow on hover; secondary buttons have smooth hover transitions

- UI: All dropdown menus (settings gear, context menus, status bar pickers) use refined rounded-item hover instead of the jarring full-accent-blue fill

- UI: Input fields gain a focus glow ring (`box-shadow: 0 0 0 3px rgba(61, 125, 232, 0.22)`) across all dialogs and settings panels

- UI: Settings nav items use rounded-pill active highlight instead of a bare left-border indicator

- UI: Toggle switches enlarged (34 × 20 px) with smoother spring-like transition

- Terminal: the panel zoom overlay (Cmd+Shift+Enter / Ctrl+Shift+Enter) now works for **all tab types** — file editors, settings, log viewer, connection/tunnel/workspace editors, and network diagnostics can all be zoomed, with the same overlay look and feel (dark backdrop, header bar with icon/title/hint, close button) as terminal zoom

- Terminal: the zoom overlay now **follows panel and tab-group focus** — switching between split panels or tab groups while a tab is zoomed moves the overlay to show the active tab of the newly focused panel/group rather than dismissing it

- Terminal: right-clicking a non-terminal tab (file editor, settings, etc.) now shows a context menu with **Set Color…** to colorize the tab

- Shell integration (OSC 7 CWD tracking) is now **visible by default**: the setup command runs in the terminal at startup with a `# [termiHub] Shell integration: setting up OSC 7 CWD tracking` notice, instead of being silently erased. This applies to local bash, SSH, and WSL connections.

- WSL: the setup script no longer contains erase sequences; the `source` command and the echo notice are left visible in the terminal.

- Test coverage: added 16 new test files covering previously untested services (`networkApi`, `tunnelApi`, `embeddedServerApi`, `storage`), hooks (`useConnections`, `useTerminal`, `useCredentialStoreEvents`, `useEmbeddedServerEvents`, `useTunnelEvents`, `useFileBrowser`, `useLocalFileSystem`, `useSectionResize`, `useKeyboardShortcuts`), utilities (`frontendLog`), and components (`PortableBadge`, `PortableModeSettings`) — bringing frontend unit test coverage from ~52% to ~75%

- E2E test coverage: added live network tools tests (`MT-NET-10, 12–14, 17–18`) against a controlled nginx target, FTP/TFTP actual transfer tests (`MT-SVC-04, 05`) using curl, and a `network-target` Docker/Podman container for deterministic live tests

- File Browser menus unified — the three-dot kebab dropdown now uses the same Radix DropdownMenu component and shared CSS classes as the right-click context menu, giving both menus identical styling (accent hover, separator before Rename/Delete, danger highlight on Delete) (#501)

- Scripts directory reorganized — internal helpers (`autoformat.sh`, `kill-port.cjs`) moved to `scripts/internal/` to separate them from user-facing dev scripts

- Agent cross-compilation reduced from 6 targets (3 glibc + 3 musl) to 2 static musl-only targets (`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`) — agent binaries are now fully portable with zero runtime dependencies; removed armv7 and all glibc targets from build scripts, CI, and release workflows

- Focus Next/Previous Panel shortcuts replaced with directional panel navigation — Cmd/Ctrl+Alt+Arrow keys now navigate up/down/left/right between split panels (#445)

- Clear Terminal macOS shortcut changed from Cmd+K to Cmd+Shift+K to avoid conflict with the Keyboard Shortcuts chord (Cmd+K Cmd+S) (#445)

- Terminal right-click context menu now shows "Copy Selection" first when text is selected, otherwise "Paste" is the first option — previously "Copy All" appeared before "Paste" (#425)

- Docker connection editor now filters the Runtime dropdown to only show runtimes installed on the system; when only one runtime is available, the dropdown is auto-selected and locked (#440)

- **Breaking**: Reworked connection data model from flat arrays with synthetic IDs to a nested tree format on disk — connections and folders no longer have IDs in the stored JSON; identity is determined by name within the parent folder (like a filesystem), eliminating ID collisions when sharing connection files via git; path-based IDs are generated deterministically at load time for in-memory use; duplicate sibling names are auto-renamed with `(1)`, `(2)` suffixes; credentials are auto-migrated when connections are renamed or moved (#385)

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

- Reorganized Rust crates into a Cargo workspace with a new shared `termihub-core` crate (empty scaffolding for future code sharing between desktop and agent) (#283)

- `ConnectionManager` now routes credentials to the active `CredentialStore` via `prepare_for_storage` before stripping passwords on disk — with `NullStore` as default, behavior is identical to before; credentials are cleaned up when connections or agents are deleted (#249)

- Split view panels now have a visible 1px border between them, making it easier to distinguish adjacent panels (#189)

- Active tabs now show a colored top border: bright blue in the focused panel, dimmed in unfocused panels, following VS Code's tab highlight pattern (#190)

- External connection files now display in a unified tree alongside local connections instead of separate sections; storage location is configurable via an Advanced dropdown in the connection editor (#210)

- Renamed "TermiHub" to "termiHub" throughout the project (documentation, window title, CI artifacts, scripts) to reflect the intended lowercase branding

- Remote connections redesigned: the flat "Remote" connection type is replaced by a two-level model — remote agents (SSH transport) contain child sessions (shell/serial)

- Remote Agent settings form now only shows SSH transport fields; session configuration is separate

- Removed folder selector from the connection editor; use drag-and-drop in the sidebar to organize connections into folders

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

### Removed

- OS Keychain credential backend removed — the `keyring` crate dependency and `KeychainStore` backend have been dropped. Credential storage now offers **Master Password** (Argon2id + AES-256-GCM encrypted file) and **None** (prompt-only). Users with `"keychain"` saved in `settings.json` will be migrated to `"none"` on next launch.

- Old `RemoteConfig` type and `RemoteSettings` component (replaced by `RemoteAgentConfig` + `RemoteSessionConfig`)

- Old `RemoteBackend` Rust implementation (replaced by `AgentConnectionManager` + `RemoteSessionBackend`)

### Fixed

- Network Tools: **the HTTP monitor no longer misses its immediate first check.** When a monitor starts, the backend runs an immediate first check before the first interval sleep (`http_monitor.rs` calls `check_once` up front). But `HttpMonitorPanel` attached its `network-http-monitor-check` listener in a `useEffect` gated on `activeMonitorId`, which is set only **after** `networkHttpMonitorStart` resolves — so if that immediate check fired before the listener attached, the panel missed it and showed an empty history/chart for up to one interval (default 30s). The panel now registers the listener **before** issuing the start command and filters by an id ref set synchronously the moment start resolves (mirroring `PingPanel`), so the first check always lands; the listener is torn down on stop/restart/unmount. The live test `test_network_tools_live.py` drops its 45s `FIRST_CHECK_TIMEOUT` workaround back to the default ~20s wait. (Closes #1002)

- Testing: **the in-app test bridge no longer drops its connection during startup on Windows.** The bridge's runner WebSocket was opened in a React effect inside `TestBridge`, which renders within `TerminalView` — a subtree that remounts once at startup as the persisted layout config settles. That remount ran the effect cleanup (closing the socket) and reopened a fresh one, so a runner bound to the first connection (`Bridge.wait_for_app`) saw it drop with "bridge connection closed" moments after the app appeared. On a slow WebView2 cold start the socket connects before the layout settles, so the drop was reliable on Windows and made **every** Python-bridge integration test fail there (macOS/Linux webviews settled before connecting, so they were unaffected). The socket is now a page-lifetime module singleton (closed on `beforeunload`) with the live dispatch swapped in on each (re)mount, so a transient remount no longer touches it. (Part of #1019; the harness-side resilience follows in a separate change.)

- Testing: **the live SSH tunnel start/stop system tests no longer hang on macOS Docker.** The three tests in `tests/system/tests/test_ssh_tunnels.py` that actually start a tunnel (`test_save_and_start_connects`, `test_start_then_stop`, `test_tunnel_runs_alongside_an_ssh_session`) timed out on macOS because Docker Desktop runs containers inside a Linux VM with no host networking — so the host-native app's russh local-forward to the published `ssh-tunnel-target` port never drove the tunnel to a running state, unlike Linux Docker. They are now skipped on macOS (Darwin) with a clear reason and keep running in the Linux integration-fixtures CI lane, mirroring the E2E `tauri-driver` macOS carve-out (ADR-5); the editor/list tests (TUNNEL-01..10, which need no running tunnel) stay enabled on every platform. macOS tunnel behaviour is verified via the manual steps documented in `docs/testing.md`. (Closes #933)

- Network Tools: **the sidebar's Monitors list now live-updates when a monitor is started while the sidebar is open.** `NetworkToolsSidebar` only refreshed its list on mount, on the manual Refresh button, and after a stop — it didn't subscribe to the live `network-http-monitor-check` event — so a monitor started from a panel while the sidebar was already mounted kept showing "No monitors running" until a forced remount/refresh/stop. The sidebar now subscribes to the check event and refetches on each check (the first fires immediately on start), so a newly started monitor appears reactively and running monitors' status/latency stay current. The live test `test_network_tools_live.py::test_http_monitor_shows_in_sidebar` (#946) drops its remount workaround and now asserts against the already-open sidebar. (Closes #986)

- Network Tools: **starting an HTTP monitor no longer crashes the app.** `network_http_monitor_start` is a synchronous Tauri command, so it runs on a thread with no Tokio reactor; `http_monitor::start_monitor` spawned the polling task with `tokio::spawn`, which panicked ("there is no reactor running") and aborted the whole process the moment a monitor was started. It now uses `tauri::async_runtime::spawn`, which works from any thread (the established pattern elsewhere, per #828). Surfaced by the live Network Tools port (#946); guarded by `test_network_tools_live.py::test_http_monitor_check_and_chart` (a Rust unit test is impractical — `start_monitor` needs a real `AppHandle`). (Closes #982)

- SSH jump host: **"Open Jump Host Terminal" no longer prompts for a password-auth bastion that already has one configured.** The synthesized gateway connection used a synthetic id (`<id>::jump-host`), and the connect path always resolved credentials from the store by connection id — a synthetic id never matches, so a password-auth bastion (its password stored inline on the hop) re-prompted at connect time. The connect path now uses an inline password already on the config directly, so opening a jump-host terminal reuses the hop's configured password instead of prompting. (Closes #963)

- File editor: **a tab whose file failed to load (e.g. the connection dropped) can now always be closed.** Previously, when a remote file's editor switched to the "Failed to load file" error view, the tab could get stuck open — the error-only view doesn't render the unsaved-changes dialog, so if the tab was still marked dirty (e.g. it had edits before the connection dropped), the close prompt could never be answered. A failed-to-load tab now clears its dirty flag (it has nothing to save) and immediately honors any pending close request, so it closes cleanly even when the underlying connection is dead. (Closes #971)

- SFTP / file editor: **a remote save that fails (e.g. permission denied) now surfaces a clear error instead of failing silently.** Editing a remote file over SFTP in the built-in editor and saving one the connecting user can't write (e.g. a root-owned file on a Raspberry Pi) previously only logged to the dev console — the UI gave no feedback, so it looked like the save had succeeded. The editor now shows a dismissible error banner above the buffer (permission failures get a friendly "you don't have write access" message; other errors show the underlying cause), and the buffer stays marked unsaved/dirty so the change isn't lost and can be retried. (Closes #969)

- Embedded servers: **the HTTP server now serves individual file downloads when directory listing is enabled.** With listing on (the default for HTTP), the directory index rendered (`GET /` → 200) but downloading a listed file 404'd — the `/*path` catch-all route sent every request to the directory-listing handler, which returned 404 for non-directories even though its comment claimed `ServeDir` would serve them; because the catch-all already matched, the fallback `ServeDir` never ran. Files are now routed through `ServeDir` directly, with the listing handler used only as `ServeDir`'s fallback for paths it cannot serve as a file (real directories render the generated index; missing paths 404). Index-file auto-serving stays disabled so directories always render the listing, preserving prior behavior. (Closes #961)

- SSH: **a hung intermediate jump host no longer blocks a ProxyJump connection indefinitely.** `connect_through_jump_hosts` only bounded the **first** hop (via the `connect_and_authenticate` connect timeout from #841); every subsequent hop and the final target were reached over the channel-based connect path, which had **no timeout and no cancellation** — so a hung/blackholed intermediate hop, or an unreachable target behind a reachable bastion, blocked the whole chain forever. Each hop step (open the `direct-tcpip` channel + handshake) is now bounded by that hop's **connect timeout** (OpenSSH-like per-hop budget) and aborts promptly if the connection is torn down mid-connect, and the error **names which hop** timed out. (Closes #938)

- SSH: **a passphrase-protected key now connects even when "Save password" is off**, and an **unencrypted key no longer triggers a spurious passphrase prompt**. Both connect paths (the editor's Save & Connect and the sidebar double-click) previously decided whether to prompt for a key passphrase from the `savePassword` flag — so an encrypted key with save off silently failed to unlock (russh got no passphrase), and the only workaround was to enable "Save password" first. The decision is now based on the key file's **actual encryption**, detected by a new read-only backend check (`is_ssh_key_encrypted`) that reads the cipher from OpenSSH-format keys (via the `ssh-key` crate) and the `Proc-Type`/`ENCRYPTED` headers from legacy PEM and PKCS#8 keys. An encrypted key always prompts (regardless of save), an unencrypted key never does, and on a key-file read error the app prompts rather than failing silently. Whether the entered passphrase is stored still follows the prompt's Save box. (Closes #885)

- Testing: **un-skipped the two "General defaults pre-fill new SSH connection" system tests (#889).** The reported regression — Settings → General **Default User / Default SSH Key** not reaching a new SSH connection — was a **harness race**, not a product bug: `buildTypeDefaults` applies the defaults correctly. `_set_general_defaults` waited on the live `settings` store slice (written immediately on keystroke) and then closed the settings tab before the **debounced** persist committed; the tab was still dirty, so `close_all_tabs`' unsaved-changes "just close" **discarded** the typed values. The helper now waits on the persisted `savedSettings` snapshot, so the tab is clean before it closes and the defaults survive. The companion `test_default_user_only_keeps_password_auth` also encoded the pre-schema PR #201 default (`authMethod = "password"`); the schema-driven SSH config now defaults to `key`, so it was renamed and updated to assert the schema default. (Closes #889)

- UI: **restored the inline SSH key-file validation hint in the connection editor** (PR #204 behavior dropped as collateral of the #362 schema-driven refactor). Selecting or typing a key path now shows immediate feedback again — it flags a public key (`.pub`), a PuTTY PPK file, an unrecognized format, or a missing file, and confirms a valid OpenSSH/PEM private key — before you attempt to connect. The backend `validate_ssh_key` command (and its tests) had survived the refactor; only the UI that called it was gone. The hint is now rendered by `KeyPathInput` with a stable `data-testid` so the bridge harness can cover it. (Closes #896)

- UI: **re-wired `host:port` auto-extraction in the connection editor's Host field** (PR #195 behavior that had silently regressed). `parseHostPort` was implemented and unit-tested but no longer imported anywhere, so typing e.g. `192.168.0.2:2222` (or a bracketed IPv6 `[::1]:2022`) into the Host field stopped splitting the port out. Blurring the Host field now extracts the port into the Port field again; bare hostnames and bare IPv6 addresses are left untouched, and the split only happens for connection types whose schema has a sibling port field. (Closes #895)

- Testing: **de-flaked the `agent_handles_multiple_sequential_connections` agent integration test on Windows CI.** The `initialize` / `connection.list` RPC round-trips in `agent/tests/local_agent_integration.rs` set a tight **5 s** read timeout, so a loaded Windows runner — where the agent's cold start and first response can momentarily exceed a few seconds — intermittently failed with `read_line failed: TimedOut (os error 10060)`. The three RPC sites now share an `RPC_READ_TIMEOUT` of **30 s** (matching the readiness probe and the #847 daemon-connect bump); a higher ceiling never slows the passing path, since the read returns as soon as the response arrives. This is the same class of Windows-CI timeout #847 fixed for the `shell_session_*` tests, in a sibling test it didn't cover.

- Testing: **de-flaked `TerminalUi.ensure_terminal` against the post-`restart_app` focus race.** The editor and local-file-browser system suites restart the app per test for clean isolation; intermittently — and especially under machine load — the first `ensure_terminal()` after a restart timed out at 20 s waiting for the shell prompt, even though the shell had started. The freshly-spawned terminal can briefly not be the _active_ tab, so reading the active-tab default (`read_terminal()` with no id) saw an empty/other buffer. `ensure_terminal` now enumerates terminal tabs and reads each **by id**, accepting a prompt on any of them, which sidesteps the focus race; `has_terminal()` keeps its active-tab semantics (the SSH/telnet suites rely on it for second-connection waits). The shared panel-tree walk is factored into a unit-tested `iter_tabs` helper. (Closes #867)

- Testing (DX): **`cargo test -p termihub-core` (no extra flags) compiles again.** The Docker-dependent integration tests in `core/tests/` use backend APIs gated behind cargo features, but the files themselves were not gated, so a plain `cargo test -p termihub-core` failed to _compile_ with a wall of confusing `[u8]`/type-inference errors that masked the real cause (a missing `--all-features`) — it cost real debugging time during the #858 fixture audit. Each file is now gated with the feature it actually needs (`#![cfg(feature = "ssh")]`, and `#![cfg(all(feature = "ssh", feature = "telnet"))]` for the telnet suite — these tests connect _over_ SSH/telnet to the containers, they don't use the `docker`/bollard API), so without those features they compile to a clean no-op and the unit tests run; `--all-features` still builds and runs the full integration suite unchanged. (Closes #868)

- Credentials: **the connection editor's "Save & Connect" now honors the password prompt's "Save password" checkbox.** Connecting from the editor raised the password prompt but — unlike connecting from the sidebar — never persisted the entered password, so the credential was silently dropped and the next connect prompted again. Save & Connect now stores the credential when the prompt's save box is checked (under the connection's persisted id, per the reconciliation below), matching the sidebar connect path. (Closes #874)

- SSH/Credentials: **the connection editor's "Save & Connect" can now connect a passphrase-protected SSH key.** Save & Connect decided whether to prompt via `findPasswordPromptInfo`, which only matches a _visible_ password field — but for SSH **key auth** the password field is hidden, so it never prompted for a key passphrase. A passphrase-protected key connected from the editor (with no passphrase already in the vault) therefore reached the backend with no passphrase and failed to authenticate; the only working path was the sidebar double-click. Save & Connect now also prompts for the key passphrase (when the editor's "Save password" is on and none is stored, mirroring the sidebar connect path), connects, and — when the prompt's save box is checked — stores it as `key_passphrase` under the connection's persisted id. (Closes #879)

- Testing: **repaired the four integration-fixture gaps surfaced by the Docker-fixtures lane (#858) and made the suite parallel-safe in-source.** The `sftp-stress` container now provides the symlink and unicode files the tests expect — `symlinks/valid-file-link`, `symlinks/valid-dir-link`, and a U+1F600 emoji-named `special-names/😀_emoji.txt` (the generator only created differently-named equivalents, so `SFTP-STRESS-07/08/11` failed to open them). The `ssh-jumphost-bastion` container now also installs the **ed25519 private key** at `/home/testuser/.ssh/ed25519`: `SSH-JUMP-01` hops bastion→target with `ssh -i .../ed25519`, but the bastion only had `authorized_keys`, so the inner ssh failed auth and returned an empty marker instead of `JUMPHOST_TARGET_REACHED`. All four tests are un-`#[ignore]`d. The `network_resilience` suite — whose tests collide on the shared `network-fault-proxy` `tc` qdisc under cargo's default parallel execution (`Exclusivity flag on, cannot modify`) — is now serialized in-source with `serial_test`'s `#[serial(network_fault)]`, so the suite is parallel-safe regardless of `--test-threads` (the CI lane keeps `--test-threads=1` as belt-and-braces). (Closes #864)

- Credentials: **a saved password could be orphaned when a brand-new connection was connected in the instant right after it was created.** The editor assigns an optimistic `conn-<timestamp>` id and the backend replaces it with a stable, name-derived id on save; if a connect fired before the post-save reload reconciled that swap, the credential was stored under the stale optimistic id and never resolved again (the next connect re-prompted despite "Save password" being checked). The save backend (`save_connection`) now **returns the persisted id**, and the store reconciles the in-memory connection to it immediately, so a credential is always keyed to the id the reconnect resolves. (Closes #863) The same reconciliation now also applies when a connection is **renamed** (`updateConnection`), which changes its name-derived id the same way. (Closes #875)

- Agent: **persistent (local-shell) session creation is more robust when the session daemon is slow to start or fails to start.** Creating a persistent session spawns a daemon subprocess and connects to its endpoint (Unix socket / Windows named pipe); the client only waited 5 s for the endpoint to appear, and if the daemon **died before binding** (e.g. its shell failed to spawn) the client kept retrying a phantom "endpoint not found" for the full window and surfaced a misleading low-level error (on Windows, `connection.create` failing with "The system cannot find the file specified. (os error 2)"). The connect timeout is now 30 s (daemon cold-start — detached process + ConPTY shell — can exceed 5 s on a loaded machine), and the launcher races the connect against the daemon process exiting so a daemon that dies before binding **fails fast with its real exit status** instead of a generic OS error; a daemon that never becomes usable is now killed rather than orphaned. This also fixes the flaky Windows `local_agent_integration` `shell_session_*` tests. (Closes #847)

- SSH/Tunnel: **connecting to an unreachable SSH host now fails fast, and stopping a tunnel that is still connecting is now prompt** instead of hanging until the OS TCP timeout. The connect path used a blocking `std` TCP connect driven via `block_on`, so it had no connect/handshake timeout and ignored the cooperative cancel flag added in #829 — a tunnel (or any SSH session) against a dead host blocked for the full OS TCP timeout, and a Stop during `connecting` could only take effect after that blocking handshake returned. The connect is now an async `tokio` connect wrapped in a bounded **connect timeout** (configurable per connection via the new **Connection → Advanced → Connect Timeout (s)** field; default 20 s), and the tunnel's connecting-phase cancel flag is now a `CancellationToken` threaded into the connect so a Stop **aborts the in-flight handshake immediately** rather than waiting it out. The timeout applies to all SSH connects (tunnels, SFTP, monitoring, agent deploy/setup). (Closes #841)

- Testing: fixed three failing/flaky SSH-auth integration tests (`core/tests/ssh_auth.rs`). The **ECDSA-384 and ECDSA-521 passphrase** key fixtures were stored in legacy encrypted PEM/SEC1 (`-----BEGIN EC PRIVATE KEY-----`) format — a leftover from the libssh2 era that the current russh-based loader cannot decrypt (it misparses it as PKCS#1); they are now stored in OpenSSH format (same keypair, so `authorized_keys` is unchanged) like every other fixture. The **ECDSA-256 key** test was intermittently failing with `SSH handshake failed: Disconnected` because the ~12 key-auth tests open connections to the single `ssh-keys` container concurrently and exceeded OpenSSH's default `MaxStartups` (10:30:100); the container now sets `MaxStartups 100:30:200`.

- SSH: **passphrase-protected ECDSA keys in legacy PEM format now load again**. Keys saved as `-----BEGIN EC PRIVATE KEY-----` and encrypted with OpenSSL's traditional `Proc-Type/DEK-Info` scheme (e.g. `ssh-keygen -m PEM` or `openssl ec -aes128`) failed with a misleading `Pkcs1: ... expected INTEGER, got OCTET STRING` after the russh 0.61 upgrade: russh decrypts the AES-CBC body but then parses the plaintext **only as PKCS#1 RSA**, so any SEC1 EC key was rejected. termiHub now falls back to a native loader (`core/src/backends/ssh/legacy_pem.rs`) that decrypts the body (OpenSSL MD5 `EVP_BytesToKey` + AES-128/192/256-CBC) and parses the SEC1 key for NIST P-256/384/521 — including keys that use OpenSSL's _explicit_ curve parameters and short (leading-zero-trimmed) scalars, both of which the elliptic-curve crates' `from_sec1_der` rejects. Unencrypted and OpenSSH-format keys are unaffected (russh still handles those). (Closes #845)

- Testing: fixed three failing/flaky SSH-auth integration tests (`core/tests/ssh_auth.rs`). The **ECDSA-384 and ECDSA-521 passphrase** key fixtures were stored in legacy encrypted PEM/SEC1 (`-----BEGIN EC PRIVATE KEY-----`) format; they are now stored in OpenSSH format (same keypair, so `authorized_keys` is unchanged) like every other fixture, so the integration tests cover the russh-native path (encrypted PEM/SEC1 keys remain supported through the `legacy_pem` fallback above, exercised by that module's unit tests). The **ECDSA-256 key** test was intermittently failing with `SSH handshake failed: Disconnected` because the ~12 key-auth tests open connections to the single `ssh-keys` container concurrently and exceeded OpenSSH's default `MaxStartups` (10:30:100); the container now sets `MaxStartups 100:30:200`.

- Tunnel: an **SSH tunnel that failed to start no longer sticks in "connecting" forever**, and **Stop now works while a tunnel is still connecting**. Starting a tunnel runs a blocking SSH handshake before the tunnel is registered as active; if any step failed, the backend returned the error to the caller but never updated the tunnel's status, leaving the UI stuck in `connecting` — and a Stop click during that window found nothing to stop and was silently lost (so the tunnel could later flip to `connected` after the user thought they had stopped it). The tunnel manager now (1) emits an `error` status (with the failure message) when a start fails, and (2) tracks the connecting phase with a cancel flag so a Stop request during `connecting` cancels the pending start — tearing the just-built forwarder down when the handshake completes and returning the tunnel to `disconnected`. A latent SSH-session-pool reference leak on a failed local/dynamic forwarder start was fixed in the same path. (Closes #829)

- Backend: fixed latent process aborts when triggering SSH/SFTP work from synchronous code paths. **"Open in VS Code" on a remote (SFTP) file** and **starting an SSH tunnel** (including auto-start tunnels at launch) could abort the whole app, because they drove the blocking SSH/SFTP connect (which uses `tokio::task::block_in_place` internally) from the synchronous Tauri command thread or a raw `std::thread` — neither of which carries the Tokio runtime context that `block_in_place` requires. These paths now run on `spawn_blocking` threads (mirroring monitoring/SFTP file-browser), so the connect happens off the command thread with a valid runtime context. (Closes #828)

- Backend: fixed the same latent abort in the **remote agent auto-deploy** path. The agent-setup background phase (SFTP upload + command injection) ran on a raw `std::thread`, which carries no Tokio runtime context, so its SSH/SFTP `block_in_place` helpers (`connect_and_authenticate`, `upload_via_sftp`) would abort the whole app when deploying or auto-deploying a remote agent over SSH. The background phase now runs on a `spawn_blocking` thread with a valid runtime context, matching the #828 fix. (Closes #837)

- SFTP: opening the **SFTP file browser** no longer crashes the whole app. The SFTP Tauri commands were synchronous and called the blocking SSH/SFTP routines directly on the Tauri command thread, where the internal `tokio::task::block_in_place` is invalid and **aborts the process** (`fatal runtime error: failed to initiate panic`) — a regression surfaced after the russh upgrade. The commands now run their blocking work on a `spawn_blocking` thread (matching the monitoring path), so SFTP connect/list/transfer/edit operate without crashing. Found while porting the SSH E2E suite (#812).

- Terminal: a connection's configured **initial command** is now sent with the session's resolved line ending (LF / CR / CRLF) instead of a hardcoded `\n`. Previously, after the configurable-line-ending change (#791), a CR/CRLF session normalized typed and pasted input but still injected its `initialCommand` with a bare LF, so on hosts or devices that require CR/CRLF the auto-injected command could fail to execute. The injection now routes through the same line-ending normalization as all other input. (Closes #792)

- Network tools: the **Ping** and **HTTP Monitor** latency graphs are now readable. The previous hand-rolled SVG sparkline stretched a fixed `100×80` viewBox to the full panel width (`preserveAspectRatio="none"`), which distorted the line into a thick, slanted smear, exaggerated tiny millisecond variations into dramatic slopes, and showed no real axes or value labels. The chart is now drawn with **uPlot**: a zero-baselined millisecond y axis with gridlines and `…ms` tick labels, an elapsed-seconds x axis (Ping passes its sampling interval), a hover read-out of the exact latency at each sample, dashed drop markers for timeouts/packet loss, and a uniform stroke width that no longer distorts with the panel size.

- Network tools: pinging a host that fails to resolve (or otherwise errors) no longer leaves the **Ping** panel stuck on "running" with a Stop button that does nothing. Two issues caused this. First, the panel never listened for the backend's `network-ping-error` event, so a fatal error (e.g. DNS failure) — which ends the task backend-side — left the panel "running" forever with Stop as a no-op. Second, even with that listener added, the panel registered its event listeners **after** calling `network_ping_start`, so a fast failure (such as a cached negative DNS result that errors instantly on the second attempt) could fire `network-ping-error` before the listener was attached and the event was lost. The panel now registers all ping listeners **before** starting, filtering by the active task id, and on an error leaves the running state, shows the message, and tears down its listeners. Relatedly, stopping a running ping is now correctly reported as **canceled** instead of **completed** (the cancellation flag was previously read before the ping loop ran, so it was always `false`).

- Network tools: the **Traceroute** and **Port Scanner** panels no longer get stuck on "running" with a dead Stop button when the target fails (e.g. an unresolvable host). Both panels had the same two flaws the Ping panel was just fixed for: they never listened for the backend's `network-traceroute-error` / `network-scan-error` events, and they registered their event listeners **after** calling the start command, so a fast failure could fire the error before the listener attached and be lost. Both panels now run through a shared `useNetworkTask` hook that registers all listeners **before** starting (filtering by the active task id), surfaces backend errors, reports Stop as **canceled**, and tears down listeners on completion/error/stop/unmount.

- Agent (TCP listener): a transient `accept()` failure — for example the peer aborting a pending connection, or the process briefly hitting its file-descriptor limit under load — no longer tears down the whole TCP listener and exits the agent. The accept loop now logs the error and keeps serving; a per-connection handler-build failure is likewise isolated to that one client. Previously either error propagated out of `run_tcp_listener` and terminated the agent, dropping every other client and resetting the in-flight connection. The accept loop now logs the error and keeps serving; a per-connection handler-build failure is likewise isolated to that one client. Previously either error propagated out of `run_tcp_listener` and terminated the agent, dropping every other client and resetting the in-flight connection.

- Keyboard: application shortcuts are now routed by the active tab's content type, so an editor (Monaco) tab receives the editing shortcuts it owns instead of the global handler swallowing them. Most visibly, pressing **Cmd+F** on macOS in an **Open in Editor** / file-editor tab now opens Monaco's find widget; previously the global `Find in Terminal` handler called `preventDefault()` unconditionally and Monaco never saw the key. Each shortcut action now declares a **scope** (`global` / `terminal` / `editor-delegated`); the dispatcher derives the active context from the focused tab and steps aside (without preventing the default) when a matched action's scope is incompatible — so `Find in Terminal`, `Copy`, `Paste`, and `Select All` are handed to a focused editor or input while truly global shortcuts (split, zoom, switch tab, …) keep working everywhere. A new **Settings → Keyboard → "Let editor tabs handle their own editing shortcuts"** toggle (default on) restores the old global-first behavior, and the keyboard-shortcuts overlay shows an **"Active in"** scope hint per action. (Closes #787)

- Terminal: in horizontal-scroll mode the vertical (scrollback) scrollbar is now visible at all times in a reserved gutter on the right edge and no longer overlaps text. Previously it only appeared when scrolled fully right — where it also sat on top of the last column — because xterm's overlay scrollbar lives inside the widened, horizontally-scrolling content and drifted to the content's right edge. The terminal now renders its own vertical scrollbar in a gutter (synced to the buffer via xterm's public API) and hides xterm's overlay scrollbar, so the **same scrollbar is used in every mode** — normal and horizontal-scroll terminals now look and behave identically. In normal mode the gutter overlays the strip xterm already reserves, so the amount of visible text is unchanged; in horizontal-scroll mode the scroll viewport is inset by the gutter width so the scrollbar never overlaps content and nothing is clipped (content stays fully reachable by scrolling). Horizontal-scroll mode also keeps the same left inset as normal mode and reserves room for the bottom horizontal scrollbar so it no longer covers the last row.

- Remote agent (Windows): the agent's local file browser now returns forward-slash paths on Windows and resolves MSYS-style input paths (`/c/Users/...`). The agent's `LocalFileBackend` emitted raw OS paths, so a Windows-hosted agent returned backslash separators that broke the frontend's single `split("/")` path contract and could not open MSYS-style paths. It now mirrors the desktop core backend: input is normalized via `normalize_platform_path` and output via `normalize_path_separators` in both directory listing and stat. SSH default key paths (`~/.ssh/id_rsa`) already resolve under `%USERPROFILE%`, and the Docker/Podman fallback already targets the Windows named pipe; both are now covered by Windows-gated tests. Part of #771 (Closes #768).

- Remote agent (Windows): config and session-state files are now stored under the platform user-config directory on every supported platform. Previously, the agent's path helpers special-cased Linux (`$XDG_CONFIG_HOME` / `$HOME/.config`) and macOS (`~/Library/Application Support`) but had no Windows branch, so a Windows-hosted agent fell through to a relative `.config/termihub-agent` path under the working directory. Both helpers (`agent/src/state/persistence.rs::config_dir` and `agent/src/session/definitions.rs::dirs_config_dir`) are now backed by the `dirs` crate, which resolves `%APPDATA%` (Roaming) on Windows. The previously `#[cfg(unix)]`-gated state module is now compiled on all platforms so the desktop's session manager can persist agent state regardless of host OS. Part of #771 (Closes #764).

- Agent: connecting or reconnecting to an agent that recovered a session on startup no longer fails with "Unexpected response to initialize". The desktop assumed the first line the agent printed was the initialize response, but a recovered session can emit a notification (e.g. session output) before the agent answers `initialize`. The initialize and reconnect handshakes now skip any message whose id doesn't match the request until the real response arrives, and the handshake line reader preserves bytes after the newline so a notification and the response arriving together are both handled.

- Agent/terminal: reconnecting a destroyed agent or persistent session no longer spins in an endless loop. Previously the terminal reattached to the session id captured when the tab was first opened — which is dead after a destroy — so the reconnect retried against a non-existent session forever instead of restarting the connection. Reconnect now starts fresh: persistent tabs restart their background session and reattach to the new live session, plain agent tabs create a brand-new session, and when the agent transport itself is down the reconnect re-establishes the agent connection first. The agent-session spawn-retry loop is also bounded so a session that can never be created surfaces a disconnect error instead of looping.

- Terminal: removed two stray-bar artifacts that appeared on the right edge of terminal panes after the 8 px edge inset was introduced in PR #760. The native xterm viewport scrollbar and xterm's VS Code-derived smooth-scroll bar both rendered inside the new padding strip, the latter still drawing its slider thumb as a small floating square even when there was nothing to scroll. The viewport scrollbar is now hidden; the smooth-scroll bar is shifted 8 px right so it sits flush against the container edge, and its slider only appears when the buffer actually exceeds the viewport (gated by a `xterm--has-scrollback` class toggled from `Terminal.tsx`, since xterm's own visibility state can stay stuck "needs scroll" on tabs whose xterm was first measured while parked at 1×1 px).

- Terminal: dragging a file from the OS file manager onto a split terminal view now targets the individual pane under the cursor instead of treating the whole terminal area as a single drop zone. The dropped path is inserted into the session of the tab shown in that pane, and the drag highlight is confined to that pane.

- Agent persistent shells: re-attaching to a session via the sidebar's **Active Sessions** double-click no longer spawns a fresh shell on the agent — the desktop now adopts the existing agent session and replays its scrollback buffer into the new tab. Previously the handler called `addTab` without the agent's `sessionId` or the persistent connection ID, so `createTerminal` spawned a new session and the original daemon-side ring buffer was orphaned. A new agent protocol field (`definition_id`) lets the desktop recover the persistent connection ID from a discovered session after both agent and desktop restarts; a new `adopt_persistent_session` backend command and `adoptAndAttachAgentPersistentSession` store action wire this into the existing scrollback-replay path. Sessions created before this version (without `definition_id` on the wire) fall back to the previous behaviour (reattach without buffer replay) until the next restart.

- A second, latent bug surfaced during the same fix: `AgentSessionInfo` on the desktop used `rename_all = "camelCase"` for _both_ serialization and deserialization, but the agent's wire format is snake_case (per `docs/remote-protocol.md`). The mismatch made `listAgentSessions` silently return an empty array on every call. Switched to `rename_all(serialize = "camelCase")` so the wire is accepted and the Tauri IPC layer still hands camelCase to the React frontend.

- Logging: the desktop app's tracing subscriber had no log-level filter, so noisy third-party dependencies — most notably `russh`, which emits per-packet `DEBUG`/`TRACE` cipher logs — flooded the LogViewer and console even while the app was idle (e.g. during background SSH monitoring polls). A default `EnvFilter` now keeps termiHub's own crates and `frontend::*` events at `DEBUG` while raising third-party crates to `INFO` and `russh` to `WARN`. The level can still be overridden via the `RUST_LOG` environment variable.

- Connection Editor: name conflict validation no longer crosses entity types. Connections, remote agents, and agent session definitions now each validate uniqueness only against their own peers (connections vs. other connections in the same folder, agents vs. other agents, definitions vs. other definitions on the same agent). Previously, naming a connection the same as an existing remote agent (or vice-versa) raised a spurious "already exists" error even though the two are stored independently.

- Monitoring: macOS memory usage was reported as ~100% due to a bug in `sysinfo` 0.33 where `available_memory()` incorrectly subtracted compressed pages. Upgraded `sysinfo` from 0.33 to 0.38 which uses Apple's XNU-documented formula and matches Activity Monitor within ~4%.

- Terminal: the built-in xterm.js 6 scrollbar now matches the rest of the UI. The slider color is sourced from the active theme's `scrollbarThumb` / `scrollbarThumbHover` tokens (previously xterm fell back to its own foreground-derived defaults, which clashed with the surrounding chrome). Geometry is left at xterm's defaults — xterm's scrollable element shares a track width with FitAddon's column reservation, so shrinking either in isolation causes the renderer to either leave a gap or paint content underneath the track.

- Terminal: the rightmost 1–2 characters of long lines are no longer cut off on the right edge. The terminal spans were inheriting `letter-spacing: -0.008em` (≈ 0.112 px / glyph) from the UI-wide body rule, but xterm measures its cell width with `canvas.measureText` and `font-kerning: none` — so its column math was short by ~0.11 px per column. Across a 113-column line that snowballed into ~13 px of unaccounted-for overhang that visually slid off the right edge while xterm still believed the column fit. Force `letter-spacing: 0` on `.xterm` and all descendants so the rendered glyphs actually fill exactly xterm's measured cell width. Also re-fit once `document.fonts.ready` resolves so FitAddon's column count is computed against the loaded Nerd Font metrics rather than the swap-fallback monospace's.

- Remote agents: double-clicking a stopped persistent shell in the sidebar now starts the persistent session (turning the state dot green) and attaches a tab in one step. Previously the double-click fell through to the non-persistent open path, which created an unmanaged tab via `createTerminal`/`create_connection` and left the state dot grey even though the shell was running.

- Remote agents: opening a shell (or any other session type) against a connected agent no longer hangs forever on the "Connecting…" overlay. `AgentConnectionManager`'s sync helpers (`create_session`, `attach_session`, `send_request`, `close_session`) internally call `tokio::sync::oneshot::Receiver::blocking_recv`, which parks the calling thread until the agent I/O task delivers the JSON-RPC response. The session-creation, file-browser, and monitoring code paths invoked these helpers directly from async tokio tasks, so the parked worker would never wake from the cross-task `tx.send` — and Tauri's multi-thread runtime swallowed the resulting "Cannot block the current thread from within a runtime" panic, presenting as a spinner that never resolved. The hot paths in `RemoteProxy::connect`/`disconnect`/`reconnect_existing`, `RemoteFileBrowserProxy`, `RemoteMonitoringProxy`, and `SessionManager::get_remote_session_buffer` now run the sync RPC helpers on the dedicated blocking thread pool via `tokio::task::spawn_blocking`, matching the pattern already used by `list_agent_sessions` and friends.

- Monitoring: agent local-host stats (CPU %, memory, disk) are now collected via the `sysinfo` crate instead of hand-rolled `/proc` parsing and `sysctl`/`vm_stat`/`top` subprocess calls. This fixes two macOS regressions from the previous implementation: (1) CPU usage was always reported as 0 % because `sysctl kern.cp_time` does not exist on macOS (it is a FreeBSD key) — `sysinfo` uses the correct platform API; (2) disk usage was severely underreported because `df /` shows only the read-only System snapshot (~12 GB); `sysinfo` returns the `/System/Volumes/Data` volume which contains actual user data.

- Connection Editor: creating a new connection definition on an agent no longer pre-fills the name field with the agent's name — the field now starts empty as expected.

- Monitoring: macOS agent now reports real CPU usage instead of always 0%. CPU is computed via delta-based tracking using `sysctl kern.cp_time` (user/nice/sys/intr/idle ticks), the same approach used for Linux `/proc/stat`. Available memory now includes inactive and purgeable pages (matching Activity Monitor) instead of only free and speculative pages.

- Terminal: in horizontal-scroll mode, the rightmost visible content is no longer hidden behind the vertical scrollbar. Previously, computing the xterm screen width from `container.clientWidth ÷ dims.cols` produced a slightly inflated cell width (because `dims.cols` already had the scrollbar area deducted by FitAddon), pushing the screen all the way to the container edge and underneath the scrollbar. The fix reads the actual rendered cell width directly from xterm's render service — the same value FitAddon uses — so the screen width stays safely within the scrollbar-free area.

- Shell integration: ZSH sessions on agents no longer get stuck at the `>` secondary prompt after startup. The OSC 7 CWD-tracking setup script previously used `&&...||` which could fall through to a `PROMPT_COMMAND` assignment in ZSH if `precmd_functions+=` returned non-zero for any reason; that assignment could produce unbalanced double quotes (from `${PROMPT_COMMAND:+;$PROMPT_COMMAND}` expansion), leaving ZSH waiting for a closing `"`. The script now uses `if [ -n "$ZSH_VERSION" ]; then ... else ... fi` so the `PROMPT_COMMAND` fallback is only reachable in bash.

- Agent setup: the "Setup Agent" dialog no longer hangs indefinitely at "Connecting and detecting architecture…" when the SSH server is unresponsive after the TCP connection is established. libssh2 now has a 30-second timeout applied to all blocking operations (handshake, exec, channel read, SFTP init), after which the dialog displays an error instead of hanging forever.

- Persistent sessions: re-attaching a tab after closing it no longer shows a blank terminal. A race condition in the agent daemon loop caused a stale `Disconnected` command from the previous socket connection to destroy the newly accepted connection, leaving the daemon unable to respond to buffer queries. The fix tags each `Disconnected` command with a connection-generation counter so the daemon can ignore disconnects from superseded connections.

- Remote agents: when a connection attempt fails because the agent is already connected, the error dialog now shows a **Force Reconnect** button that drops the existing connection and immediately establishes a new one. Previously the dialog offered only "Close" with no way to recover without restarting the app.

- Connections: deleting connections or agents while the master-password credential store is locked no longer silently fails. Previously, `delete_connection` and `delete_agent` used `?` on `remove_all_for_connection`, which returned an error when the store was locked and aborted the delete before writing to disk — leaving the connection in the file and making it reappear after restart. Credential cleanup is now best-effort; orphaned encrypted entries are harmless until the store is next unlocked.

- Persistent sessions: after an agent disconnects and the user reconnects, clicking "Attach" now correctly re-connects the desktop to the surviving daemon process on the remote host. Previously the desktop-side session entry was cleaned up on disconnect but not restored on reconnect, so "Attach" would silently open and immediately close a blank tab due to a `SessionNotFound` error.

- Connections: importing a backup file or moving a connection to another file in one instance no longer resurrects connections that were deleted by a parallel running instance. Previously `import_json`, `import_encrypted_json`, and `move_connection_to_file` each wrote back to disk without first re-reading the current file state, causing deleted connections to reappear after the other instance restarted.

- Connections sidebar: deleting multiple selected connections now removes all of them instead of only the one that was right-clicked.

- Connections: changes made in one running instance (add, delete, rename) now propagate to all other running instances within ~1 second. Previously, other instances only updated on window focus.

- Persistent sessions: "Attach new tab" now correctly restores the terminal scrollback. The frontend explicitly fetches the ring-buffer snapshot from the agent on reattach, resets xterm, and writes the snapshot before subscribing to live output — ensuring the cached history is always visible and never raced by live events. A "Restoring session…" spinner overlay is shown during the fetch.

- Persistent sessions: "Attach new tab" no longer shows a blank terminal with no overlay. The backend now triggers a DaemonClient reconnect on attach so the scrollback buffer arrives via the notification path; if the session has already died, the placeholder tab is automatically removed instead of left in a broken state.

- Persistent sessions: "Restoring session…" overlay is now correctly displayed while the scrollback buffer is being fetched on reattach. The SplitView rendering condition was missing the `terminalReattaching` flag, so the overlay was never shown and the terminal appeared blank and non-interactive during the fetch window.

- Persistent sessions: after reattaching to a session whose shell had already exited (e.g. crash while the tab was closed), the terminal now shows "[Process exited]" instead of appearing interactive but silently dropping all input. The fix buffers the `terminal-exit` event in the frontend dispatcher so it is delivered even if it fires before the reattaching tab subscribes.

- Open Connections panel: proxy session titles now show the actual connection info (e.g. "SSH: user@host", "Serial: /dev/ttyUSB0") instead of the generic "Remote: &lt;agent-id&gt;" label. The agent context is already conveyed by the section header.

- Connections: running two termiHub instances simultaneously no longer causes deleted connections to reappear. Each write operation now reloads from disk before modifying in-memory state, preventing the stale second instance from overwriting changes made by the first.

- Connections: agent reconnect operations (which trigger internal settings updates) no longer resurrect connections deleted by another instance — `update_agent_settings` and `reorder_agents` now also reload from disk before writing.

- Connections: switching between termiHub windows can no longer resurrect deleted connections — the window-focus reload now runs through the same versioned-reload guard as all other state changes, so a stale focus event cannot overwrite a more recent correction.

- Credential store: saving a serial or local connection no longer triggers the credential-store unlock dialog. The credential migration path now only runs for SSH connections (those with an `authMethod` setting), so non-SSH connection types can be saved without touching the credential store.

- SSH connections: the Save & Connect flow in the Connection Editor no longer shows a password prompt when a stored credential already exists — it reads the stored password or key passphrase from the credential store and uses it directly.

- SSH connections: connecting via the sidebar with key authentication and `savePassword=true` now correctly prompts for the key passphrase when none is stored, preventing a silent auth failure.

- CI: main-branch builds are now marked as dev builds — the app version shown in the UI includes a `-dev` suffix and the `isDev` flag is set to `true` for all CI builds triggered from `main` (not just local `tauri dev` sessions). Release-tag builds are unaffected (#663).

- CI: Windows NSIS setup installer (`termiHub-dev-windows-x64-setup.exe`) was not being uploaded to the `dev-latest` release — it is now uploaded alongside the existing MSI artifact (#664).

- CI: `dev-latest` release is now created as a draft and published atomically once all platform builds and agent binaries finish uploading, preventing the partial-artifact state visible during builds (#664).

- CI: `dev-latest` release now stays visible throughout the build process — artifacts are staged in GitHub Actions artifact storage during builds, and the release is deleted and recreated with the full artifact set only at the very end, eliminating the 10–20 minute window where no release was visible.

- Monitoring: switching back to a tab with monitoring enabled now shows the last-known stats (CPU, memory, disk) immediately instead of a blank "Connecting" state. Stats are cached per host and restored when reconnecting; the spinner on the host button indicates that a fresh connection is in progress (#626).

- Monitoring: the monitoring status bar now correctly appears for agent shell sessions. Previously, `RemoteProxy::connect()` looked up capabilities using the frontend alias `"shell"` while the agent normalises and returns this type as `"local"`, causing the match to fail silently and monitoring to stay permanently disabled (#626).

- Monitoring: system stats (CPU, memory, disk) are now delivered for agent shell sessions. Previously, the `session-monitoring-stats` Tauri event payload serialised the session ID field as `sessionId` (camelCase) while the frontend expected `session_id` (snake_case), so the session ID was always `undefined` and every incoming stats event was silently discarded (#626).

- Agent: connections inside a remote agent's sidebar now support the full interaction set available for local connections — Ctrl/Cmd+Click toggles individual selection, Shift+Click range-selects across the visible tree, dragging a selected group moves all selected items at once, Escape clears selection, and clicking empty space in the agent tree deselects. Previously, agent connections had no drag-and-drop or multi-select support and could only be reorganised via the connection editor (#639).

- CI: agent binaries in the `dev-latest` GitHub release are now named `termihub-agent-linux-{arch}` (without the `-dev-` infix) so the desktop's download URL matches the uploaded artifact name and setup no longer returns HTTP 404.

- UI: closing a file editor tab with unsaved changes now shows a "Save / Discard / Cancel" dialog before the tab is closed, matching the behavior of the settings and connection editors. Previously, a simple browser confirm appeared after the tab was already closed, making it impossible to cancel (#632).

- UI: restored the dirty-state dot indicator in editor tab titles (settings, connection editor, file editor) — a small filled circle now appears before the tab name when there are unsaved changes.

- Monitoring: system stats (CPU, memory, disk) are now displayed for remote shell sessions on agents that support monitoring. Previously, the monitoring panel showed nothing for remote-session tabs because the agent reported local sessions as not supporting monitoring, the desktop proxy sent the wrong host identifier, and the frontend never checked per-session capabilities (#629)

- UI: right-clicking the header bar of the panel zoom overlay (Cmd+Shift+Enter) now opens a context menu with Rename, Save to File, Copy to Clipboard, Clear Terminal, Horizontal Scrolling, and Set Color options. Previously the zoom overlay header had no context menu at all (#635).

- Terminal: pressing "Clear" now fully resets the terminal — the cursor is moved to position (0,0) after the buffer is wiped, preventing rendering artifacts and misaligned input that occurred when a subsequent program output was placed at the old cursor position (#634)

- Files: remote zsh sessions now receive shell integration (OSC 7 CWD tracking) so the file browser follows the terminal's current directory. Previously, zsh was excluded from integration injection under the incorrect assumption that it emits OSC 7 natively; the injected hook correctly detects bash vs. zsh at runtime (#630)

- Files: the session-mode file browser now opens in the user's home directory (`~`) instead of the filesystem root (`/`) when no CWD has been received yet (#630)

- Agent/Serial: the auto-reconnect overlay now shows a "Stop" button so users can cancel reconnection at any time and return to the disconnect overlay (#627).

- Agent/Serial: the error that triggered the auto-reconnect is now displayed inside the reconnecting spinner overlay so users can see what went wrong while retrying (#627).

- Agent: the backend reconnect loop now checks the disconnect flag every 100 ms during its backoff sleep, so calling "Disconnect" from the UI stops the reconnection immediately instead of waiting up to 30 s per attempt (#627).

- Serial: on Linux/Raspberry Pi, UART devices such as `ttyAMA*`, `ttyS*`, and `uart_up*` are now listed in the serial port selector (previously these were omitted because the `serialport` crate does not enumerate them on some embedded Linux configurations) (#628)

- Agent: opening a saved agent connection definition now correctly forwards all configured settings (shell integration, initial command, serial port parameters, and any other schema fields) to the backend. Previously only the shell path was forwarded, causing shell integration to always run regardless of the setting, initial commands to be silently ignored, and serial port details to be lost. Tab color from terminal options is also now applied when using "Save and Connect" from the connection editor.

- Terminal: "Copy tab content" no longer pads lines with trailing spaces or wraps long lines at the visible terminal width — content is now copied as logical lines, matching what horizontal scrolling would show (#636)

- Agent: after an agent reconnects following a power loss, terminals whose sessions were successfully recovered by the agent now resume automatically instead of always showing the "Session disconnected" overlay. Sessions that could not be recovered still show the overlay as before.

- Terminal: clicking "Reconnect" after a session disconnect now immediately shows the "Connecting…" overlay with no blank gap between the disconnect overlay disappearing and the connection attempt starting. Previously, the overlay was not set until after a React render cycle, leaving a brief window with no visible feedback.

- Terminal: agent-session reconnect loop now shows a "Connection failed" state briefly after each failed attempt instead of spinning "Connecting…" indefinitely with no visible feedback. The overlay cycles Connecting → Connection failed → Connecting until the session is established.

- Terminal: when an agent reconnects while a terminal is in the retry loop (or showing "Connection failed"), the connection attempt is now restarted immediately instead of waiting for the next retry cycle — the terminal connects as soon as the agent is back.

- Connection editor: boolean fields in existing connections now correctly reflect their schema default when the field was never explicitly saved (previously showed unchecked regardless of the schema default)

- Settings: the Settings panel and Connection Editor no longer remember the last-selected category across opens — they always start on the first category ("General" / "Connection")

- Settings: reverting a setting back to its last-saved value no longer shows a false "unsaved changes" dialog when closing the tab. Previously, if the Zustand settings were updated externally (e.g., on initial load) after the panel mounted, the dirty-state baseline became stale and a revert was incorrectly treated as a new change.

- Connection editor: opening an existing connection no longer immediately shows an "unsaved changes" dialog on close without the user having made any changes. The previous implementation used a first-render guard that React StrictMode's intentional double-effect invocation would bypass, marking every freshly-opened editor as dirty.

- Connection editor: reverting a field back to its original value (or to its schema default for fields not stored in the config) now correctly clears the unsaved-changes indicator. Previously, any change at all permanently marked the tab as dirty for the session.

- Agent: the "Reconnecting…" and "Session disconnected" overlays now correctly appear on all agent terminal tabs during and after an auto-reconnect, including sessions opened after the initial agent connect. Previously, the overlay was never shown because the tab-finding logic relied on `agentSessions`, which is populated only once on initial connect (before any sessions exist) and was therefore always empty. The fix looks up tabs directly by their connection config's `agentId` field.

- Agent: after the agent transport successfully auto-reconnects, affected tabs now transition from the "Reconnecting…" spinner to a "Session disconnected" overlay (with a Reconnect button), correctly reflecting that the remote shell sessions were lost when the agent process restarted.

- SSH: dead-connection detection time reduced from ~15 s to ~6 s by tightening TCP keepalive probe interval (idle 2 s, interval 2 s, 1 retry), so the disconnect overlay appears much sooner after a remote host loses power

- SSH: write timeout reduced from 5 s to 2 s, capping the UI freeze when typing into a dead connection; combined with a fast-path that skips the blocking write once the session is already known to be dead, subsequent keystrokes fail instantly

- Monitoring: fixed UI freeze and delayed disconnect overlay caused by `monitoring_fetch_stats` blocking tokio worker threads for up to 52 s per call when the remote host is dead; the command is now async and dispatches the blocking SSH exec to a dedicated thread pool via `spawn_blocking`, and the legacy SSH connection now has a 15 s read timeout to bound the blocking time

- Monitoring: `monitoring_open` now also uses `spawn_blocking` so a TCP connect to a dead host (which can take ~75 s for the SYN timeout) no longer blocks a tokio worker thread

- Monitoring: fixed auto-reconnect loop — when the disconnect overlay is showing, the status bar no longer tries to open a new monitoring session to the dead host; monitoring reconnects automatically once the user brings the terminal back via the Reconnect button

- Monitoring: CPU/memory stats panel now automatically disconnects when the terminal session exits unexpectedly (instead of persisting stale stats under the disconnect overlay)

- Agent: fixed connection failure on freshly deployed agents — the desktop was sending `protocol_version`/`client_version` in snake_case JSON but the agent expected camelCase (`protocolVersion`/`clientVersion`), causing every connect attempt to fail with "missing field `protocolVersion`"

- Agent: "Initialize rejected" errors (protocol version mismatch) now show a clear "Agent Version Incompatible" message with a "Setup Agent" button to re-deploy, instead of a raw internal error string

- SSH key picker: OS metadata files (`.DS_Store`, `.localized` on macOS; `Thumbs.db`, `desktop.ini` on Windows; `.directory` on Linux/KDE) are now excluded from the key file list

- Agent: persisting (daemon-backed) sessions now survive agent reconnects — previously the agent killed daemon subprocesses on exit instead of detaching, causing recovered sessions to appear missing after disconnect/reconnect

- Closing the app no longer exits with code 101 — tunnel and embedded-server shutdown is now deferred off the Tauri event-loop thread, preventing a `RefCell` re-entrant borrow panic inside `tauri-runtime-wry`

- Workspace launch: agent connection tabs (agentRef) now trigger the master password prompt upfront when their agents are disconnected and have stored credentials — previously these tabs would open as "Agent not connected" error tabs without ever asking for the password, and clicking Reconnect would immediately fail with an auth error

- Agent error tab: the Reconnect button now unlocks the credential store and resolves the stored password before reconnecting — previously it always connected without a password, causing an immediate authentication failure

- Terminal: connection failures (e.g. agent timeout, SSH auth errors) now show a proper error panel with the error message and a Retry button instead of raw red text in the terminal canvas.

- UI: Connections view is now always shown on startup instead of restoring the file browser from the previous session

- UI: Resize handle between Connections and Remote Agent sections no longer shows a resize cursor when the agent is not expanded (cursor was misleading — dragging appeared broken)

- UI: Added resize separator above the "Remote Agents" header to resize the Connections section against the entire Remote Agents section; individual agent resize handles now appear only between agents (not before the first one)

- File browser: delete confirmation now uses a themed in-app dialog instead of the native OS `window.confirm()` popup

- File editor: closing the zoom overlay no longer leaves the panel's file editor blank — the Monaco model is now preserved across overlay mount/unmount cycles (`keepCurrentModel`) so the panel editor retains its content when zoom is dismissed

- UI: the zoom shortcut (Cmd/Ctrl+Shift+Enter) no longer inserts a blank line in Monaco-based editors — a capture-phase keyboard listener intercepts the key before Monaco's "Insert Line Above" keybinding fires

- Terminal: zoom overlay no longer shows blank or garbled content after the zoomed tab changes — the `ResizeObserver` now skips fitting while the terminal element is in transit through the off-screen parking div, which previously caused the PTY to be briefly resized to 1–2 columns and the shell to redraw its prompt at that width (filling the buffer with wrapped garbage)

- Credential store: the unlock dialog no longer appears proactively every 15 minutes after auto-lock — the store still locks automatically, but the unlock prompt is only shown when a credential is actually needed (e.g. when connecting with stored credentials)

- Workspace launch: the master password dialog is now shown **once upfront** before any tabs open (instead of after the first connection attempt fails), and stored credentials are resolved and injected into each tab's config so all connections authenticate silently without interactive password prompts

- Terminal: the OSC 7 shell-integration setup command is no longer visible as stray text after connecting — the backend erase calculation now uses the real terminal width (from `fitAddon.fit()` run before session creation) instead of the 80-column default, so the right number of echo lines are erased regardless of terminal width

- Agent build: `build-agents.sh` now builds multiple targets in parallel (each in its own `CARGO_TARGET_DIR` to avoid cargo build lock contention); add `--sequential` flag to opt out

- Agent build: `build-agents.sh` and `setup-agent-cross.sh` now work correctly on ARM hosts (Apple Silicon, Raspberry Pi) — cross-rs Docker base images are pinned to `linux/amd64`, the container engine is auto-selected based on which engine already has the required images, missing images are caught early with a clear error, and jemalloc/QEMU noise is filtered from build output

- Terminal: box-drawing characters (table borders, tree views) no longer render with pixel gaps between rows — the default `lineHeight` has been corrected from 1.2 to 1.0 (#579)

- Services: "New Service" dialog now opens as a centred modal overlay instead of rendering inline and covering the lower half of the app — the dialog CSS classes (`dialog__overlay`, `dialog__content`, `btn`, etc.) were never defined or imported, so the Radix portal content had no `position: fixed` and appeared in the normal document flow

- Settings: custom grammar syntax highlighting now correctly applies — `shikiToMonaco` internally resets Monaco's theme to `themeIds[0]` (always dark-plus), which corrupted the colorMap used by the token provider and prevented open models from re-tokenizing with the correct colors; the user's actual theme is now re-applied after every `shikiToMonaco` call (#556)

- Settings: imported grammars, installed language packages, and file type mappings now survive app restarts — the Rust `AppSettings` struct was missing these three fields so serde silently dropped them on every save/load cycle (#556)

- Settings: custom grammar import now shows an error message when the grammar fails to load in Shiki (e.g. malformed grammar, unsupported embedded scope), and the grammar is only saved to settings if loading actually succeeds; failures are also logged to the LogViewer via `frontend::custom_grammars` for diagnosis (#556)

- Settings: custom grammar syntax highlighting now actually works when the language is selected — Shiki indexes grammars by their `name` field, not `id`, so `shikiToMonaco` could not match the Shiki language to the Monaco language ID; the `id` is now explicitly added to the Shiki registration's `aliases` so the token provider is correctly wired (#556)

- Settings: files with extensions listed in the grammar's `fileTypes` field are now auto-detected as the custom language when opened in the file editor; the language ID is also always registered as a file extension (e.g. grammar with id `s16` matches `*.s16` files), so auto-detection works even when `fileTypes` is absent or lists different extensions (#556)

- Terminal: all connections no longer show a blank terminal on open — `registerSession` writing the session ID back to the Zustand store caused `existingSessionId` to change as a prop, which invalidated `setupTerminal`'s callback and triggered a full xterm teardown/recreate cycle; the session ID is now captured in a mount-time ref so later store updates do not re-run the terminal setup

- File browser: copy/cut in session-based connections (remote agent) now correctly supports multi-file selection — `useSessionFileSystem` was still using the old singular `entry` field instead of `entries: FileEntry[]`

- Agent setup: terminal tab no longer appears blank for 5+ seconds on Windows — a "please wait" message is now injected immediately after the shell initialises, so users see feedback while the SFTP upload runs in the background (#560)

- Agent setup: setup script now prints "You can close this terminal tab now." after the completion banner (#560)

- File browser: pressing the Up button in a local PowerShell session on Windows no longer jumps to "/" and breaks Refresh — raw Windows backslash paths (reported by PowerShell via OSC 9;9) are now normalized to forward slashes, and navigating up correctly stops at the drive root (`C:/`) rather than falling back to "/" (#555)

- File editor: syntax highlighting for CMake, TOML, Nginx, and Nix files now works correctly — `"vs-dark"` is not a valid Shiki v4 theme identifier, causing the grammar loader to silently fail; replaced with `"dark-plus"` / `"light-plus"` (VS Code Dark+ / Light+); the Monaco editor theme now also follows the termiHub app theme (dark / light / system) instead of being hardcoded to dark (#498)

- File editor: built-in filename mappings now match case-insensitively, so e.g. `cmakelists.txt` is correctly highlighted as CMake (#498)

- File editor: added syntax highlighting for CMake, TOML, Nginx, and Nix files using TextMate grammars sourced from shiki's `tm-grammars` package (the same grammars VS Code uses); `.nix` and `.toml` files now highlight instead of showing as plain text; `.properties` files are mapped to the built-in `ini` highlighter (#498)

- Settings: file-type mappings built-in table no longer renders dotfile names backwards (`.gitignore` was displayed as `erongi tig.`) — caused by `direction: rtl` CSS on the shared file-path class; RTL truncation is now a separate opt-in modifier used only where long real paths need left-truncation (#498)

- Settings: built-in file-type mappings are now sorted alphabetically (leading dot ignored), replacing the unpredictable insertion order (#498)

- Remote agent shell sessions with PowerShell (and other special shells like GitBash, WSL) now show the correct shell icon instead of the generic server icon — handles both short names (`powershell`) and full paths (`/usr/local/bin/pwsh`) (#549)

- Remote agent connection definitions now have Terminal and Appearance settings tabs for per-session font, color, cursor, and icon customisation (#549)

- Terminal: WSL CWD hook injection is now completely silent — the setup task writes the hook to a temp script file via `wsl.exe -d <distro> -- sh -c 'cat > /tmp/.termihub_init'` and sources it; using a subprocess guarantees immediate filesystem visibility (Windows UNC path writes can return success without being synchronously propagated into WSL, causing `source: no such file` errors); the script self-erases the single visible `source ...` line before the next prompt appears

- Terminal: WSL file browser now uses `\\wsl.localhost\<distro>` (the Windows 11 preferred UNC path) with automatic fallback to `\\wsl$\<distro>` for older Windows versions, fixing file browser failures on Windows 11

- Terminal: OSC 7 CWD injection no longer clears the full screen — only the lines occupied by the echoed setup command are erased, using a computed `\r\033[2K` + N×`\033[A\033[2K` sequence sized to the terminal width

- Terminal: WSL connections now pre-set `PROMPT_COMMAND` via environment variable before bash starts, so CWD tracking fires on the very first prompt without waiting for the stdin-injected hook to run

- File browser: PowerShell and cmd.exe connections now track the current working directory — the file browser follows `cd`/`chdir` changes via injected prompt hooks that emit OSC 9;9 sequences (the Windows Terminal native CWD standard; no URL encoding or path conversion required)

- File browser: scrolling now works in large directories — the file list was using `overflow: hidden` preventing scroll in directories with many entries

- File browser: "Waiting for session..." no longer persists indefinitely for new remote-agent connections — the terminal registry now updates the tab's session ID in the store when the session is created, allowing the file browser to transition to the connected state

- File browser not working on remote agent connections — the file browser now activates in "session" mode for `remote-session` tabs when the agent's connection type reports file browser capability (`fileBrowser: true`), wiring the existing session-based file commands (`session_list_files` etc.) to the file browser UI; also adds `mkdir` support throughout the file browser capability stack (FileBrowser/FileBackend traits, all backends, agent protocol, Tauri commands) so directory creation works in session mode (#548)

- Terminal auto-scroll overriding user scroll position — scrolling up during active output (e.g., Claude Code thinking phase) no longer snaps the viewport back to the bottom; auto-scroll resumes when the user scrolls back to the bottom (#504)

- Remote monitoring data never reaching the frontend — the `RemoteMonitoringProxy` created a tokio channel but immediately dropped the sender, and `handle_notification()` in `agent_manager` silently ignored `connection.monitoring.data` notifications; now monitoring notifications are routed through the agent I/O thread to registered monitoring channels (#483)

- Paste (Cmd+V) inserting text twice on macOS — the native browser paste event was reaching xterm.js in addition to the custom paste handler, causing doubled input (#444)

- Terminal not auto-scrolling to the newest output line — xterm.js 6's SmoothScrollableElement does not reliably auto-scroll in WKWebView (macOS Tauri); added explicit `scrollToBottom()` after output writes (#444)

- Terminal output not fully scrollable to the bottom on first command after creation — the SmoothScrollableElement cached stale viewport dimensions from the hidden parking element; fixed by deferring `scrollToBottom()` to after the render pass, sending an explicit resize after session creation, and refreshing the scroll layout on every resize (#444)

- Zoom In shortcut now also triggers when pressing Cmd/Ctrl+Shift+= (producing "+"), not just Cmd/Ctrl+= (#452)

- Zoom shortcuts (Cmd/Ctrl+=/-/0) now scale the entire application UI uniformly using Tauri webview zoom, instead of only adjusting terminal font size (#447)

- Directional panel navigation (Cmd/Ctrl+Alt+Arrow) now remembers and restores the last-focused panel when entering a split group, instead of always selecting the first/last child (#448)

- Keyboard shortcuts now use platform-aware modifier detection — Ctrl+B on macOS no longer toggles the sidebar (it correctly passes through to the terminal as a control character); Cmd+B is used on macOS instead (#418)

- Dev server no longer spams `EMFILE: too many open files` on Windows — Vite's dep scanner and file watcher now exclude the `target/` directory (Rust build artifacts)

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

- `credentialStorageMode` TypeScript type now uses `"master_password"` (snake_case) matching the Rust backend's `StorageMode::to_settings_str()` — was incorrectly `"masterPassword"` (camelCase)

- Theme switching in Settings > Appearance now applies immediately instead of requiring an app restart (#224)

- Eliminated white flash on startup — window now starts with dark background (#1e1e1e) instead of flashing white before the theme loads (#192)

- Terminal input not working on new connections: a React StrictMode race condition could route keyboard input to the wrong backend session, making it appear as if typing had no effect; terminals now also auto-focus when created or switched to (#198)

- Vertically split panels can now be resized — the resize handle between top/bottom panels was invisible due to missing CSS height (#213)

- SSH terminals with zsh Agnoster theme no longer show a jarring black rectangle behind the user@host prompt segment; ANSI black now matches the terminal background (#197)

- Rapidly creating two WSL/SSH connections after startup no longer flashes initial shell output (welcome banner, setup commands) before the screen clear (#175)

- Product name casing: changed `productName` in `tauri.conf.json` from `termihub` to `termiHub` and fixed macOS binary paths in `wdio.conf.js`, `test-system.sh`, and `building.md`

- File browser now navigates to home directory when switching to a tab without CWD tracking (e.g., PowerShell), instead of staying on the previous tab's directory (#167)

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

- Black bar visible at the bottom of terminal tabs caused by xterm.js viewport default background color mismatch

- Terminal text appearing doubled on macOS (e.g., "llss" instead of "ls") caused by duplicate Tauri event listeners under React StrictMode

- Local file explorer now loads the user's home directory on first open instead of showing an empty root

- New terminal tabs now start in the user's home directory instead of the system root

- File browser now stays visible when editing a file, showing the parent directory

- Horizontal scroll width now updates dynamically as terminal output arrives

- Key repeat not working on macOS (accent picker shown instead)

### Security

- SSH: upgraded `russh` from 0.46 to 0.61 and `russh-sftp` from 2.0 to 2.3 to resolve two advisories in the SSH transport — `RUSTSEC-2026-0154` (`russh`: unbounded 32-bit allocation) and `RUSTSEC-2026-0153` (`russh-cryptovec`: unchecked allocation/growth), both fixed in `russh >= 0.60.3`. The `russh-keys` crate was merged into `russh::keys` upstream, so the separate dependency was dropped. SSH key/password/agent authentication and SFTP were migrated to the new API (`PrivateKeyWithHashAlg`, `AuthResult`, agent `Signer`-based auth); behaviour is unchanged.

- Dependencies: bumped the transitive `quinn-proto` from 0.11.14 to 0.11.15 to resolve `RUSTSEC-2026-0185` (remote memory exhaustion from unbounded out-of-order QUIC stream reassembly). Lockfile-only change.

- Updated npm dependencies (`vite`, `typescript-eslint`, `@wdio/*`, `vitest`) and added `pnpm.overrides` for transitive packages (`rollup`, `postcss`, `undici`, `flatted`, `fast-uri`, `dompurify`, `serialize-javascript`, `picomatch`, `brace-expansion`) to resolve all 39 npm security audit findings.

- Removed plaintext SSH password storage from connections file
