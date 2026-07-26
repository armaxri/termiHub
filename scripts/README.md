# Scripts

Helper scripts for common development tasks. Each script has a `.sh` (Unix/macOS) and `.cmd` (Windows) variant. All scripts can be run from anywhere in the repo.

| Script                    | What it does                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `setup`                   | Install all dependencies and do an initial build                                                                                                                                                                                                                                                                                     |
| `dev`                     | Start the app in dev mode with hot-reload; accepts an optional port argument (default 1420)                                                                                                                                                                                                                                          |
| `build`                   | Build the app for production (creates platform installer); on macOS also cross-compiles agent for Linux x86_64 + aarch64                                                                                                                                                                                                             |
| `test`                    | Run all unit tests (frontend + backend + agent)                                                                                                                                                                                                                                                                                      |
| `check`                   | Read-only quality checks mirroring CI (formatting, linting, clippy)                                                                                                                                                                                                                                                                  |
| `format`                  | Auto-fix all formatting issues (Prettier + cargo fmt)                                                                                                                                                                                                                                                                                |
| `clean`                   | Remove all build artifacts for a fresh start                                                                                                                                                                                                                                                                                         |
| `test-system-py`          | One-command runner for the Python **bridge** harness — builds the app if missing/stale (`--debug`), brings up `--fixtures`, forwards args to `tests/system/pytest.sh`                                                                                                                                                                |
| `run-guided-manual`       | One-command starter for the **guided-manual** operator suite (`--manual`) — starts Docker if needed, loads the fixture ssh-agent key, builds if stale, runs, and tees the full transcript to a gitignored `tests/reports/manual-run.log` (SSH fixtures + X11 display are handled by the harness). Just run it and answer the prompts |
| `test-system-mac`         | macOS system test orchestration: Docker containers, unit tests, Rust integration tests                                                                                                                                                                                                                                               |
| `test-system-linux`       | Linux system test orchestration: Docker containers, unit tests, Rust integration tests                                                                                                                                                                                                                                               |
| `test-system-windows`     | Windows system test orchestration via WSL/Git Bash: Docker or Podman, unit tests, Rust integration tests                                                                                                                                                                                                                             |
| `setup-agent-cross`       | Install cross-compilation toolchains for building the agent for 2 Linux targets (musl)                                                                                                                                                                                                                                               |
| `build-agents`            | Build the remote agent: Linux targets via cross-rs (musl), or macOS/Windows targets natively (`--native`)                                                                                                                                                                                                                            |
| `release-check`           | Validate release readiness — version consistency, changelog (incl. unconsolidated `docs/changes/` fragments), tests, quality checks, git state, branch, and code markers                                                                                                                                                             |
| `smoke-test`              | Post-install smoke test — launches the built app, verifies basic UI functionality, and confirms clean shutdown                                                                                                                                                                                                                       |
| `package-plugin`          | Package a plugin source directory into a validated `.termihub-plugin` archive — builds the backend `cdylib` (if the source is a Rust crate) and stages it, then validates the manifest and zips the concept §1 layout. See [docs/plugin-authoring.md](../docs/plugin-authoring.md)                                                     |
| `test-manual.py`          | Guided manual test runner — walks through manual tests from `tests/manual/*.yaml` with platform filtering and JSON reports                                                                                                                                                                                                           |
| `build-testid-catalog.py` | Scan `src/**` for every `data-testid` into a local, git-ignored catalog (`tests/system/testid-catalog.md`) so test authors confirm a selector without reading components; not committed — CI regenerates and verifies coverage instead of diffing it (#1528)                                                                      |

## Typical workflow

```bash
# First time
./scripts/setup.sh

# Daily development
./scripts/dev.sh

# Run a second instance in parallel (e.g. two checkouts side-by-side)
./scripts/dev.sh 1422            # explicit port argument
cp default.dev.local.json dev.local.json   # per-checkout config (gitignored)
# Edit dev.local.json: distinct dev_port + compose_project + test_port_offset.
# This also isolates the test environments (Docker, serial, E2E) so several
# checkouts can run all tests at once — see docs/testing.md "Parallel test isolation".

# Before pushing
./scripts/format.sh
./scripts/test.sh
./scripts/check.sh

# Python bridge harness — one command (build if needed + fixtures + pytest)
./scripts/test-system-py.sh --debug -k sftp_infra -x -s            # debug build, one suite
./scripts/test-system-py.sh --fixtures "ssh-password ssh-keys" -m integration -k ssh
./scripts/test-system-py.sh --skip-build -m "not integration"     # fast machinery suite
./scripts/test-system-py.sh --dry-run --debug -k ssh              # preview the plan only

# Per-machine comprehensive system tests (macOS / Linux)
./scripts/test-system-mac.sh                    # macOS (unit + integration, no E2E)
./scripts/test-system-mac.sh --with-all         # Include fault + stress profiles
./scripts/test-system-linux.sh                  # Linux (unit + integration)
./scripts/test-system-linux.sh --with-fault     # Include network fault tests
./scripts/test-system-windows.sh                # Windows via WSL/Git Bash
```

```cmd
REM Per-machine comprehensive system tests (Windows — cmd.exe)
scripts\test-system-windows.cmd                                          REM Full run
scripts\test-system-windows.cmd --skip-unit                              REM Integration tests only
scripts\test-system-windows.cmd --skip-integration                       REM Unit tests only (Podman — no docker buildx)

REM Simple general dispatcher (also callable from cmd.exe)
scripts\test-system.cmd                                                  REM Delegates to test-system-windows.sh
```

```bash
# Agent cross-compilation (one-time setup + build)
./scripts/setup-agent-cross.sh        # Install cross-compilation toolchains
./scripts/build-agents.sh             # Build agent for all Linux targets
./scripts/build-agents.sh --targets aarch64-unknown-linux-musl  # Build specific target
./scripts/build-agents.sh --native --targets x86_64-pc-windows-msvc  # Windows x64 (run on Windows)

# Guided manual tests
python scripts/test-manual.py                     # Run all manual tests for current platform
python scripts/test-manual.py --list              # List applicable tests (no run)
python scripts/test-manual.py --category ssh      # Run SSH tests only
python scripts/test-manual.py --test MT-LOCAL-03  # Run a single test
python scripts/test-manual.py --keep-infra        # Keep Docker containers after session
python scripts/test-manual.py --resume tests/reports/manual-*.json  # Resume previous session

# data-testid catalog (for system-test authors)
# The autoformat PostToolUse hook regenerates this automatically after a source
# .tsx edit (#1084); run it by hand only when editing outside that flow.
python scripts/build-testid-catalog.py            # Regenerate the local (git-ignored) catalog
python scripts/build-testid-catalog.py --stdout   # Print without writing

# Post-install smoke test
./scripts/smoke-test.sh ./src-tauri/target/release/termihub       # Linux
./scripts/smoke-test.sh /Applications/termiHub.app                 # macOS
```

## Internal helpers

The `internal/` subdirectory contains scripts that are **not** intended for direct use. They are invoked by other scripts or by tooling. See [`internal/README.md`](internal/README.md) for details.

| File                                | Used by                                  | Purpose                                                                                        |
| ----------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `internal/autoformat.sh`            | `.claude/settings.json` PostToolUse hook | Auto-format a single edited file (Prettier / rustfmt) and refresh the `data-testid` catalog    |
| `internal/regen-testid-catalog.mjs` | `internal/autoformat.sh`                 | Regenerate the `data-testid` catalog when a source `.tsx` with a `data-testid` changes (#1084) |
| `internal/kill-port.cjs`            | `dev.sh` / `dev.cmd`                     | Kill any process occupying the Vite dev server port                                            |
| `internal/dev-local.mjs`            | `vite.config.ts` / `internal/tauri.mjs`  | Resolve this checkout's `dev_port` from `dev.local.json` (Node half of the resolver) (#1588)   |
| `internal/tauri.mjs`                | `pnpm tauri`                             | Point `tauri dev` at this checkout's `dev_port`; pass every other subcommand through (#1588)   |
