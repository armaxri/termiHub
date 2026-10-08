# termiHub second full-stack audit — consolidated index

**240 confirmed findings** across **38 expert angles**, against `develop` @ `663465d52`.

Every raw finding went through adversarial verification. All 240 raw findings were confirmed (raw = confirmed in every angle); severities are the verified ones.

| Severity  | Count   |
| --------- | ------- |
| critical  | 0       |
| high      | 6       |
| medium    | 101     |
| low       | 126     |
| info      | 7       |
| **total** | **240** |

**23 findings are flagged `is_workaround: true`** (the remove-before-release set).

Relation to the first audit ([`audit/`](../audit/)): **206 new**, **15 regressions** (a first-audit fix was undone or broken by later work) and **19 previous-incomplete** (a first-audit finding whose fix missed part of the problem, or whose situation materially changed). Regressions and incomplete fixes carry a `previous_id` pointing at the first-audit finding.

Each finding is one file under `audit-2026-10/<angle>/NNNN-*.md`. See [`RELEASE-BLOCKERS.md`](./RELEASE-BLOCKERS.md) for the ranked release-gating synthesis.

## Findings by angle

| Angle                                                         |     Raw | Confirmed |     C |     H |       M |       L |     I | Workarounds | 2026-09 findings |
| ------------------------------------------------------------- | ------: | --------: | ----: | ----: | ------: | ------: | ----: | ----------: | ---------------: |
| [Packaging & release](./packaging-release/)                   |       9 |         9 |     0 |     2 |       3 |       4 |     0 |           1 |               14 |
| [Performance](./performance/)                                 |       7 |         7 |     0 |     1 |       3 |       3 |     0 |           1 |               12 |
| [Plugin & extensibility](./plugin-extensibility/)             |       6 |         6 |     0 |     1 |       3 |       2 |     0 |           0 |               14 |
| [Concurrency & reliability](./concurrency-reliability/)       |       5 |         5 |     0 |     1 |       3 |       1 |     0 |           0 |               14 |
| [Backend Rust — src-tauri](./backend-tauri-rust/)             |       2 |         2 |     0 |     1 |       0 |       1 |     0 |           0 |               14 |
| [Accessibility (WCAG 2.2)](./accessibility/)                  |      12 |        12 |     0 |     0 |      10 |       2 |     0 |           0 |                9 |
| [CI/CD pipeline](./ci-cd/)                                    |       8 |         8 |     0 |     0 |       6 |       2 |     0 |           0 |               22 |
| [UX flows & feedback](./ux-flows/)                            |       7 |         7 |     0 |     0 |       5 |       2 |     0 |           0 |               34 |
| [Code duplication / core centralization](./code-duplication/) |      10 |        10 |     0 |     0 |       4 |       6 |     0 |           0 |               30 |
| [Marketing & presentation](./marketing/)                      |       8 |         8 |     0 |     0 |       4 |       4 |     0 |           1 |               14 |
| [Remote agent & protocol](./agent-protocol/)                  |       6 |         6 |     0 |     0 |       4 |       2 |     0 |           0 |               28 |
| [Workaround hunt — CI/scripts](./workaround-ci-scripts/)      |       6 |         6 |     0 |     0 |       4 |       2 |     0 |           1 |               36 |
| [UI shared foundation](./ui-shared-foundation/)               |      10 |        10 |     0 |     0 |       3 |       7 |     0 |           1 |               20 |
| [Documentation accuracy](./docs-accuracy/)                    |       9 |         9 |     0 |     0 |       3 |       6 |     0 |           0 |               13 |
| [Dead-code & feature-flags](./deadcode-flags/)                |       7 |         7 |     0 |     0 |       3 |       4 |     0 |           1 |               13 |
| [Observability & logging](./observability/)                   |       7 |         7 |     0 |     0 |       3 |       4 |     0 |           0 |               12 |
| [Persistence & migration](./persistence-migration/)           |       7 |         7 |     0 |     0 |       3 |       4 |     0 |           0 |               10 |
| [Connection-type parity](./connection-parity/)                |       4 |         4 |     0 |     0 |       3 |       1 |     0 |           0 |               12 |
| [Tooling & coverage gating](./tooling-coverage/)              |       4 |         4 |     0 |     0 |       3 |       1 |     0 |           0 |               14 |
| [Workaround hunt — frontend](./workaround-frontend/)          |       9 |         9 |     0 |     0 |       2 |       6 |     1 |           9 |               12 |
| [Security](./security/)                                       |       8 |         8 |     0 |     0 |       2 |       5 |     1 |           0 |               13 |
| [Test coverage — frontend](./test-frontend/)                  |       8 |         8 |     0 |     0 |       2 |       6 |     0 |           0 |               12 |
| [Frontend state layer](./frontend-state/)                     |       7 |         7 |     0 |     0 |       2 |       4 |     1 |           0 |               11 |
| [Integration / E2E / test-bridge](./test-integration/)        |       7 |         7 |     0 |     0 |       2 |       4 |     1 |           0 |               17 |
| [Dependencies & supply-chain](./supply-chain/)                |       6 |         6 |     0 |     0 |       2 |       4 |     0 |           0 |               12 |
| [Test coverage — Rust](./test-backend/)                       |       6 |         6 |     0 |     0 |       2 |       4 |     0 |           0 |               13 |
| [UI / visual design](./ui-visual/)                            |       6 |         6 |     0 |     0 |       2 |       4 |     0 |           1 |               12 |
| [Internationalization](./i18n/)                               |       5 |         5 |     0 |     0 |       2 |       3 |     0 |           0 |               17 |
| [Mocking & test doubles](./test-mocking/)                     |       4 |         4 |     0 |     0 |       2 |       2 |     0 |           2 |               11 |
| [Backend Rust — core](./backend-core-rust/)                   |       3 |         3 |     0 |     0 |       2 |       1 |     0 |           0 |               38 |
| [State-machine correctness](./state-machine-ux/)              |       2 |         2 |     0 |     0 |       2 |       0 |     0 |           0 |               29 |
| [Library usage (buy-vs-build) — FE](./lib-usage-frontend/)    |       7 |         7 |     0 |     0 |       1 |       3 |     3 |           0 |                6 |
| [Architecture](./architecture-overall/)                       |       5 |         5 |     0 |     0 |       1 |       4 |     0 |           0 |               11 |
| [Error handling & edge cases](./error-handling/)              |       5 |         5 |     0 |     0 |       1 |       4 |     0 |           1 |               10 |
| [Frontend components & services](./frontend-components/)      |       5 |         5 |     0 |     0 |       1 |       4 |     0 |           0 |               20 |
| [Library usage (buy-vs-build) — BE](./lib-usage-backend/)     |       5 |         5 |     0 |     0 |       1 |       4 |     0 |           0 |                7 |
| [Product / feature completeness](./product-completeness/)     |       4 |         4 |     0 |     0 |       1 |       3 |     0 |           0 |               68 |
| [Workaround hunt — Rust](./workaround-rust/)                  |       4 |         4 |     0 |     0 |       1 |       3 |     0 |           4 |               14 |
| **total**                                                     | **240** |   **240** | **0** | **6** | **101** | **126** | **7** |      **23** |          **668** |

