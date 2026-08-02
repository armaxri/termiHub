# termiHub — Claude Code Instructions

termiHub is a cross-platform terminal hub built with Tauri 2 (Rust backend) + React 18 (TypeScript frontend). It supports local shells, SSH, serial, and telnet connections with VS Code-inspired UI, split views, drag-and-drop tabs, and SFTP file browsing. See [docs/architecture.md](../docs/architecture.md) for the full architecture documentation.

> **Connection monitoring**: The **Open Connections panel** (`src/components/OpenConnections/OpenConnectionsModal.tsx`) is the primary place to inspect and kill all open connections across every subsystem. It is accessible from the Settings wheel menu in the Activity Bar and covers local sessions, agent connections, sessions on agents, SSH tunnels, SFTP, and monitoring. When investigating connection leaks or resource cleanup issues, start here.

---

## Task Management

All work is tracked in **GitHub Issues**. Pick up issues labeled **`Ready2Implement`** (for implementation) or **`Concept`** (for concept/design work only).

```bash
gh issue list --label Ready2Implement
gh issue list --label Concept
```

- **Always confirm before implementing**: when picking up an issue, first show the user the issue title and description and ask for confirmation before starting any work
- **Assignment happens ONLY when _taking_ an issue to implement it — never at creation time**: when (and only when) picking up an existing issue to start work on it, determine the current GitHub user via `gh api user -q .login` and assign them with `gh issue edit <N> --add-assignee <login>`. Before starting work, check if the issue already has an assignee — if so, warn the user that someone else may already be working on it (check for existing branches like `feature/*` or `bugfix/*` referencing the issue number)
- Reference issue numbers in commits and PRs (`Closes #N` / `Fixes #N`)
- Create new issues for work discovered during development and label them appropriately. **Never add an assignee when _creating_ an issue** — not the user, not yourself. Newly created issues are always left unassigned so anyone can pick them up; assigning is exclusively the "taking an issue" action above.
- **Automatically file follow-up issues for deferred or discovered work — do this without being asked.** Whenever you finish an issue but leave something behind, open a follow-up issue as part of wrapping up (not a question for the user). File one when any of these hold:
  - You deliberately narrowed scope to keep a PR reviewable (e.g. migrated some of N groups, "one group per PR").
  - You found work that is genuinely out of the current issue's scope (an adjacent component, a related bug, a latent issue).
  - The issue's stated acceptance / "done when" is only partially met, or a ratchet/allowlist/TODO still has pending entries that a later change must clear.
  - You noted "left for a follow-up", "out of scope", or "worth a dedicated change" anywhere in your report, commits, or PR body.

  Each follow-up issue must: reference the originating issue and PR (e.g. "Follow-up to #N (PR #M)"); carry the right label (`Ready2Implement` for actionable work, `Concept` for design-only); stay **unassigned**; and give a concrete **Scope** checklist plus a **Done when** criterion. Then link it from the originating PR body so the deferral is traceable. Prefer one precise follow-up per distinct piece of deferred work over a single vague catch-all.

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

### AI-Driven Concept Workflow (Single-File HTML Concepts)

For features with a **visual surface worth mocking up**, author the concept as a **single
self-contained HTML file** — `docs/concepts/<status>/<name>.html` — instead of a plain `.md`. One
file holds everything: prose (the standard concept sections), Mermaid diagrams, the mockups, and
the sync ledger. This is a **design-first loop**: the file is both the human discussion medium
(opened in a browser) and Claude Code's implementation target. Full design:
[`docs/concepts/implemented/ai-driven-concept-workflow.html`](../docs/concepts/implemented/ai-driven-concept-workflow.html).
(Concepts with **no** visual surface stay a single `.md` — see the Concept Issues section above.)

**Three fixed rules:**

1. **Concept drives code (source of truth).** When the concept and code disagree, the **concept is
   authoritative** — fix the code by default. Only when a real constraint (platform, library,
   performance) makes the design wrong do you change the **concept** instead — never silently
   absorb the divergence into code.
