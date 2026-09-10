# termiHub full-stack audit — consolidated index

**668 findings** across **38 expert angles**, on branch `audit/2026-09-full-audit`.

| Severity | Count |
|---|---|
| critical | 7 |
| high | 139 |
| medium | 316 |
| low | 184 |
| info | 22 |
| **total** | **668** |

**154 findings are flagged `is_workaround: true`** (the remove-before-release set).

Each finding is one file under `audit/<angle>/NNNN-*.md`; each angle has a `_summary.md`. See `RELEASE-BLOCKERS.md` for the ranked release-gating synthesis.

## Findings by angle

| Angle | Findings | C | H | M | L | I | Workarounds |
|---|--:|--:|--:|--:|--:|--:|--:|
| [Remote agent & protocol](./agent-protocol/) | 28 | 2 | 6 | 13 | 6 | 1 | 2 |
| [CI/CD pipeline](./ci-cd/) | 22 | 1 | 9 | 7 | 5 | 0 | 8 |
| [State-machine correctness](./state-machine-ux/) | 29 | 1 | 8 | 9 | 10 | 1 | 4 |
| [Test coverage — Rust](./test-backend/) | 13 | 1 | 7 | 5 | 0 | 0 | 3 |
| [Internationalization](./i18n/) | 17 | 1 | 4 | 5 | 6 | 1 | 1 |
| [Persistence & migration](./persistence-migration/) | 10 | 1 | 4 | 4 | 1 | 0 | 0 |
| [Product / feature completeness](./product-completeness/) | 68 | 0 | 9 | 34 | 25 | 0 | 9 |
| [Backend Rust — core](./backend-core-rust/) | 38 | 0 | 11 | 23 | 4 | 0 | 0 |
| [UX flows & feedback](./ux-flows/) | 34 | 0 | 6 | 18 | 10 | 0 | 5 |
| [Code duplication / core centralization](./code-duplication/) | 30 | 0 | 4 | 15 | 11 | 0 | 2 |
| [Workaround hunt — CI/scripts](./workaround-ci-scripts/) | 36 | 0 | 3 | 11 | 15 | 7 | 36 |
| [Plugin & extensibility](./plugin-extensibility/) | 14 | 0 | 5 | 8 | 1 | 0 | 2 |
| [Security](./security/) | 13 | 0 | 5 | 5 | 3 | 0 | 1 |
| [Concurrency & reliability](./concurrency-reliability/) | 14 | 0 | 4 | 6 | 4 | 0 | 0 |
| [Marketing & presentation](./marketing/) | 14 | 0 | 4 | 6 | 4 | 0 | 1 |
| [Documentation accuracy](./docs-accuracy/) | 13 | 0 | 4 | 5 | 4 | 0 | 1 |
| [Connection-type parity](./connection-parity/) | 12 | 0 | 4 | 6 | 1 | 1 | 1 |
| [Error handling & edge cases](./error-handling/) | 10 | 0 | 4 | 5 | 1 | 0 | 5 |
| [Frontend components & services](./frontend-components/) | 20 | 0 | 3 | 9 | 8 | 0 | 7 |
| [Integration / E2E / test-bridge](./test-integration/) | 17 | 0 | 3 | 13 | 1 | 0 | 4 |
| [Backend Rust — src-tauri](./backend-tauri-rust/) | 14 | 0 | 3 | 6 | 4 | 1 | 4 |
| [Packaging & release](./packaging-release/) | 14 | 0 | 3 | 6 | 4 | 1 | 6 |
| [Tooling & coverage gating](./tooling-coverage/) | 14 | 0 | 3 | 9 | 2 | 0 | 1 |
| [Test coverage — frontend](./test-frontend/) | 12 | 0 | 3 | 6 | 2 | 1 | 0 |
| [UI shared foundation](./ui-shared-foundation/) | 20 | 0 | 2 | 13 | 5 | 0 | 0 |
| [Accessibility (WCAG 2.2)](./accessibility/) | 9 | 0 | 3 | 4 | 2 | 0 | 0 |
| [Dead-code & feature-flags](./deadcode-flags/) | 13 | 0 | 2 | 6 | 5 | 0 | 4 |
| [Observability & logging](./observability/) | 12 | 0 | 2 | 7 | 2 | 1 | 1 |
| [Performance](./performance/) | 12 | 0 | 2 | 7 | 3 | 0 | 3 |
| [Dependencies & supply-chain](./supply-chain/) | 12 | 0 | 2 | 6 | 4 | 0 | 6 |
| [Workaround hunt — frontend](./workaround-frontend/) | 12 | 0 | 2 | 3 | 7 | 0 | 12 |
| [Frontend state layer](./frontend-state/) | 11 | 0 | 2 | 7 | 2 | 0 | 3 |
| [Mocking & test doubles](./test-mocking/) | 11 | 0 | 2 | 7 | 2 | 0 | 4 |
| [Architecture](./architecture-overall/) | 11 | 0 | 1 | 9 | 1 | 0 | 2 |
| [Workaround hunt — Rust](./workaround-rust/) | 14 | 0 | 0 | 4 | 9 | 1 | 14 |
| [UI / visual design](./ui-visual/) | 12 | 0 | 0 | 6 | 6 | 0 | 2 |
| [Library usage (buy-vs-build) — BE](./lib-usage-backend/) | 7 | 0 | 0 | 2 | 2 | 3 | 0 |
| [Library usage (buy-vs-build) — FE](./lib-usage-frontend/) | 6 | 0 | 0 | 1 | 2 | 3 | 0 |