## All critical findings (0)

None. No finding survived verification at critical severity.

## All high findings (6)

- **[TAURI2-001](./backend-tauri-rust/0001-global-session-lock-held-across-blocking-writes.md)** (Backend Rust — src-tauri) — One stalled tab freezes input, resize, close and create in every tab: write_session/resize hold the global session-map lock during blocking backend writes
- **[CONC2-001](./concurrency-reliability/0001-connect-agent-holds-agents-mutex-across-ssh-connect.md)** (Concurrency & reliability) — connect_agent holds the global agents std::Mutex across the whole SSH connect, keyboard-interactive prompt and initialize handshake
- **[PKG2-001](./packaging-release/0001-changelog-extraction-empty-first-release-fails.md)** (Packaging & release) — CHANGELOG extraction in release.yml always comes back empty; the first release falls back to full history, which is over GitHub's release-body limit, so create-release fails (and the security marker can never fire from CHANGELOG)
- **[PKG2-002](./packaging-release/0002-windows-agent-deploy-asset-name-mismatch.md)** (Packaging & release) — Deploying the agent to a Windows host downloads `termihub-agent-windows-x64` (no .exe), which no release publishes; dev releases ship no Windows agent at all
- **[PERF2-001](./performance/0001-remote-desktop-frames-json-number-array-ipc.md)** (Performance) — Remote-desktop frames cross IPC as JSON number arrays of raw RGBA pixels
- **[PLG2-001](./plugin-extensibility/0001-manifest-filesystempaths-are-never-validated-an-entry-of-or.md)** (Plugin & extensibility) — Manifest filesystemPaths are never validated: an entry of "" or "." turns into an empty scope root that matches every path, giving whole-disk read and write through the host bridge

## Regressions and incomplete first-audit fixes

