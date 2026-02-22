# termiHub — Claude Code Instructions

termiHub is a cross-platform terminal hub built with Tauri 2 (Rust backend) + React 18 (TypeScript frontend). It supports local shells, SSH, serial, and telnet connections with VS Code-inspired UI, split views, drag-and-drop tabs, and SFTP file browsing. See [docs/architecture.md](../docs/architecture.md) for the full architecture documentation.

---

## Task Management

All work is tracked in **GitHub Issues**. Pick up issues labeled **`Ready2Implement`** (for implementation) or **`Concept`** (for concept/design work only).

```bash
gh issue list --label Ready2Implement
gh issue list --label Concept
```

- **Always confirm before implementing**: when picking up an issue, first show the user the issue title and description and ask for confirmation before starting any work
- **Assign yourself to picked issues**: when picking up an issue, determine the current GitHub user via `gh api user -q .login` and assign them to the issue with `gh issue edit <N> --add-assignee <login>`. Before starting work, check if the issue already has an assignee — if so, warn the user that someone else may already be working on it (check for existing branches like `feature/*` or `bugfix/*` referencing the issue number)
- Reference issue numbers in commits and PRs (`Closes #N` / `Fixes #N`)
- Create new issues for work discovered during development and label them appropriately

### Concept Issues

Issues labeled **`Concept`** are design-only tasks. Do **not** implement code for these — only produce a concept document.

1. Create the concept document at `docs/concepts/<kebab-case-concept-name>.md`
2. The document must contain these sections:
   - **Overview** — the basic idea and motivation
   - **UI Interface** — detailed description from the user's perspective (screens, controls, interactions, visual layout). Be as specific as possible.
   - **General Handling** — workflows, user journeys, edge cases
   - **States & Sequences** — use Mermaid.js diagrams (state diagrams, sequence diagrams, flowcharts as appropriate)
   - **Preliminary Implementation Details** — based on the current project architecture at the time of concept creation. Note that the codebase may evolve between concept creation and implementation; this section captures the planned approach given the current state.
3. Use Mermaid.js diagrams liberally throughout all sections (not just States & Sequences) — wherever a diagram aids understanding
4. Reference the GitHub issue number in the document header
5. Commit with `docs(concept): add concept for <name> (Closes #N)`

---

## Project Structure

```
src/                          # React frontend
  components/                 # ActivityBar/, Sidebar/, Terminal/, SplitView/, Settings/
  hooks/                      # useTerminal, useConnections, useKeyboardShortcuts, etc.
  services/                   # api.ts (Tauri commands), events.ts (Tauri events)
  store/                      # appStore.ts (Zustand)
  types/                      # terminal.ts, connection.ts, events.ts
  utils/                      # formatters, shell detection, panelTree
src-tauri/src/                # Rust backend (desktop)
  terminal/                   # backend.rs (trait), manager.rs, local_shell.rs, serial.rs, ssh.rs, telnet.rs
  connection/                 # config.rs, manager.rs, storage.rs
  files/                      # sftp.rs, local.rs, browser.rs, utils.rs
  monitoring/                 # SSH remote system monitoring (CPU, memory, disk, etc.)
  commands/                   # Tauri IPC command handlers
  events/                     # Event emitters
  utils/                      # shell_detect.rs, expand.rs, errors.rs
core/src/                     # Shared Rust core library (termihub-core)
  buffer/                     # RingBuffer (1 MiB circular byte buffer)
  config/                     # ShellConfig, SshConfig, DockerConfig, SerialConfig, PtySize
  errors.rs                   # CoreError, SessionError, FileError
  files/                      # FileBackend trait, LocalFileBackend, FileEntry, utilities
  monitoring/                 # SystemStats, CpuCounters, StatsCollector trait, parsers
  output/                     # OutputCoalescer, screen-clear detection
  protocol/                   # JSON-RPC message types and error codes
  session/                    # Transport traits (OutputSink, ProcessSpawner, ProcessHandle),
                              # shell/SSH/Docker/serial command builders and validators
agent/                        # Remote agent (JSON-RPC over SSH)
  src/
    daemon/                   # Session daemon process and binary frame protocol
    shell/                    # ShellBackend (daemon client for shell sessions)
    docker/                   # DockerBackend (Docker container sessions)
    ssh/                      # SshBackend (SSH jump host sessions)
    serial/                   # SerialBackend (direct serial port access)
    session/                  # SessionManager, types, prepared connection definitions
    files/                    # File browsing (local, SFTP relay, Docker)
    monitoring/               # System monitoring (delegates to core parsers)
    handler/                  # JSON-RPC method dispatcher
    protocol/                 # Protocol types, methods, error codes
    state/                    # Session state persistence (state.json)
    io/                       # Transport layer (stdio, TCP)
    transport.rs              # Core trait adapters (OutputSink, ProcessSpawner, etc.)
    main.rs                   # Entry point (--stdio, --listen, --daemon)
scripts/                      # Dev helper scripts (.sh + .cmd variants)
docs/                         # All documentation
  concepts/                   # Concept documents for "Concept" labeled issues
tests/e2e/                    # WebdriverIO E2E tests
examples/                     # Docker test environment (SSH, Telnet, virtual serial)
```