## All critical findings (7)

- **AGT-004** (agent-protocol) — Update apply path performs no integrity verification — checksum lives only in the self-update download
- **AGT-003** (agent-protocol) — Any initialized client can push an arbitrary binaryPath the agent copies over itself and execs (RCE-as-agent)
- **CI-002** (ci-cd) — --reruns 4 masks real regressions on the sole reconnect/integration grade
- **I18N-001** (i18n) — Destructive credential discard is gated on an English "auth failed" substring
- **PER-001** (persistence-migration) — No schema-version migration mechanism for any persisted store
- **SM-001** (state-machine-ux) — Reconnecting(phase=Idle) is a timer-less no-exit state when post-recovery connection.list fails
- **TBE-001** (test-backend) — SSH exec ExitSignal path is untested and a unit test entrenches the "signal = exit 0" bug

## All high findings (139)


**Accessibility (WCAG 2.2)**

- A11Y-001 — Connection-form inputs have no programmatic label (span, not label htmlFor)
- A11Y-002 — Connection-form validation errors are not announced or associated with their field
- A11Y-003 — Shared SidebarStatusDot conveys status by color alone with no text alternative

**Remote agent & protocol**

- AGT-001 — Remote file rename is broken — desktop sends {from,to}, agent requires {old_path,new_path}
- AGT-002 — --listen TCP mode is fully unauthenticated and shares sessions across sequential clients
- AGT-005 — Agent binaries are never signed; the checksum is served from the same channel as the binary
- AGT-009 — Remote file delete is broken — desktop omits the required isDirectory field and sends connection_id where the agent expects connectionId
- AGT-010 — Protocol version negotiation is decorative — desktop pins 0.3.0, the major-check is meaningless for 0.x, and nothing gates on the negotiated version
- AGT-015 — Shared per-user state.json + unscoped recovery — a second desktop silently evicts the first desktop's live persistent sessions

**Architecture**

- ARCH-001 — appStore.ts is an 8k-line god-module holding most frontend state

**Backend Rust — core**

- CORE-002 — NDJSON read_line has no maximum line length — unbounded memory on hostile input
- CORE-004 — SSH exec ignores ChannelMsg::ExitSignal — signal-killed command reads as exit 0
- CORE-005 — ssh_exec_with_stdin has no timeout — a stalled server hangs exec callers indefinitely
- CORE-008 — VNC framebuffer allocates from unbounded server-controlled dimensions (DoS / abort)
- CORE-015 — Telnet connect parses host:port as a literal SocketAddr — no DNS resolution
- CORE-016 — Local-shell reader holds the output-sender mutex across a blocking_send (deadlock/backpressure stall)
- CORE-021 — Embedded TFTP server buffers an entire client upload in memory (unauthenticated OOM)
- CORE-022 — Embedded TFTP server spawns an unbounded thread per request
- CORE-029 — PluginConnectionType drops the library before the backend it created — use-after-free
- CORE-030 — Plugin filesystem scope check is lexical-only — a symlink inside a root escapes the sandbox
- CORE-032 — Plugin package extraction reads entries unbounded and can follow symlink/recursive entries