| ID                                                                                                            | Severity | Relation            | First-audit ID | Title                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | -------- | ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PKG2-001](./packaging-release/0001-changelog-extraction-empty-first-release-fails.md)                        | high     | regression          | PKG-008        | CHANGELOG extraction in release.yml always comes back empty; the first release falls back to full history, which is over GitHub's release-body limit, so create-release fails (and the security marker can never fire from CHANGELOG) |
| [AGT2-003](./agent-protocol/0003-agt013-incomplete-desktop-reader-uncapped-quadratic.md)                      | medium   | previous-incomplete | AGT-013        | AGT-013 fix missed the real desktop reader: agent stdout is accumulated into an uncapped String, with quadratic rescans and copies                                                                                                    |
| [CI2-002](./ci-cd/0002-develop-has-zero-required-status-checks-live-pr.md)                                    | medium   | previous-incomplete | CI-017         | develop has zero required status checks live; PR Gate is required nowhere and the drift check cannot run                                                                                                                              |
| [CI2-004](./ci-cd/0004-coverage-fail-on-decrease-ratchet-has-not-run.md)                                      | medium   | regression          | CI-011         | Coverage fail-on-decrease ratchet has not run since #4119 (schedule-only trigger never fires)                                                                                                                                         |
| [CI2-005](./ci-cd/0005-daily-cargo-update-lockfile-chore-ci-016-mitigation.md)                                | medium   | regression          | CI-016         | Daily cargo-update lockfile chore (CI-016 mitigation) has never run                                                                                                                                                                   |
| [DUP2-002](./code-duplication/0002-dup-009-only-half-fixed-the-desktop-still-splits-agent-ndjson-with-thr.md) | medium   | previous-incomplete | DUP-009        | DUP-009 only half fixed: the desktop still splits agent NDJSON with three hand-rolled, uncapped String accumulators that decode lossy UTF-8 per chunk                                                                                 |
| [OBS2-001](./observability/0001-release-strip-unsymbolizable-backtraces.md)                                   | medium   | regression          | OBS-002        | Release builds strip symbols, so field crash reports and panic logs carry backtraces nobody can symbolize                                                                                                                             |
| [PARITY2-002](./connection-parity/0002-vnc-connect-no-timeout-no-cancel.md)                                   | medium   | previous-incomplete | PARITY-007     | VNC initial connect has no timeout and cannot be cancelled: the graphical manager never passes a cancellation token                                                                                                                   |
| [PER2-002](./persistence-migration/0002-macros-tunnels-bypass-version-gate.md)                                | medium   | previous-incomplete | PER-001        | macros.json and tunnels.json bypass the version gate, guard_not_newer and unknown-field preservation                                                                                                                                  |
| [SM2-002](./state-machine-ux/0002-agent-recovery-folds-ignore-tab-status-overwrite-user-stop.md)              | medium   | previous-incomplete | SM-002         | The agent-recovery folds for lost, unconfirmed, failed and transport-break ignore the tab's current status, so a user Stop is overwritten and an ended tab can come back                                                              |
| [TOOL2-001](./tooling-coverage/0001-coverage-ratchet-and-nightly-lanes-dark-on-develop.md)                    | medium   | regression          | TOOL-001       | Coverage ratchet and every schedule-only nightly lane are switched off for develop because their workflow files are not on main                                                                                                       |
| [TOOL2-002](./tooling-coverage/0002-plugin-runner-rdp-sidecar-missing-no-panic-lint.md)                       | medium   | previous-incomplete | TOOL-010       | New plugin-runner crate (sandbox boundary) and the rdp-sidecar are not covered by the no-panic lint                                                                                                                                   |
| [TOOL2-003](./tooling-coverage/0003-coverage-ratchet-misses-plugin-crates-and-rdp-sidecar.md)                 | medium   | previous-incomplete | TOOL-003       | Coverage ratchet has no per-component gate for plugin-runner/plugin-api and does not measure rdp-sidecar at all                                                                                                                       |
| [UISF2-003](./ui-shared-foundation/0003-rhf-zod-validity-block-copy-pasted-errors-hidden.md)                  | medium   | previous-incomplete | UISF-011       | RHF+zod editors each copy-paste the same synchronous-validity block, and three of them never show their zod error messages                                                                                                            |
| [UX2-002](./ux-flows/0002-workspace-launch-palette-cli-no-confirm.md)                                         | medium   | previous-incomplete | UX-026         | Workspace launch from the command palette or a forwarded --workspace still tears down live sessions without the UX-026 confirm                                                                                                        |
| [ARCH2-003](./architecture-overall/0003-plugin-sandbox-publisher-outside-apptasks.md)                         | low      | regression          | ARCH-007       | plugin-sandbox projection publisher is an untracked, uncancellable app-lifetime loop, outside the AppTasks contract                                                                                                                   |
| [DOC2-007](./docs-accuracy/0007-version-bump-omits-three-shipped-crates.md)                                   | low      | previous-incomplete | DOC-012        | Version-bump procedure omits three shipped crates (plugin-runner, plugin-api, rdp-sidecar)                                                                                                                                            |
| [ERR2-005](./error-handling/0005-rdp-sidecar-plugin-runner-missing-overflow-checks-and-lint.md)               | low      | previous-incomplete | ERR-010        | RDP sidecar is missing the release overflow-checks (ERR-010) and the no-unwrap lint; plugin-runner is missing the lint                                                                                                                |
| [FEC2-002](./frontend-components/0002-remotedesktop-per-component-global-listeners-unfixed.md)                | low      | regression          | FEC-005        | FEC-005 never fixed: each RemoteDesktop canvas and session hook still registers its own global Tauri listener on the frame path                                                                                                       |
| [I18N2-003](./i18n/0003-new-sort-sites-bypass-comparenames-collator.md)                                       | low      | regression          | I18N-014       | New sort sites bypass the shared compareNames collator (non-natural, locale-default ordering)                                                                                                                                         |
| [I18N2-004](./i18n/0004-date-time-sites-bypass-resolveuilocale.md)                                            | low      | regression          | I18N-015       | Date/time rendering sites bypass resolveUiLocale and mix English words with locale-formatted dates                                                                                                                                    |
| [I18N2-005](./i18n/0005-transfer-pane-select-all-matches-layout-mapped-key.md)                                | low      | regression          | I18N-011       | Transfer pane Ctrl/Cmd+A select-all matches layout-mapped event.key, bypassing the I18N-011 physical-key matcher                                                                                                                      |
| [PER2-005](./persistence-migration/0005-connection-stores-drop-unknown-top-level-fields.md)                   | low      | previous-incomplete | PER-010        | connections.json and external connection files drop unknown top-level fields on save; external files are rewritten on load with no version gate                                                                                       |
| [SEC2-007](./security/0007-sec-008-ssrf-guard-still-allows-the-alibaba-cloud-metadata-ip-and-aws.md)          | low      | previous-incomplete | SEC-008        | SEC-008 SSRF guard still allows the Alibaba Cloud metadata IP, and AWS IPv6 IMDS under the private-network opt-in                                                                                                                     |
| [TBE2-003](./test-backend/0003-docker-tests-skip-despite-require-docker.md)                                   | low      | previous-incomplete | TBE-006        | Docker test files added after TBE-006 skip silently even when TERMIHUB_REQUIRE_DOCKER=1 is set                                                                                                                                        |
| [TBE2-004](./test-backend/0004-plugin-runner-teardown-drop-order-untested.md)                                 | low      | regression          | TBE-010        | Plugin library drop-order tests were removed with the in-process path; the runner's teardown is now untested                                                                                                                          |
| [TOOL2-004](./tooling-coverage/0004-ci-local-drifted-behind-code-quality.md)                                  | low      | previous-incomplete | TOOL-006       | ci-local.sh claims to reproduce 'everything the per-PR CI runs' but has drifted well behind code-quality.yml                                                                                                                          |
| [UISF2-006](./ui-shared-foundation/0006-spinner-content-overlay-migration-incomplete.md)                      | low      | previous-incomplete | UISF-001       | Spinner/ContentOverlay migration incomplete: overlays still hand-roll Loader2 + per-component spin classes; FileBrowserTab re-implements the overlay without a live region                                                            |
| [UISF2-007](./ui-shared-foundation/0007-hand-rolled-empty-states-remain.md)                                   | low      | previous-incomplete | UISF-002       | About 35 hand-rolled empty/no-results placeholders remain beside ui/EmptyState, including in the consolidated management sidebars                                                                                                     |
| [WA-CI2-006](./workaround-ci-scripts/0006-sha-pinned-actions-have-no-update-mechanism-and-version-drif.md)    | low      | previous-incomplete | WA-CI-034      | SHA-pinned actions have no update mechanism and version drift has returned (WA-CI-034 half-done); cross-rs pin duplicated 4x without a consistency check                                                                              |
| [WA-FE2-004](./workaround-frontend/0004-silent-catch-handlers-have-returned-in-new-code-and-several.md)       | low      | regression          | WA-FE-005      | Silent `.catch(() => {})` handlers have returned in new code and several were never migrated to fireAndForget                                                                                                                         |
| [WA-FE2-005](./workaround-frontend/0005-cancellation-by-polling-persists-terminal-busy-sleep-loops-a.md)      | low      | regression          | WA-FE-012      | Cancellation by polling persists: Terminal busy-sleep loops and new workflow setInterval cancel polls                                                                                                                                 |
| [WA-FE2-006](./workaround-frontend/0006-exhaustive-deps-suppressions-grew-from-9-to-22-including-new.md)      | low      | regression          | WA-FE-011      | exhaustive-deps suppressions grew from 9 to 22, including new JSON.stringify dependency-key hacks                                                                                                                                     |
| [WA-RS2-003](./workaround-rust/0003-test-parent-watchdog-ships-in-release-agent.md)                           | low      | regression          | WA-RS-009      | The test-only parent-death watchdog ships in the release agent and is armed by an env var                                                                                                                                             |