2. **Hand-written, layout-altitude mockups that look like termiHub.** Mockups show **structure
   and states**, not pixels — but they must read as the real app, not a generic dark IDE. So:
   - **Reuse the real component class names** from `docs/concepts/_assets/mockup.css`
     (`.activity-bar__item`, `.tab`, `.terminal-view__toolbar`, `.status-bar`,
     `.connection-tree__item`, `.menu`, …) — the kit mirrors the app's actual BEM classes and theme
     values, so the mockup DOM matches the real DOM and doubles as a precise implementation target.
   - **Use real lucide icons**, never unicode glyphs: add the needed `<symbol>` to the inline sprite
     and reference `<svg class="li"><use href="#i-name" /></svg>`.
     (Glyphs like `◉`/`⫽` were the main reason early drafts didn't look like termiHub.)
   - The file links only the shared `_assets/` (`mockup.css`, `concept.css`, `mermaid.min.js`) and
     never imports app code, so it can describe not-yet-built features. Mockups may be
     "directionally right, not current" between syncs.
3. **Sync is human-triggered.** Reconciliation happens only via the `/sync-concept <name>` skill —
   never automatically.

**Single-file layout** (one HTML per concept, in the usual status dirs):

```
docs/concepts/<status>/<name>.html   # everything: prose + Mermaid + mockups + sync ledger
docs/concepts/_assets/
  concept-template.html              # copy-me scaffold (sections + sprite + Mermaid init)
  concept.css                        # document styling (prose/tables/diagram cards)
  mockup.css                         # app-chrome kit (real BEM class names + tokens)
  mermaid.min.js                     # vendored, pinned — diagrams render offline in the browser
```

Inside the file: prose uses `concept.css` classes; **Mermaid** goes in
`<pre class="mermaid">…</pre>` (kept as editable text, rendered client-side on load); **mockups**
are `<section>`s using the real `mockup.css` classes; the **sync ledger** is the final `<section
id="sync">`. Because it's HTML, it renders in a browser (not on github.com — that shows raw
source), so review and iterate by opening the file, not in the PR diff.

**Authoring a new single-file concept:**

1. Copy `docs/concepts/_assets/concept-template.html` to `docs/concepts/<status>/<name>.html`;
   fill in the sections, Mermaid diagrams, and at least one mockup using the real class names +
   lucide icons (rule 2 above).
2. **Screenshot-verify fidelity**: render with `scripts/internal/screenshot-mockup.sh <file>` (or
   `--all`) and confirm it actually looks like termiHub and that Mermaid renders before using it
   for discussion.
3. Regenerate the gallery: `scripts/internal/build-mockups-index.sh` (or `.cmd`) →
   `docs/concepts/mockups-index.html`.
4. Discuss/iterate on the file **before** writing code. Implement only once it stabilizes, using
   the mockups as the layout target and the diagrams as the behavior spec.
5. After implementing (and after any later change to the feature), run `/sync-concept <name>` to
   refresh the sync ledger and reconcile.

The standard Concept-issue rules (sections, Mermaid, issue header, commit message) still apply —
they just all live in the one HTML file. The worked example is
[`implemented/x-server-provisioning.html`](../docs/concepts/implemented/x-server-provisioning.html).
Older concepts may still use the retired **folder form** (`concept.md` + `behavior.md` +
`mockups/*.html` + `sync.md`); migrate them to the single-file form on next substantial edit.

---

## Project Structure