**Backend Rust — src-tauri**

- TAURI-001 — NetworkManager initialised via &mut through a raw pointer cast from a shared State reference
- TAURI-004 — ~175 production lock/read/write().unwrap()/expect() panic on mutex poisoning
- TAURI-006 — Half-migrated projection architecture — 9/11 domains shadow, dual authority + dual-write

**CI/CD pipeline**

- CI-001 — Integration / reconnect / UI lane is dark on every PR
- CI-003 — Third-party GitHub Actions are not SHA-pinned
- CI-004 — cross fetched via curl | tar from releases/latest builds shipped agent binaries
- CI-006 — 16 Windows agent tests quarantined behind a non-blocking grade that never un-quarantines
- CI-007 — Release is published to the public before its assets are built
- CI-008 — Desktop bundles ship with no checksums and no real signatures
- CI-009 — No release version-drift gate; release-check.sh not wired into CI
- CI-013 — Windows leg runs the whole workspace, so one flaky suite reds every unrelated PR
- CI-017 — Required checks and branch protection live outside the repo and are unverifiable from source

**Code duplication / core centralization**

- DUP-001 — Centralize JSON-RPC request/response DTOs — defined only in agent, desktop rebuilds them as hand-written JSON
- DUP-010 — The session lifecycle/registry state machine is implemented twice (desktop and agent)
- DUP-011 — Output-forwarder loop duplicated; desktop defines a parallel EventEmitter instead of core OutputSink
- DUP-020 — The "desktop controls a service on a remote agent" control layer is copy-pasted across three managers

**Concurrency & reliability**

- CONC-001 — Agent ConnectionStore has an AB-BA lock-order inversion (deadlock)
- CONC-002 — Agent reconnect uses the non-cancellable blocking SSH connect; Disconnect cannot interrupt a hung reconnect
- CONC-003 — send_request blocks with no timeout; agent RPCs hang for the full reconnect window
- CONC-004 — Agent SessionManager::create holds the sessions mutex across daemon spawn + connect

**Connection-type parity**

- PARITY-001 — Port-forwarding / tunnels are hard-coded SSH-only
- PARITY-002 — System monitoring is SSH-only despite a generic capability flag
- PARITY-003 — Agent registry omits FTP/VNC/RDP/mock — agent connections are a subset of desktop
- PARITY-008 — Reconnect / resilience modelled inconsistently, with opposite defaults

**Dead-code & feature-flags**

- DEAD-001 — Mock remote-desktop test backend ships in the default build
- DEAD-004 — Layout is the one half-migrated domain — dual authority + gated fallback scaffolding

**Documentation accuracy**

- DOC-001 — Backend projection module headers still say "Shadow / not yet driving the live UI" after the migration completed
- DOC-002 — licensing.md contradicts code + THIRD_PARTY_LICENSES on VcXsrv redistribution; references a file/constant that no longer exist; counsel sign-off unchecked
- DOC-003 — README omits shipped connection types (RDP, VNC, FTP) that ship enabled-by-default
- DOC-011 — README omits two shipped, security-relevant subsystems — the on-launch GitHub update check and the native plugin system (no user-facing plugin trust warning)

**Error handling & edge cases**

- ERR-001 — ~297 lock-poison unwrap/expect panic sites, applied backwards vs the new poison-recovering stores
- ERR-002 — Frontend has no ERROR-level log channel, so swallowed and console-logged failures are invisible to users
- ERR-003 — Error type/variant is erased at every IPC boundary; frontend re-derives category by matching English substrings
- ERR-004 — Startup .expect() on config-dir creation crashes the app at launch, contradicting the stated fallback intent

**Frontend components & services**

- FEC-001 — Terminal reaches into xterm.js private internals for cell width
- FEC-004 — TransferQueue pause/resume/cancel/retry show success even when the IPC call fails
- FEC-010 — FileEditor "Save & Close" discards unsaved edits when the save did not actually succeed

**Frontend state layer**

- FES-001 — Connection and folder ids generated from bare Date.now() collide and silently overwrite entities
- FES-005 — Connection mutations apply a region intent and a disk-persist as two independent calls with no rollback — partial failure diverges the UI from disk (phantom resurrection)