## All medium findings (101)

### Product / feature completeness

- [PROD2-001](./product-completeness/0001-rdp-tabs-show-vnc-files-button.md) — RDP tabs show the VNC Files button and drop overlay, pointing to a File Transfer setting RDP does not have

### Connection-type parity

- [PARITY2-001](./connection-parity/0001-rdp-test-connection-false-success.md) — RDP 'Test connection' reports success without ever contacting the server
- [PARITY2-002](./connection-parity/0002-vnc-connect-no-timeout-no-cancel.md) — VNC initial connect has no timeout and cannot be cancelled: the graphical manager never passes a cancellation token
- [PARITY2-003](./connection-parity/0003-agent-sessions-no-chmod-chown-symlink.md) — Agent-hosted sessions never offer chmod/chown/symlink, although the agent RPC and RemoteFileBrowserProxy fully support them

### UX flows & feedback

- [UX2-001](./ux-flows/0001-tab-group-close-no-confirm.md) — Closing a tab group from its chip X or context menu kills every session in it with no confirmation
- [UX2-002](./ux-flows/0002-workspace-launch-palette-cli-no-confirm.md) — Workspace launch from the command palette or a forwarded --workspace still tears down live sessions without the UX-026 confirm
- [UX2-003](./ux-flows/0003-window-panel-close-discards-dirty-editors.md) — Closing a window or split panel silently discards unsaved editor tabs
- [UX2-004](./ux-flows/0004-editor-dialogs-dismiss-without-dirty-check.md) — Editor dialogs close on scrim click or Escape and discard work with no dirty check; Tunnel and Workspace editors' Cancel/Esc too
- [UX2-005](./ux-flows/0005-macos-cmd-q-skips-session-prompt.md) — macOS Cmd+Q / menu Quit appears to skip the detach-vs-terminate prompt and end every live session

### State-machine correctness

- [SM2-001](./state-machine-ux/0001-agent-disconnect-puts-hosted-tabs-into-unwinnable-reconnect-loop.md) — Disconnecting or shutting down an agent puts every hosted tab into a reconnect loop that cannot succeed (minutes of 'Reconnecting…', then a confusing failure)
- [SM2-002](./state-machine-ux/0002-agent-recovery-folds-ignore-tab-status-overwrite-user-stop.md) — The agent-recovery folds for lost, unconfirmed, failed and transport-break ignore the tab's current status, so a user Stop is overwritten and an ended tab can come back

### UI / visual design