```
src/                          # React frontend
  components/                 # ActivityBar/, Sidebar/, Terminal/, SplitView/, Settings/,
                              # ConnectionEditor/, StatusBar/, TunnelEditor/, TunnelSidebar/,
                              # CredentialStoreIndicator/, LogViewer/, FileEditor/,
                              # DynamicForm/ (schema-driven connection forms),
                              # NetworkTools/ (ping, traceroute, port scanner, DNS, WoL, HTTP monitor),
                              # WorkspaceSidebar/, EmbeddedServerSidebar/, etc.
  data/                       # Application data/fixtures
  hooks/                      # useTerminal, useConnections, useKeyboardShortcuts, etc.
  services/                   # api.ts (Tauri commands), events.ts (Tauri events)
  store/                      # appStore.ts (Zustand)
  styles/                     # CSS styling
  test/                       # Test utilities
  themes/                     # Theme definitions
  types/                      # terminal.ts, connection.ts, events.ts
  utils/                      # formatters, shell detection, panelTree
src-tauri/src/                # Rust backend (desktop)
  terminal/                   # backend.rs (trait), agent_manager.rs, agent_setup.rs, agent_deploy.rs
  connection/                 # config.rs, manager.rs, storage.rs
  credential/                 # Credential store (encryption, master password, storage)
  files/                      # sftp.rs, local.rs, browser.rs, utils.rs
  system_monitor_projection/  # System monitoring state projection (CPU, memory, disk, etc.)
  session/                    # manager.rs, registry.rs, remote_proxy.rs
  tunnel/                     # SSH tunnel functionality
  embedded_servers/           # Embedded HTTP/FTP/TFTP server management
  network/                    # Network tools backend (WoL storage, HTTP monitor)
  workspace/                  # Workspace save/restore (config.rs, manager.rs, storage.rs)
  commands/                   # Tauri IPC command handlers
  utils/                      # shell_detect.rs, expand.rs, errors.rs, portable.rs
core/src/                     # Shared Rust core library (termihub-core)
  backends/                   # Backend implementations: local_shell.rs, serial.rs, telnet.rs,
                              # ssh/ (directory), docker/ (directory), wsl.rs
  buffer/                     # RingBuffer (1 MiB circular byte buffer)
  config/                     # ShellConfig, SshConfig, DockerConfig, SerialConfig, PtySize
  connection/                 # Connection types and traits
  errors.rs                   # CoreError, SessionError, FileError
  files/                      # FileBrowser trait, LocalFileBrowser, FileEntry, utilities
  monitoring/                 # SystemStats, CpuCounters, StatsCollector trait, parsers
  output/                     # OutputCoalescer, screen-clear detection
  protocol/                   # JSON-RPC message types and error codes
  session/                    # Transport traits (OutputSink, ProcessSpawner, ProcessHandle),
                              # shell/SSH/Docker/serial command builders and validators
agent/                        # Remote agent (JSON-RPC over SSH)
  src/
    session/                  # SessionManager, SessionBackend enum, connection definitions, agent forwarding
    daemon/                   # Session daemon client, process spawning, and binary frame protocol
    registry_daemon/          # Host-wide registry daemon role — cross-worker "who's attached" visibility (ADR-11)
    tunnel/                   # Agent-hosted SSH tunnel forwarding (local/remote/dynamic)
    service/                  # Agent-hosted embedded HTTP/FTP/TFTP servers
    monitoring/               # System monitoring (self + remote SSH, delegates to core parsers)
    network/                  # Network diagnostic handlers (thin wrappers over core::network)
    files/                    # Connection-scoped file browsing (core FileBrowser)
    update/                   # Optional agent-side GitHub self-update (off by default)
    handler/                  # JSON-RPC method dispatcher
    protocol/                 # Protocol types, methods, error codes
    state/                    # Session state persistence (state.json)
    io/                       # Transport layer (stdio, TCP)
    client_registry.rs        # Per-process registry of connected desktop clients
    registry.rs               # Agent-side ConnectionTypeRegistry setup
    transport.rs              # Core trait adapters (OutputSink, ProcessSpawner, etc.)
    fs.rs                     # Small shared filesystem helpers
    main.rs                   # Entry point (--stdio, --listen, --daemon)
scripts/                      # Dev helper scripts (.sh + .cmd variants)
  internal/                   # Non-user-facing helpers (autoformat hook, kill-port utility)
docs/                         # All documentation
  concepts/                   # Concept documents for "Concept" labeled issues
tests/system/                 # Python bridge system/E2E harness (WebSocket-driven; supersedes the retired wdio suite)
tests/docker/                 # Comprehensive Docker test containers (SSH variants, telnet, serial, SFTP, fault injection)
tests/fixtures/               # Test fixtures (SSH keys, config samples)
tests/manual/                 # Manual test definitions
examples/                     # Quick-start dev environment (SSH, Telnet, virtual serial)
```

---

## Coding Standards

### Dependencies — Prefer Libraries Over Custom Code

**Default to existing libraries.** Before writing custom code for any non-trivial concern (parsers, protocol clients, layout systems, form state, networking primitives, file format handlers, encryption envelopes, etc.), search crates.io and npm for a mature option and propose it. When extending or reviewing existing code, actively flag opportunities to replace custom implementations with well-maintained libraries — even if the current code works.