---

## Coding Standards

### TypeScript / React
- No `any` types
- One component per file with named exports
- Props interface always defined
- Hooks first, then event handlers, then render
- JSDoc for public functions
- Naming: `PascalCase` components, `camelCase` functions/hooks, `UPPER_SNAKE_CASE` constants

### Rust
- No `.unwrap()` in production code — use `?` with `anyhow::Result`
- Add context to errors: `.context("description")`
- Doc comments (`///`) for public APIs
- `tokio` for async, channels for communication
- Naming: `PascalCase` types/traits, `snake_case` functions/modules, `UPPER_SNAKE_CASE` constants
- **Cross-platform awareness**: termiHub builds on Windows, macOS, and Linux. Gate platform-specific code with `#[cfg(windows)]`, `#[cfg(unix)]`, etc. — on functions, imports, and tests. CI runs on all platforms, so ungated platform-specific code will fail the build.

### Testing
- Every bug fix and feature should include verification that the change works correctly, in order of preference:
  1. **Unit tests** (preferred) — fast, isolated, verify specific behavior
  2. **System/integration tests** — when unit tests aren't feasible (e.g., hardware, full app lifecycle)
  3. **Documented manual test steps** — last resort for things that can't be automated (e.g., visual rendering, platform-specific hardware)
- No change should ship without at least one of the above
- For bug fixes, add a regression test that would fail without the fix (when possible)
- **Manual test tracking**: When a PR includes manual test steps (in the PR description's "Test plan" section), also add those steps to `docs/manual-tests-input.md` under the appropriate feature area heading, referencing the PR number. This keeps manual tests discoverable and prevents them from being forgotten after merge.
- **E2E platform constraint**: `tauri-driver` only supports Linux and Windows — it does **not** work on macOS (no WKWebView driver exists). E2E system tests run inside Docker (Linux) on all platforms. See ADR-5 in [architecture.md](../docs/architecture.md). macOS-specific behavior must be verified via manual tests.

### General
- Max ~500 lines per file, ~50 lines per function
- Single Responsibility Principle
- Clear, descriptive naming
- **Prefer Mermaid.js diagrams** in documentation wherever they aid understanding (flowcharts, sequence diagrams, state diagrams, etc.)

---

## Git Workflow

- **Always pull `origin/main` before starting new work**: run `git fetch origin && git checkout origin/main` before creating a feature branch — never branch from a stale local `main`
- **Branch from `main`**: `feature/<description>` or `bugfix/<description>`
- **Never commit directly to `main`**
- **Never push directly to `main`**: all changes must be submitted via pull request — no exceptions, even for documentation-only changes
- **Every change requires a PR**: create a feature or bugfix branch, push it to `origin`, and open a pull request. Direct pushes to `main` are prohibited.
- **Conventional Commits**: `type(scope): subject` — types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`
- **Scopes**: `terminal`, `ssh`, `serial`, `ui`, `backend`, `sftp`, `config`
- **Always merge with a merge commit** (`gh pr merge --merge`) — never squash or rebase, never rebase branches
- **Commit early and often** — commit as soon as a single logical topic is complete (a single topic = a single commit). Do not batch multiple topics into one commit. Each logical step gets its own commit:
  - Refactors separate from new features
  - Config changes separate from source changes
  - Formatting/lint fixes separate from functional changes
- **Never pull or fetch before committing**: always commit local changes first before any git operations that touch the remote (fetch, pull, merge). Uncommitted work must never be at risk from remote operations.
- **Update CHANGELOG.md** for every user-facing change (Keep a Changelog format, under `[Unreleased]`)
- **Merge `origin/main` before creating a PR** (never rebase): before pushing the final branch and opening a PR, always `git fetch origin && git merge origin/main` into the feature branch, resolve any conflicts, and re-run tests/checks to ensure the branch is up to date and clean. Always use merge, never rebase.

---

## Development Scripts

All scripts live in `scripts/` with `.sh` (Unix/macOS) and `.cmd` (Windows) variants. They can be run from anywhere in the repo. See [scripts/README.md](../scripts/README.md) for details.

| Script | Purpose |
|--------|---------|
| `./scripts/setup.sh` | Install all dependencies and do an initial build |
| `./scripts/dev.sh` | Start the app in dev mode with hot-reload |
| `./scripts/build.sh` | Build for production (creates platform installer) |
| `./scripts/test.sh` | Run all unit tests (frontend + backend + agent) |
| `./scripts/check.sh` | Read-only quality checks mirroring CI (formatting, linting, clippy) |
| `./scripts/format.sh` | Auto-fix all formatting issues (Prettier + cargo fmt) |
| `./scripts/autoformat.sh` | Auto-format a single file (called by PostToolUse hook — do not run manually) |
| `./scripts/clean.sh` | Remove all build artifacts for a fresh start |
| `./scripts/test-system.sh` | Start Docker infra + virtual serial ports and run system-level E2E tests (Linux via Docker; `tauri-driver` does not support macOS — see ADR-5 in [architecture.md](../docs/architecture.md)) |

### Auto-Formatting Hook

A PostToolUse hook in `.claude/settings.json` runs `scripts/autoformat.sh` after every Edit/Write, automatically applying Prettier (TS/JS/CSS) and rustfmt (Rust). No manual formatting step is needed during development.

### Pre-Push Checklist (Internal Tasks)

**Before pushing or creating a PR**, complete all outstanding internal tasks first. Do not defer these to after pushing. When the user asks to push, **stop and report** which of the following items are still pending, then ask for permission before proceeding:

1. **CHANGELOG.md** — updated for every user-facing change (under `[Unreleased]`)
2. **docs/manual-tests-input.md** — updated if the PR includes manual test steps
3. **Concept documents** — if working on a `Concept` issue, ensure `docs/concepts/<name>.md` is written and committed
4. **Other documentation** — any doc updates implied by the changes (architecture.md, README references, JSDoc, doc comments, etc.)
5. **Formatting** — run `./scripts/format.sh` and commit any formatting fixes as a separate commit
6. **Quality checks** — run `./scripts/check.sh` to verify linting, formatting, and clippy pass

**Workflow when user asks to push:**
1. Review the list above against the current branch's changes
2. List any items that are incomplete or skipped
3. Ask the user for permission: either complete the remaining items first, or push as-is
4. Only push after the user confirms

### Before Creating a PR

Always run these before pushing:

```bash
./scripts/test.sh      # Run all unit tests (frontend + backend + agent)
./scripts/check.sh     # Read-only quality checks mirroring CI
```

### Individual Commands (when you need just one tool)

```bash
# Frontend
pnpm run lint            # ESLint
pnpm run format:check    # Prettier check (format to auto-fix)
pnpm test                # Vitest single run
pnpm test:watch          # Vitest watch mode
pnpm test:coverage       # Vitest with coverage
pnpm build               # TypeScript check + Vite build
pnpm test:e2e            # WebdriverIO E2E (requires built app)

# Rust workspace (all crates)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features

# Dev server
pnpm tauri dev
```

---

## Adding a New Terminal Backend

1. Implement `TerminalBackend` trait in `src-tauri/src/terminal/`
2. Register with `TerminalManager` in `manager.rs`
3. Add Tauri commands in `src-tauri/src/commands/` if needed
4. Add config types in `connection/config.rs` (Rust) and `src/types/terminal.ts` (TypeScript)
5. Create settings UI in `src/components/Settings/`
6. Add to connection type selector in `ConnectionEditor.tsx`
7. Test on target platform, run `./scripts/check.sh`

---

## Key References

- [Architecture](../docs/architecture.md) — Full arc42 architecture documentation
- [Contributing](../docs/contributing.md) — Development workflow and coding standards
- [Testing Strategy](../docs/testing.md) — Automated and manual testing approach
- [Manual Testing](../docs/manual-testing.md) — Hardware-dependent test plan
- [Manual Tests Input](../docs/manual-tests-input.md) — Collected manual test steps from PRs
- [Performance](../docs/performance.md) — Profiling guide and baseline metrics
- [Building](../docs/building.md) — Platform-specific build instructions
- [Releasing](../docs/releasing.md) — Release process and version management
- [Remote Protocol](../docs/remote-protocol.md) — Desktop-to-agent JSON-RPC specification
- [Concepts](../docs/concepts/) — Design concept documents for `Concept` labeled issues
- [Scripts](../scripts/README.md) — Development helper scripts