- [UI2-001](./ui-visual/0001-portaled-menus-below-modal-scrim-and-banner.md) — Portaled Radix menus sit at --z-sticky (100), below the modal scrim and the update banner: the Open Connections 'Refresh interval' menu opens behind its modal
- [UI2-002](./ui-visual/0002-monaco-theme-keyed-on-id-not-color-scheme.md) — Monaco editor is themed by theme id === 'light', so Solarized Light and light custom/plugin themes get a dark editor

### Accessibility (WCAG 2.2)

- [A11Y2-001](./accessibility/0001-keyboard-shortcut-rebinding-is-mouse-only-binding-cell-is-a.md) — Keyboard shortcut rebinding is mouse-only (binding cell is a click-only <td>)
- [A11Y2-002](./accessibility/0002-connection-failure-disconnect-and-session-lost-overlays-are.md) — Connection failure, disconnect and session-lost overlays are not announced to assistive tech
- [A11Y2-003](./accessibility/0003-reordering-and-sidebar-resizing-are-pointer-drag-only-no-key.md) — Reordering and sidebar resizing are pointer-drag-only (no KeyboardSensor, no single-pointer alternative)
- [A11Y2-004](./accessibility/0004-command-palette-and-ssh-key-path-comboboxes-don-t-expose-the.md) — Command palette and SSH key-path comboboxes don't expose the active option (no aria-activedescendant)
- [A11Y2-005](./accessibility/0005-workspace-add-connection-picker-is-a-hand-rolled-modal-no-di.md) — Workspace 'Add Connection' picker is a hand-rolled modal: no dialog role, focus trap, Escape, or close-button name
- [A11Y2-006](./accessibility/0006-remote-desktop-canvas-captures-all-keys-with-an-undisclosed.md) — Remote-desktop canvas captures all keys with an undisclosed escape chord, no accessible name, and no focus indicator
- [A11Y2-007](./accessibility/0007-file-browser-rows-don-t-expose-type-file-vs-folder-selection.md) — File browser rows don't expose type (file vs folder), selection state, or sort state
- [A11Y2-008](./accessibility/0008-some-mouse-only-click-targets-workspace-group-chips-and-netw.md) — Some mouse-only click targets: workspace group chips and network-monitor rows
- [A11Y2-009](./accessibility/0009-zoom-overlay-swallows-escape-before-the-terminal-and-is-not.md) — Zoom overlay swallows Escape before the terminal and is not a modal dialog
- [A11Y2-010](./accessibility/0010-terminal-tab-badges-convey-dirty-broadcast-and-persistent-st.md) — Terminal tab badges convey dirty, broadcast and persistent state with no accessible text

### Architecture

- [ARCH2-001](./architecture-overall/0001-redrive-skips-saved-connection-binding-and-resume.md) — Backend reconnect redrive creates sessions without the saved-connection binding or transfer-resume trigger

### Backend Rust — core

- [CORE2-001](./backend-core-rust/0001-plugin-connect-blocks-tokio-worker.md) — Plugin connect/disconnect block a Tokio worker thread synchronously, for up to 30 s per connect, and ignore the cancel token
- [CORE2-002](./backend-core-rust/0002-ftp-unbounded-concurrent-sessions.md) — Embedded FTP server accepts unbounded concurrent control connections, each spawning its own libunftp server, loopback listener and relay

### Remote agent & protocol

- [AGT2-001](./agent-protocol/0001-desktop-stdout-utf8-split-across-chunks.md) — Desktop decodes agent stdout one SSH chunk at a time with from_utf8_lossy, so non-ASCII text split across chunks is corrupted
- [AGT2-002](./agent-protocol/0002-update-staging-fixed-shared-tmp-path-toctou.md) — Coordinated agent update stages the binary at a fixed, world-shared /tmp path and verifies it by path, then copies it by path again (TOCTOU, multi-user collision)
- [AGT2-003](./agent-protocol/0003-agt013-incomplete-desktop-reader-uncapped-quadratic.md) — AGT-013 fix missed the real desktop reader: agent stdout is accumulated into an uncapped String, with quadratic rescans and copies
- [AGT2-004](./agent-protocol/0004-agent-forward-connect-unbounded-no-flow-control.md) — agent.forward.connect (VNC/RDP over agent) relays bulk TCP through unbounded queues with no flow control

### Concurrency & reliability

- [CONC2-002](./concurrency-reliability/0002-desktop-sessions-mutex-held-across-blocking-write.md) — Desktop SessionManager holds the app-wide sessions mutex across blocking session writes and resizes
- [CONC2-003](./concurrency-reliability/0003-agent-sessions-mutex-held-across-reattach-and-query-buffer.md) — Agent SessionManager holds the per-agent sessions mutex across daemon detach/reconnect in reattach_held and across query_buffer
- [CONC2-004](./concurrency-reliability/0004-agent-reconnect-handshake-no-timeout.md) — Agent reconnect (and initial connect) handshake after SSH auth has no timeout, so a reconnect can hang forever in Reconnecting

### Frontend state layer

- [FES2-001](./frontend-state/0001-requestpassword-keeps-a-single-resolver-a-second-concurrent.md) — requestPassword keeps a single resolver: a second concurrent prompt overwrites the first, and the first connect hangs forever
- [FES2-002](./frontend-state/0002-movetabtowindow-removes-the-tab-from-the-source-window-witho.md) — moveTabToWindow removes the tab from the source window without the closeTab teardown (per-tab maps, session-lifecycle record, broadcast, persistent attachedTabIds)

### Frontend components & services