**Internationalization**

- I18N-002 — Agent connection-error classifier keys entirely off English substrings
- I18N-003 — Docker file browser parses localized `stat %F` output without forcing a C locale
- I18N-004 — Docker file browser mtimes collapse to 1970 under a comma-decimal locale
- I18N-012 — No i18n framework or message catalog — every UI string is hardcoded English

**Marketing & presentation**

- MKT-001 — RDP/VNC remote-desktop is a real feature but is completely absent from the README
- MKT-002 — README Features list omits most of the shipped product (plugins, network tools, FTP, macros, multi-window, etc.)
- MKT-003 — README has no screenshots or GIFs for a visually-driven desktop app
- MKT-004 — No value proposition, differentiation, or competitive framing — the "why termiHub" is missing

**Observability & logging**

- OBS-001 — Frontend logs never reach the durable file or backend — LogViewer is in-memory only
- OBS-002 — No panic/crash reporting; panics leave no durable trace and backtraces lose line info

**Packaging & release**

- PKG-001 — Full test-bridge (CSP relaxation + JS injection + diagnostic routes) is compiled into the release binary, gated only by an env var
- PKG-003 — Auto-update integrity relies on a same-channel SHA-256 checksum, not a cryptographic signature (no authenticity guarantee)
- PKG-006 — No macOS or Windows install/launch smoke test in the release pipeline; Intel macOS DMG is cross-built and entirely unverified

**Performance**

- PERF-001 — Monaco + shiki are eagerly bundled into the main chunk via always-mounted SplitView
- PERF-002 — FileEditor loads whole files with no size guard, and remote files cross IPC as JSON number arrays

**Persistence & migration**

- PER-003 — workflows.json (macros/workflows) is written non-atomically (torn write → total loss)
- PER-004 — Corrupt/unrecognized store resets to defaults; a downgrade silently wipes the file to .bak
- PER-005 — No cross-process file locking; concurrent instances clobber every JSON store (last-writer-wins)
- PER-006 — Agent state.json — no lock, no version field, corrupt read silently discards all sessions

**Plugin & extensibility**

- PLG-001 — No published/versioned SDK crate — third parties cannot depend on the plugin ABI
- PLG-002 — Two decoupled version schemes — manifest apiVersion "1.0" vs native ABI u32=4
- PLG-003 — Exact-match ABI gate + rapid pre-release churn → every auto-update orphans all native plugins
- PLG-004 — Capability ceiling — plugin backends cannot reach built-in parity (no file browser, monitoring, graphical, persistent)
- PLG-006 — Inverted trust models — privileged native plugin gated only by an install ack; sandboxed JS is default-off

**Product / feature completeness**

- PROD-001 — SFTP browser cannot change file permissions (chmod) — mode is display-only
- PROD-004 — Copy/paste of a directory to a remote is unsupported; remote copy is a client round-trip
- PROD-009 — SFTP transfer Pause/Resume/Retry buttons are non-functional
- PROD-010 — FTP has a full transfer engine (progress/ETA/resume/retry) that the UI never calls
- PROD-014 — File editor has no large-file guard — whole file loaded into Monaco
- PROD-016 — Docker connections always run a NEW container; cannot exec into a running one
- PROD-022 — System monitoring works only for SSH connections
- PROD-028 — System monitoring has no process list and no process kill
- PROD-044 — Workflows are linear only — no conditionals, branching, loops, or wait-for-output

**Security**

- SEC-001 — SSH/Docker/serial passwords are run through shell env-expansion, corrupting or leaking secrets
- SEC-002 — Native plugin backends run in-process with full app privileges (inverted trust model)
- SEC-004 — Agent TCP listener (`--listen`) has no application-layer authentication
- SEC-007 — Embedded HTTP server directory listing injects filenames and URL path into HTML unescaped (stored/reflected XSS)
- SEC-008 — HTTP monitor fetches arbitrary user URLs with no SSRF protection (metadata endpoint reachable)

**State-machine correctness**

