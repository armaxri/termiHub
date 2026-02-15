# TermiHub — Claude Code Instructions

TermiHub is a cross-platform terminal hub built with Tauri 2 (Rust backend) + React 18 (TypeScript frontend). It supports local shells, SSH, serial, and telnet connections with VS Code-inspired UI, split views, drag-and-drop tabs, and SFTP file browsing. See [docs/architecture.md](../docs/architecture.md) for the full architecture documentation.

---

## Task Management

All work is tracked in **GitHub Issues**. Only pick up issues labeled **`Ready2Implement`**.

```bash
gh issue list --label Ready2Implement
```

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
  commands/                   # Tauri IPC command handlers
  events/                     # Event emitters
  utils/                      # shell_detect.rs, expand.rs, errors.rs
agent/                        # Future: Raspberry Pi remote agent
docs/                         # All documentation
tests/e2e/                    # WebdriverIO E2E tests
examples/                     # Docker test environment
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

### General
- Max ~500 lines per file, ~50 lines per function
- Single Responsibility Principle
- Clear, descriptive naming

---

## Git Workflow

- **Branch from `main`**: `feature/<description>` or `bugfix/<description>`
- **Never commit directly to `main`**
- **Conventional Commits**: `type(scope): subject` — types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`
- **Scopes**: `terminal`, `ssh`, `serial`, `ui`, `backend`, `sftp`, `config`
- **Always merge with a merge commit** (`gh pr merge --merge`) — never squash or rebase
- **Commit early and often** — each logical step gets its own commit:
  - Refactors separate from new features
  - Config changes separate from source changes
  - Formatting/lint fixes separate from functional changes
- **Update CHANGELOG.md** for every user-facing change (Keep a Changelog format, under `[Unreleased]`)

---

## Development Commands

```bash
# Frontend
pnpm run lint            # ESLint
pnpm run format:check    # Prettier (format to auto-fix)
pnpm test                # Vitest single run
pnpm test:watch          # Vitest watch mode
pnpm test:coverage       # Vitest with coverage
pnpm build               # TypeScript check + Vite build
pnpm test:e2e            # WebdriverIO E2E (requires built app)

# Rust
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test

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
7. Test on target platform, run `cargo clippy` and `pnpm build`

---

## Key References

- [Architecture](../docs/architecture.md) — Full arc42 architecture documentation
- [Contributing](../docs/contributing.md) — Development workflow and coding standards
- [Testing Strategy](../docs/testing.md) — Automated and manual testing approach
- [Manual Testing](../docs/manual-testing.md) — Hardware-dependent test plan
- [Building](../docs/building.md) — Platform-specific build instructions
- [Releasing](../docs/releasing.md) — Release process and version management