- [FEC2-001](./frontend-components/0001-imported-run-script-sourcepath-hidden-local-read.md) — Imported run-script steps read a hidden, unrestricted local file (sourcePath) and type its contents into the remote shell, ignoring the script shown in the editor

### Performance

- [PERF2-002](./performance/0002-no-xterm-pty-flow-control.md) — No flow control from xterm back to the PTY: output can overrun xterm's 50 MB write watermark, and the frontend buffer grows without limit
- [PERF2-003](./performance/0003-syntax-highlighting-breaks-after-scrollback-full.md) — Syntax highlighting breaks once scrollback is full: new lines are never scanned and existing decorations are disposed
- [PERF2-004](./performance/0004-webgl-context-per-terminal-tab.md) — Every terminal tab holds its own WebGL2 context forever; past the engine's active-context cap the oldest terminals lose WebGL for good

### Security

- [SEC2-001](./security/0001-plugin-filesystem-scope-an-empty-or-relative-filesystempaths-root-gran.md) — Plugin filesystem scope: an empty, "." or relative filesystemPaths root grants the whole filesystem through the bridge
- [SEC2-002](./security/0002-native-plugin-trust-acknowledgment-is-bound-only-to-the-library-hash-s.md) — Native-plugin trust acknowledgment is bound only to the library hash, so an update can widen permissions without new consent

### Dependencies & supply-chain

- [SUP2-001](./supply-chain/0001-release-gate-never-requires-the-rust-security-audit-cargo-audit-cargo.md) — Release gate never requires the Rust Security Audit (cargo audit / cargo deny / lockfile-freshness), and agent release binaries build without --locked
- [SUP2-002](./supply-chain/0002-release-sbom-job-runs-npx-yes-cyclonedx-cyclonedx-npm-with-an-unlocked.md) — Release SBOM job runs `npx --yes @cyclonedx/cyclonedx-npm` with an unlocked transitive tree and install scripts, under contents:write + id-token:write + attestations:write

### Test coverage — frontend

- [TFE2-001](./test-frontend/0001-agent-reconnect-resume-lost-disconnect-handler-in-terminalvi.md) — Agent reconnect resume/lost/disconnect handler in TerminalView has no coverage; its tests re-implement the handler instead of calling it
- [TFE2-002](./test-frontend/0002-coverage-ratchet-has-been-dead-since-4119-coverage-yml-is-no.md) — Coverage ratchet has been dead since #4119: coverage.yml is not on the default branch, so its nightly schedule never fires

### Test coverage — Rust

- [TBE2-001](./test-backend/0001-agent-tunnel-e2e-tests-run-in-no-ci-lane.md) — Agent-hosted tunnel end-to-end tests run in no CI lane, and a process-global verifier makes the unattended SSH tests order-dependent
- [TBE2-002](./test-backend/0002-sandbox-handshake-checks-untested-with-forged-frames.md) — The host's handshake checks on the untrusted runner have no test with forged frames

### Integration / E2E / test-bridge

- [TIN2-001](./test-integration/0001-nightly-bridge-lane-silent-skip.md) — Nightly bridge lane can still silently skip whole suites: strict-fixture mode stops at compose's exit code and there is no skip guard
- [TIN2-002](./test-integration/0002-serial-nightly-lanes-no-hang-guard.md) — Serial nightly lanes (Linux bulk, all display-grades legs) run without a hang guard

### Mocking & test doubles

- [MOCK2-001](./test-mocking/0001-rust-integration-tests-ignore-dev-local-json-a-plain-cargo-test-in-any.md) — Rust integration tests ignore dev.local.json: a plain `cargo test` in any slot runs against dev0's fixture ports while its container-control helpers target a container that does not exist
- [MOCK2-002](./test-mocking/0002-the-system-harness-edits-the-runner-s-real-ssh-known-hosts-with-a-non.md) — The system harness edits the runner's real ~/.ssh/known_hosts with a non-atomic read-modify-write and leaves stale entries behind when a run is killed

### Tooling & coverage gating

- [TOOL2-001](./tooling-coverage/0001-coverage-ratchet-and-nightly-lanes-dark-on-develop.md) — Coverage ratchet and every schedule-only nightly lane are switched off for develop because their workflow files are not on main
- [TOOL2-002](./tooling-coverage/0002-plugin-runner-rdp-sidecar-missing-no-panic-lint.md) — New plugin-runner crate (sandbox boundary) and the rdp-sidecar are not covered by the no-panic lint
- [TOOL2-003](./tooling-coverage/0003-coverage-ratchet-misses-plugin-crates-and-rdp-sidecar.md) — Coverage ratchet has no per-component gate for plugin-runner/plugin-api and does not measure rdp-sidecar at all

### Packaging & release

- [PKG2-003](./packaging-release/0003-prerelease-tag-rejected-by-msi-bundler.md) — The documented semver-prerelease tag path (vX.Y.Z-beta.1 / -rc.1) cannot build: the Windows MSI bundler rejects a non-numeric prerelease that the version gate requires
- [PKG2-004](./packaging-release/0004-install-smokes-run-after-mark-latest.md) — Install smokes run only after the Release workflow, including mark-latest, has finished: a stable release is promoted to 'Latest' and offered to clients before any macOS/Windows/Linux install smoke grades it
- [PKG2-005](./packaging-release/0005-macos-right-click-open-bypass-broken-on-15.md) — The macOS first-launch bypass shipped in every release body and the README (right-click → Open) no longer works on macOS 15+