- **A maintained, widely-used library beats in-house code**, even when the library is larger or pulls in more dependencies. Bundle size, dep-tree depth, and migration effort are **secondary**. Maintenance ownership, edge-case correctness, and platform coverage are **primary**.
- "I could write this in 50 lines" is **not** a reason to skip a library.
- When proposing a new feature or refactor, list candidate libraries first and only justify a custom implementation if no library fits.

Acceptable reasons to keep custom code:

1. **No actively-maintained library exists** — last release >2 years ago, abandoned, or fundamentally broken
2. **The library's design fundamentally conflicts** with surrounding code (e.g., async-only when the call site cannot become async) and the surrounding code cannot reasonably change
3. **Genuinely domain-specific glue** with no library analog (e.g., termiHub's panel-tree layout, daemon binary frame protocol, embedded-server lifecycle plumbing)

Bundle/dep-size concerns belong in the "secondary" bucket — raise them in PR discussion if relevant, but never use them to block a sensible adoption.

### TypeScript / React

- No `any` types
- One component per file with named exports
- Props interface always defined
- Hooks first, then event handlers, then render
- JSDoc for public functions
- Naming: `PascalCase` components, `camelCase` functions/hooks, `UPPER_SNAKE_CASE` constants

### UI / Design System

termiHub has a shared design system (concept — the source of truth: [`docs/concepts/implemented/ui-modernization.html`](../docs/concepts/implemented/ui-modernization.html)). **For any non-trivial UI work — building or restyling components/dialogs/forms, adding user-facing feedback, reviewing a UI diff, or making a visual/interaction decision — delegate to the `ui-design` subagent** (`.claude/agents/ui-design.md`), which owns the full system. The concept is authoritative: when it and the code disagree, fix the code by default.

These rules hold in every session (the `ui-design` agent enforces them in depth):

1. **Compose from primitives.** Build UI from the shared primitives in `src/components/ui/` (Button, Input, Field, Select, Modal, Toggle, Toast) — never a new `__btn`, bespoke input, or one-off dialog shell. If a primitive is missing or doesn't exist yet, create/extend it there rather than adding another one-off.
2. **Build on installed libraries.** Primitives are thin token'd skins over deps already in `package.json` — Modal/Select/Tabs → Radix, Field → `react-hook-form` + `zod`, toasts → `sonner`. Propose a dependency before a custom implementation (see [Prefer Libraries Over Custom Code](#dependencies--prefer-libraries-over-custom-code)).
3. **Tokens only — no magic values.** Every color/spacing/radius/shadow/font-size/z-index/transition references a token from `src/styles/variables.css`. No raw hex, no `rgba(0,0,0,…)` overlays, no pixel radii. Add a token (with per-theme values) if one is missing; primary-button text uses `--text-on-accent`, never `#fff`.
4. **Every action gives feedback.** No mutating/async action resolves silently — show a pending state, then success (`toast.success()`) or a recoverable error. Button actions use the async Button state; long-running work uses `toast.loading()`; field errors are inline; blocking connects use the connection-overlay pattern.
5. **One scrollbar, one motion language.** Scrollbars are styled globally (`global.css`) — never re-style per component. Use `--transition-*` tokens and wrap motion in `@media (prefers-reduced-motion: reduce)`.

### Rust

- No `.unwrap()` in production code — use `?` with `anyhow::Result`
- Add context to errors: `.context("description")`
- Doc comments (`///`) for public APIs
- `tokio` for async, channels for communication
- Naming: `PascalCase` types/traits, `snake_case` functions/modules, `UPPER_SNAKE_CASE` constants
- **Cross-platform awareness**: termiHub builds on Windows, macOS, and Linux. Gate platform-specific code with `#[cfg(windows)]`, `#[cfg(unix)]`, etc. — on functions, imports, and tests. CI runs on all platforms, so ungated platform-specific code will fail the build.

### Testing

#### Preferred Workflow: Test-Driven Development (TDD)

The preferred approach for all bug fixes and feature work is **test-driven development**:

1. **Write the test first** — design and implement a test that checks the correct behavior before touching production code.
2. **Verify the test fails** — confirm the test fails without the fix or feature in place (red phase).
3. **Implement the fix or feature** — make the test pass (green phase).
4. **Commit in order** — the test commit must come **before** the implementation commit so reviewers can see the intended behavior independently of the solution.

Expected commit sequence for a bug fix:

```
test(scope): add regression test for <bug description>
fix(scope): fix <bug description> (Closes #N)
```

Expected commit sequence for a new feature:

```
test(scope): add tests for <feature name>
feat(scope): implement <feature name> (Closes #N)
```

#### General Rules

- **Automatically add tests** after every bug fix or feature implementation — do not wait for the user to ask. Tests are a mandatory part of completing any task, not an optional follow-up.
- Test type priority (use the highest feasible option):
  1. **Unit tests** (preferred) — fast, isolated, verify specific behavior
  2. **System/integration tests** — when unit tests aren't feasible (e.g., hardware, full app lifecycle)
  3. **Documented manual test steps** — last resort for things that can't be automated (e.g., visual rendering, platform-specific hardware)
- No change should ship without at least one of the above
- For bug fixes, **always** add a regression test that would fail without the fix
- For new features, add tests covering the core functionality and key edge cases
- Run `./scripts/test.sh` after adding tests to verify they pass before committing
- **Manual test tracking**: When a PR includes manual test steps (in the PR description's "Test plan" section), also add those steps to the Manual Testing section in `docs/testing.md` under the appropriate feature area heading, referencing the PR number. This keeps manual tests discoverable and prevents them from being forgotten after merge.
- **System/E2E tests**: run through the **Python bridge harness** (`tests/system/`, via `./scripts/test-system-py.sh`), which drives the app over a WebSocket bridge and works on macOS, Linux, and Windows. The WebdriverIO/`tauri-driver` scaffold was fully retired (#1027). The only remaining `tauri-driver` consumer is the smoke test (`scripts/smoke-test.sh`); `tauri-driver` still has no macOS WKWebView driver, so its UI checks are Linux/Windows-only (see ADR-5 in [architecture.md](../docs/architecture.md)). macOS-specific rendering must be verified via manual tests.

### Debugging / Logging

- **Always use the internal LogViewer** for frontend debug logging — never use `console.log`/`console.warn`/`console.error` for debug output. The LogViewer is accessible to the user; the browser DevTools console is not.
- Use `frontendLog` from `src/utils/frontendLog.ts` to emit debug messages into the LogViewer:

  ```typescript
  import { frontendLog } from "@/utils/frontendLog";
  frontendLog("your_module", "your debug message");
  ```

  Messages appear with target `frontend::your_module` at DEBUG level.

- **Proactively add debug logging** when implementing new features or investigating issues — don't wait for the user to ask. Remove debug logging before the final PR.

### General

- Max ~500 lines per file, ~50 lines per function
- Single Responsibility Principle
- Clear, descriptive naming
- **Prefer Mermaid.js diagrams** in documentation wherever they aid understanding (flowcharts, sequence diagrams, state diagrams, etc.)
- **Schema-driven connection forms**: connection types declare config as JSON schemas; `DynamicForm` renders them automatically — never hardcode connection UI fields
- **Portable mode**: when `termiHub.exe` runs from a directory containing a `data/` folder, all config/data is stored there instead of the system profile path; controlled via `src-tauri/src/utils/portable.rs`

---

## Claude Code Skills

Use these skills with `/skill-name` during development:

- `/frontend-design:frontend-design` — UI components and new screens (VS Code-inspired aesthetic)
- `/sync-concept <name>` — reconcile a single-file HTML concept with the code (concept is source of truth)
- `/simplify` — post-implementation code quality review (run before PRs)
- `/claude-md-management:revise-claude-md` — update CLAUDE.md with session learnings (run at session end)
- `/claude-md-management:claude-md-improver` — full CLAUDE.md audit and improvement pass

---

## Git Workflow

- **`develop` is the default base branch**: all feature and bugfix branches must be created from `origin/develop`. Only branch from `origin/main` when the user explicitly requests it.
- **Always pull `origin/develop` before starting new work**: run `git fetch origin && git checkout -b <branch> origin/develop` to start from a fresh copy of develop — never branch from a stale local copy.
- **Always create a new branch before any work**: never commit to `main` or `develop` — every fix, feature, or doc change must start on a dedicated `feature/<description>` or `bugfix/<description>` branch. If you are already on `main` or `develop` when you begin, create and switch to a new branch first.
- **Prefix branches with the checkout's `dev_name`**: when the repo-root `dev.local.json` defines a `dev_name`, put it as the **leading segment** of every branch name — `<dev_name>/feature/<description>` or `<dev_name>/bugfix/<description>` (e.g. `dev0/feature/1234-new-thing`). This groups all of one checkout's branches together in `git branch` / PR lists, so a person overseeing several parallel checkouts can see at a glance which instance owns which branch. Read the value with `jq -r '.dev_name // empty' dev.local.json` (empty/missing file → no prefix, use the plain `feature/<description>` form). The per-branch change fragment path follows the branch name as usual (`docs/changes/<dev_name>/feature/<description>.md`).
- **Never commit directly to `main` or `develop`**
- **Never push directly to `main` or `develop`**: all changes must be submitted via pull request — no exceptions, even for documentation-only changes
- **Every change requires a PR targeting `develop`**: create a feature or bugfix branch, push it to `origin`, and open a pull request against `develop`. Only target `main` when the user explicitly requests it.
- **Conventional Commits**: `type(scope): subject` — types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `chore`, `ci`, `revert` (enforced by `commitlint.config.js`). The subject must be **lowercase**: `subject-case` (from `@commitlint/config-conventional`) rejects sentence-case/start-case/PascalCase/UPPER-CASE, so start it with a lowercase word — `fix(config): resolve …`, not `fix(config): Resolve …`.
- **Scopes**: `terminal`, `ssh`, `serial`, `ui`, `backend`, `sftp`, `config`, `agent`, `credential`, `tunnel`, `workspace`, `network`, `embedded-servers`
- **Always merge with a merge commit** (`gh pr merge --merge`) — never squash or rebase, never rebase branches
- **Commit early and often** — commit as soon as a single logical topic is complete (a single topic = a single commit). Do not batch multiple topics into one commit. Each logical step gets its own commit:
  - Refactors separate from new features
  - Config changes separate from source changes
  - Formatting/lint fixes separate from functional changes
- **Never pull or fetch before committing**: always commit local changes first before any git operations that touch the remote (fetch, pull, merge). Uncommitted work must never be at risk from remote operations.
- **Record user-facing changes in a per-branch fragment, not `CHANGELOG.md`**: on a `develop`-targeted branch, add your Keep a Changelog notes to `docs/changes/<branch-name>.md` (e.g. `docs/changes/feature/1234-new-thing.md`) — never edit `CHANGELOG.md` directly. Per-branch files avoid the constant `CHANGELOG.md` merge conflicts; the fragments are consolidated into `CHANGELOG.md` at release time (`develop` → `main`). Skip the fragment for non-user-facing work (refactors, CI, internal docs, test-only). Only hotfix branches cut directly from a `main` tag edit `CHANGELOG.md` directly. See [`docs/changes/README.md`](../docs/changes/README.md).
- **Merge `origin/develop` before creating a PR** (never rebase): before pushing the final branch and opening a PR, always `git fetch origin && git merge origin/develop` into the feature branch, resolve any conflicts, and re-run tests/checks to ensure the branch is up to date and clean. Always use merge, never rebase.

---

## Development Scripts

All scripts live in `scripts/` with `.sh` (Unix/macOS) and `.cmd` (Windows) variants. They can be run from anywhere in the repo. See [scripts/README.md](../scripts/README.md) for details.

| Script                             | Purpose                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `./scripts/setup.sh`               | Install all dependencies and do an initial build                                                                                  |
| `./scripts/dev.sh`                 | Start the app in dev mode with hot-reload                                                                                         |
| `./scripts/build.sh`               | Build for production (creates platform installer)                                                                                 |
| `./scripts/test.sh`                | Run all unit tests (frontend + backend + agent)                                                                                   |
| `./scripts/check.sh`               | Read-only quality checks mirroring CI (formatting, linting, clippy)                                                               |
| `./scripts/format.sh`              | Auto-fix all formatting issues (Prettier + cargo fmt)                                                                             |
| `./scripts/clean.sh`               | Remove all build artifacts for a fresh start                                                                                      |
| `./scripts/build-agents.sh`        | Build remote agent binaries (cross-compilation targets)                                                                           |
| `./scripts/setup-agent-cross.sh`   | Set up cross-compilation toolchain for agent builds                                                                               |
| `./scripts/test-system-py.sh`      | Run the Python bridge system-test harness (`tests/system/`) — builds the app if stale, brings up `--fixtures`, forwards to pytest |
| `./scripts/test-system-linux.sh`   | Linux per-machine orchestration: Docker infra + virtual serial ports + unit & Rust integration tests                              |
| `./scripts/test-system-windows.sh` | Windows (WSL/Git Bash) per-machine orchestration: Docker/Podman infra + unit & Rust integration tests                             |
| `./scripts/release-check.sh`       | Validate release readiness (version consistency, changelog, tests, quality, git state, branch, code markers)                      |
| `./scripts/smoke-test.sh`          | Post-install smoke test (launch app, verify UI, confirm clean shutdown)                                                           |

### Auto-Formatting Hook

A PostToolUse hook in `.claude/settings.json` runs `scripts/internal/autoformat.sh` after every Edit/Write, automatically applying Prettier (TS/JS/CSS) and rustfmt (Rust). No manual formatting step is needed during development.

### Pre-Push Checklist (Internal Tasks)

**Before pushing or creating a PR**, complete all outstanding internal tasks first. Do not defer these to after pushing. When the user asks to push, **stop and report** which of the following items are still pending, then ask for permission before proceeding:

1. **Change fragment** — for every user-facing change, `docs/changes/<branch-name>.md` exists with the Keep a Changelog notes (not `CHANGELOG.md`; see [Git Workflow](#git-workflow))
2. **docs/testing.md (Manual Testing section)** — updated if the PR includes manual test steps
3. **Concept documents** — if working on a `Concept` issue, ensure `docs/concepts/<name>.md` is written and committed
4. **Other documentation** — any doc updates implied by the changes (architecture.md, README references, JSDoc, doc comments, etc.)
5. **Code quality** — run `/simplify` on changed code to review for reuse, quality, and efficiency; commit any improvements as a separate commit
6. **Formatting** — run `./scripts/format.sh` and commit any formatting fixes as a separate commit
7. **Quality checks** — run `./scripts/check.sh` to verify linting, formatting, and clippy pass

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

Also run `/simplify` on changed code before pushing.

### Individual Commands (when you need just one tool)

```bash
# Frontend
pnpm run lint            # ESLint
pnpm run lint:fix        # ESLint with --fix
pnpm run format:check    # Prettier check (format to auto-fix)
pnpm run markdownlint    # Markdown linting
pnpm run markdownlint:fix # Markdown linting with fixes
pnpm test                # Vitest single run
pnpm test:watch          # Vitest watch mode
pnpm test:coverage       # Vitest with coverage
pnpm build               # TypeScript check + Vite build

# System / E2E tests (Python bridge harness — not a pnpm script)
./scripts/test-system-py.sh -m integration   # build if needed + fixtures + pytest

# Rust workspace (all crates)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features

# Dev server
./scripts/dev.sh         # preferred — also starts this checkout's dev agent
pnpm tauri dev           # app only; same dev port, no dev agent
```

Both honour this checkout's `dev_port` from `dev.local.json`, so neither collides
with another parallel checkout. Only `./scripts/dev.sh` starts the `dev_agent_port`
`sshd` and registers the dev-agent connection — see
[docs/testing.md](../docs/testing.md) → "Parallel test isolation".

---

## Adding a New Terminal Backend

1. Implement the backend in `core/src/backends/` (follow existing patterns like `local_shell.rs`, `telnet.rs`)
2. Add config types in `core/src/config/` (Rust) and `src/types/terminal.ts` (TypeScript)
3. Wire up in `src-tauri/src/terminal/` and add Tauri commands in `src-tauri/src/commands/` if needed
4. Create settings UI in `src/components/Settings/` — compose from the shared `src/components/ui/` primitives (Button, Input, Field, Select, Modal, Toggle); never hand-roll button/input/dialog CSS
5. Add to connection type selector in `src/components/ConnectionEditor/ConnectionEditor.tsx`
6. Test on target platform, run `./scripts/check.sh`

---

## Key References

- [Architecture](../docs/architecture.md) — Full arc42 architecture documentation
- [Contributing](../docs/contributing.md) — Development setup, building, workflow, releasing, and performance profiling
- [Testing](../docs/testing.md) — Automated and manual testing approach
- [Remote Protocol](../docs/remote-protocol.md) — Desktop-to-agent JSON-RPC specification
- [Concepts](../docs/concepts/) — Design concept documents for `Concept` labeled issues
- [Scripts](../scripts/README.md) — Development helper scripts