- SM-002 — Agent-task recover fold has no cancel guard — a user-stopped tab silently resurrects
- SM-003 — Session region keyed by per-client tab id violates its own "shared status" invariant; multi-desktop eviction leaves desktops permanently disagreeing
- SM-005 — Lifecycle machine has no auth-failed or host-key-prompt state — both collapse into Connecting/Failed
- SM-011 — Tab-strip status dot renders from an untyped remoteStates map that is blind to sessionLost/failed
- SM-012 — Agent-mediated system monitoring shows stale data as live forever (no Stale/Reconnecting/Offline)
- SM-020 — Reconnect is modeled at least three inconsistent ways across subsystems (vocabulary + retry-cap drift)
- SM-024 — Layout freezes on a stale panel tree when composeLayoutFromView returns null (the #2562 stuck-state)
- SM-025 — Two app instances clobber the shared last-session/workspace files (cross-instance data loss)

**Dependencies & supply-chain**

- SUP-001 — RDP sidecar's 556-crate graph (incl. pre-release CredSSP crypto + a vendored fork) escapes every supply-chain gate
- SUP-002 — The SSH/auth crypto path is built entirely on pre-release (-rc/-pre) RustCrypto crates

**Test coverage — Rust**

- TBE-002 — NDJSON read_line has no length bound and no hostile-input test
- TBE-003 — VNC tests run against a mock that clamps dimensions; the real frame path does not
- TBE-006 — require_docker! silently skips (green) so integration tests pass when the fixture is absent
- TBE-007 — No enforced Rust coverage gate (frontend has one, backend has none)
- TBE-008 — Agent session manager has no multi-client concurrency test; AB-BA deadlock is invisible
- TBE-009 — Wire-contract and backend behavior are covered only by the dark integration lane, unverified per-PR
- TBE-010 — Plugin FFI teardown/drop-order soundness has no test; use-after-free on unload is invisible

**Test coverage — frontend**

- TFE-001 — Coverage include glob excludes .tsx, hiding untested components from the gate
- TFE-002 — Terminal connect/reconnect state machine is untestable (logic inside effects, 46% branch)
- TFE-005 — God store appStore.ts error/rejection branches ~1/3 untested (66% branch)

**Integration / E2E / test-bridge**

- TIN-001 — Whole integration/E2E lane is dark per-PR — real backends and app-launch suites never run on a PR
- TIN-002 — Nightly integration lane retries every failure 4× and scales all waits 2× — masks flakes and real regressions
- TIN-005 — RDP has zero integration/E2E coverage — the entire connection type is manual-only

**Mocking & test doubles**

- MOCK-001 — Mock remote-desktop test backend ships in the DEFAULT build and is a user-selectable connection type
- MOCK-002 — TestBridge remote-control hook + test_sever_agent_transport command ship in production, runtime-enableable via localStorage/URL

**Tooling & coverage gating**

- TOOL-001 — No unified whole-app coverage number or release gate (frontend + Rust)
- TOOL-002 — Frontend coverage include glob omits .tsx — components invisible to the gate
- TOOL-003 — No Rust coverage tooling or gate despite a documented >80% target

**UI shared foundation**

- UISF-011 — react-hook-form + zod used in exactly one form; every other editor hand-rolls useState + manual validation
- UISF-014 — JumpHostEntry hand-renders a full SSH sub-connection form instead of the schema-driven DynamicForm

**UX flows & feedback**

- UX-001 — Connections panel has no first-run empty state or create-first-connection CTA
- UX-002 — Tunnels, Services, Network Tools and Workflows are hidden behind an experimental flag
- UX-016 — Transfer Pause/Resume/Retry are no-ops for SSH/SFTP yet always toast success
- UX-018 — File editor has no large-file guard — opening a big remote file can freeze the app
- UX-026 — Launching a workspace tears down all live sessions with no confirmation
- UX-033 — ~45 async actions swallow errors, so operations can fail with no feedback

**Workaround hunt — CI/scripts**

- WA-CI-001 — 16 live-agent-TCP tests quarantined on Windows via #[cfg_attr(windows, ignore)]
- WA-CI-004 — Integration tests excluded from per-PR CI — the integration lane is dark on PRs
- WA-CI-018 — macOS release DMG is ad-hoc signed (codesign -s -) with errors swallowed by || true

**Workaround hunt — frontend**

- WA-FE-001 — Reach into xterm.js private internals (_core._renderService) for cell width
- WA-FE-002 — User-facing agent "Allow self-update" toggle persists a preference for an unimplemented feature