### CI/CD pipeline

- [CI2-001](./ci-cd/0001-scheduled-lanes-in-workflows-that-exist-only-on.md) — Scheduled lanes in workflows that exist only on develop never fire (nightly/daily/weekly gates are dark)
- [CI2-002](./ci-cd/0002-develop-has-zero-required-status-checks-live-pr.md) — develop has zero required status checks live; PR Gate is required nowhere and the drift check cannot run
- [CI2-003](./ci-cd/0003-release-gate-does-not-require-the-rust-supply.md) — Release gate does not require the Rust supply-chain audit (cargo-deny/cargo-audit) on the release commit
- [CI2-004](./ci-cd/0004-coverage-fail-on-decrease-ratchet-has-not-run.md) — Coverage fail-on-decrease ratchet has not run since #4119 (schedule-only trigger never fires)
- [CI2-005](./ci-cd/0005-daily-cargo-update-lockfile-chore-ci-016-mitigation.md) — Daily cargo-update lockfile chore (CI-016 mitigation) has never run
- [CI2-006](./ci-cd/0006-platform-install-smoke-runs-after-the-release-is.md) — Platform install smoke runs after the release is published and marked latest, so it cannot gate users

### Error handling & edge cases

- [ERR2-001](./error-handling/0001-vnc-upload-stat-failure-overwrites-remote-file.md) — VNC side-channel upload treats any stat failure as 'name is free', so an existing remote file can be truncated

### Observability & logging

- [OBS2-001](./observability/0001-release-strip-unsymbolizable-backtraces.md) — Release builds strip symbols, so field crash reports and panic logs carry backtraces nobody can symbolize
- [OBS2-002](./observability/0002-agent-shared-log-rotation-loses-lines.md) — Agent processes share one rotating log file, so rotation in one process sends other processes' log lines to renamed or deleted archives
- [OBS2-003](./observability/0003-rdp-sidecar-stderr-lost.md) — RDP sidecar logs and panics go to an inherited stderr that is lost in the bundled app

### Persistence & migration

- [PER2-001](./persistence-migration/0001-agent-connections-store-no-cross-process-lock.md) — Agent connections.json (definitions store) has no cross-process lock; concurrent --stdio/--listen workers lose each other's saved connections
- [PER2-002](./persistence-migration/0002-macros-tunnels-bypass-version-gate.md) — macros.json and tunnels.json bypass the version gate, guard_not_newer and unknown-field preservation
- [PER2-003](./persistence-migration/0003-failed-master-password-change-rekeys-in-memory.md) — Failed master-password change leaves the vault re-keyed in memory, so the next credential save silently switches to the 'failed' password

### Internationalization

- [I18N2-001](./i18n/0001-elevated-sudo-save-classifies-wrong-password-by-english-stderr.md) — Elevated (sudo) save classifies wrong password by English sudo stderr with no C locale, so a stale stored sudo password is never cleared
- [I18N2-002](./i18n/0002-local-shells-lack-lang-when-launched-from-finder.md) — Local shells inherit no LANG/LC_CTYPE when the app is launched from Finder/Dock on macOS, so the shell runs in the C locale

### Documentation accuracy

- [DOC2-001](./docs-accuracy/0001-readme-native-plugin-trust-warning-contradicts-adr19.md) — README plugin trust warning says native plugins run in-process with full user privileges, contradicting ADR-19 / SECURITY.md sandbox
- [DOC2-002](./docs-accuracy/0002-contributing-new-backend-guide-describes-deleted-design.md) — contributing.md 'Adding a New Terminal Backend' guide describes the deleted TerminalBackend/TerminalManager design
- [DOC2-003](./docs-accuracy/0003-remote-protocol-omits-nine-rpc-methods.md) — remote-protocol.md omits nine RPC methods the agent registers and the desktop calls

### Marketing & presentation

- [MKT2-001](./marketing/0001-readme-plugin-trust-warning-contradicts-sandbox.md) — README plugin trust warning contradicts the shipped plugin sandbox (ADR-19) and default-off setting
- [MKT2-002](./marketing/0002-readme-experimental-features-presented-as-available.md) — README presents SSH Tunnels, Network Tools and Embedded Servers as available, but they are hidden behind the experimental toggle
- [MKT2-003](./marketing/0003-marketing-drafts-stale-docker-oversell.md) — docs/marketing launch drafts (the staged fixes for MKT-004/006/007/011) have gone stale and would reintroduce the Docker oversell
- [MKT2-004](./marketing/0004-readme-ssh-config-stale-auth-methods.md) — README SSH Configuration section is stale: only 2 of 4 auth methods, wrong default, no 2FA or agent forwarding

### Plugin & extensibility

- [PLG2-002](./plugin-extensibility/0002-the-settings-row-treats-any-recorded-ack-as-trusted-even-whe.md) — The Settings row treats any recorded ack as trusted even when its hash no longer matches the library, so after a plugin update the row says 'trusted', offers no Trust & Load, and the plugin silently stays unloaded
- [PLG2-003](./plugin-extensibility/0003-plugin-authoring-md-does-not-document-filesystempaths-or-con.md) — plugin-authoring.md does not document filesystemPaths or connectionPolicy, and its own example manifest fails to load (filesystem permission with no paths)
- [PLG2-004](./plugin-extensibility/0004-sandboxed-plugins-cannot-reach-the-os-certificate-trust-stor.md) — Sandboxed plugins cannot reach the OS certificate trust store (Linux landlock allow-list has no /etc/ssl; macOS deny-default blocks trustd), so TLS backends cannot use system or corporate CAs, and this is undocumented

