# TermiHub — Claude Code Instructions

TermiHub is a cross-platform terminal hub built with Tauri 2 (Rust backend) + React 18 (TypeScript frontend). It supports local shells, SSH, serial, and telnet connections with VS Code-inspired UI, split views, drag-and-drop tabs, and SFTP file browsing. See [docs/architecture.md](../docs/architecture.md) for the full architecture documentation.

---

## Task Management

All work is tracked in **GitHub Issues**. Only pick up issues labeled **`Ready2Implement`**.

```bash
gh issue list --label Ready2Implement
```

- **Always confirm before implementing**: when picking up an issue, first show the user the issue title and description and ask for confirmation before starting any implementation work
- Reference issue numbers in commits and PRs (`Closes #N` / `Fixes #N`)
- Create new issues for work discovered during development and label them appropriately

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
src-tauri/src/                # Rust backend
  terminal/                   # backend.rs (trait), manager.rs, local_shell.rs, serial.rs, ssh.rs, telnet.rs
  connection/                 # config.rs, manager.rs, storage.rs
  files/                      # sftp.rs, local.rs, browser.rs, utils.rs
  monitoring/                 # SSH remote system monitoring (CPU, memory, disk, etc.)
  commands/                   # Tauri IPC command handlers
  events/                     # Event emitters
  utils/                      # shell_detect.rs, expand.rs, errors.rs
agent/                        # Raspberry Pi remote agent (JSON-RPC over SSH)
scripts/                      # Dev helper scripts (.sh + .cmd variants)
docs/                         # All documentation
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

### Testing
- Every bug fix and feature should include verification that the change works correctly, in order of preference:
  1. **Unit tests** (preferred) — fast, isolated, verify specific behavior
  2. **System/integration tests** — when unit tests aren't feasible (e.g., hardware, full app lifecycle)
  3. **Documented manual test steps** — last resort for things that can't be automated (e.g., visual rendering, platform-specific hardware)
- No change should ship without at least one of the above
- For bug fixes, add a regression test that would fail without the fix (when possible)

### General
- Max ~500 lines per file, ~50 lines per function
- Single Responsibility Principle
- Clear, descriptive naming

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
| `./scripts/clean.sh` | Remove all build artifacts for a fresh start |

### Before Creating a PR

Always run these before pushing:

```bash
./scripts/format.sh    # Auto-fix formatting (Prettier + cargo fmt)
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

# Rust backend
cd src-tauri && cargo fmt --all -- --check
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
cd src-tauri && cargo test

# Agent
cd agent && cargo fmt --check
cd agent && cargo clippy --all-targets --all-features -- -D warnings
cd agent && cargo test

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
- [Performance](../docs/performance.md) — Profiling guide and baseline metrics
- [Building](../docs/building.md) — Platform-specific build instructions
- [Releasing](../docs/releasing.md) — Release process and version management
- [Remote Protocol](../docs/remote-protocol.md) — Desktop-to-agent JSON-RPC specification
- [Scripts](../scripts/README.md) — Development helper scripts