### Workaround hunt — Rust

- [WA-RS2-001](./workaround-rust/0001-initial-command-hides-output-5s-on-unix.md) — A connection's initialCommand hides all terminal output for up to 5 s on macOS/Linux (a stale wait-for-clear workaround)

### Workaround hunt — frontend

- [WA-FE2-001](./workaround-frontend/0001-fitterminal-unconditionally-scrolls-to-the-bottom-on-every-s.md) — fitTerminal unconditionally scrolls to the bottom on every slot adoption, so zooming or moving a tab loses the user's scroll position
- [WA-FE2-002](./workaround-frontend/0002-coordinated-agent-update-reconnect-is-a-single-attempt-after.md) — Coordinated agent-update reconnect is a single attempt after a hardcoded 5s+3s delay, with no retry

### Workaround hunt — CI/scripts

- [WA-CI2-001](./workaround-ci-scripts/0001-scheduled-ci-lanes-never-run-their-workflow-files-are-not-on.md) — Scheduled CI lanes never run: their workflow files are not on the default branch (main)
- [WA-CI2-002](./workaround-ci-scripts/0002-release-gate-does-not-require-the-rust-supply-chain-audit-ca.md) — Release gate does not require the Rust supply-chain audit (cargo-deny / cargo-audit) on the release commit
- [WA-CI2-003](./workaround-ci-scripts/0003-bridge-harness-fixture-readiness-timeouts-still-degrade-to-a.md) — Bridge-harness fixture readiness timeouts still degrade to a silent pytest.skip under CI strict mode
- [WA-CI2-004](./workaround-ci-scripts/0004-develop-has-no-required-status-checks-live-so-pr-gate-is-adv.md) — develop has no required status checks live, so 'PR Gate' is advisory, and the lockfile bot recommends auto-merge on PRs that trigger no CI

### Dead-code & feature-flags

- [DEAD2-001](./deadcode-flags/0001-stop-x-server-when-idle-setting-ignored.md) — The 'Stop X Server When Idle' setting does nothing: the backend hard-codes stop-when-idle to true
- [DEAD2-002](./deadcode-flags/0002-graphical-state-machine-dead-reconnect-budget-serverclosed.md) — The graphical SessionStateMachine's reconnect budget and ServerClosed state are dead, so the 'Session closed by server' UI can never appear
- [DEAD2-003](./deadcode-flags/0003-orphaned-tauri-ipc-commands.md) — 24 registered Tauri IPC commands have no production caller; only their api.ts wrappers' unit tests invoke them

### Code duplication / core centralization

- [DUP2-001](./code-duplication/0001-desktop-finds-connection-secrets-by-the-literal-key-password-only-so-t.md) — Desktop finds connection secrets by the literal key `password` only, so the VNC SSH-gateway `sshPassword` (and plugin `format: password` fields) are written in plaintext to connections.json, external files and backups
- [DUP2-002](./code-duplication/0002-dup-009-only-half-fixed-the-desktop-still-splits-agent-ndjson-with-thr.md) — DUP-009 only half fixed: the desktop still splits agent NDJSON with three hand-rolled, uncapped String accumulators that decode lossy UTF-8 per chunk
- [DUP2-003](./code-duplication/0003-the-persistence-safety-layer-atomic-write-version-gate-corrupt-backup.md) — The persistence-safety layer (atomic write, version gate, corrupt backup) exists separately in desktop, agent and core::plugin, and the core::plugin copies dropped the fsync and version gate
- [DUP2-004](./code-duplication/0004-windows-current-user-sid-and-protected-dacl-ffi-is-duplicated-in-core.md) — Windows current-user SID and protected-DACL FFI is duplicated in core::ipc::local_socket and plugin-runner's pipe; only the runner copy fixed the TOKEN_USER alignment

### UI shared foundation

- [UISF2-001](./ui-shared-foundation/0001-connection-picker-bypasses-ui-modal.md) — WorkspaceEditor ConnectionPicker is a hand-rolled modal that bypasses ui/Modal: no dialog role, no Escape, no focus trap, unnamed close button
- [UISF2-002](./ui-shared-foundation/0002-segmented-radio-cards-bypass-radiogroup.md) — Segmented 'radio card' choices hand-roll radio semantics (wrong or missing ARIA, no arrow-key roving) instead of ui/RadioGroup
- [UISF2-003](./ui-shared-foundation/0003-rhf-zod-validity-block-copy-pasted-errors-hidden.md) — RHF+zod editors each copy-paste the same synchronous-validity block, and three of them never show their zod error messages

### Library usage (buy-vs-build) — FE

- [LIBFE2-001](./lib-usage-frontend/0001-hand-rolled-ansi-stripper-ignores-osc.md) — Hand-rolled ANSI stripper (two copies) ignores OSC sequences, so the output triggers and wait-for-output match against escape garbage

### Library usage (buy-vs-build) — BE

- [LIBBE2-001](./lib-usage-backend/0001-socks5-ipv6-atyp-unsupported.md) — Hand-rolled SOCKS5 server for dynamic (-D) tunnels rejects IPv6 (ATYP 0x04) targets and sends the wrong reply code

Low and info findings are listed only in their angle folders.
