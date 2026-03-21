# Scripts

Helper scripts for common development tasks. Each script has a `.sh` (Unix/macOS) and `.cmd` (Windows) variant. All scripts can be run from anywhere in the repo.

| Script                | What it does                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `setup`               | Install all dependencies and do an initial build                                                                           |
| `dev`                 | Start the app in dev mode with hot-reload; accepts an optional port argument (default 1420)                                |
| `build`               | Build the app for production (creates platform installer); on macOS also cross-compiles agent for Linux x86_64 + aarch64   |
| `test`                | Run all unit tests (frontend + backend + agent)                                                                            |
| `check`               | Read-only quality checks mirroring CI (formatting, linting, clippy)                                                        |
| `format`              | Auto-fix all formatting issues (Prettier + cargo fmt)                                                                      |
| `clean`               | Remove all build artifacts for a fresh start                                                                               |
| `test-system`         | Start Docker infra + virtual serial ports and run system-level E2E tests                                                   |
| `test-system-mac`     | macOS system test orchestration: Docker containers, unit tests, Rust integration tests (no E2E)                            |
| `test-system-linux`   | Linux system test orchestration: Docker containers, unit tests, integration tests, E2E tests                               |
| `test-system-windows` | Windows system test orchestration via WSL/Git Bash: Docker or Podman, unit tests, integration tests, E2E                  |
| `setup-agent-cross`   | Install cross-compilation toolchains for building the agent for 2 Linux targets (musl)                                     |
| `build-agents`        | Cross-compile the remote agent for Linux targets (x64/ARM64, static musl binaries)                                         |
| `release-check`       | Validate release readiness — version consistency, changelog, tests, quality checks, git state, branch, and code markers    |
| `smoke-test`          | Post-install smoke test — launches the built app, verifies basic UI functionality, and confirms clean shutdown             |
| `test-manual.py`      | Guided manual test runner — walks through manual tests from `tests/manual/*.yaml` with platform filtering and JSON reports |

## Typical workflow

```bash
# First time
./scripts/setup.sh

# Daily development
./scripts/dev.sh

# Run a second instance in parallel (e.g. two checkouts side-by-side)
./scripts/dev.sh 1422            # explicit port argument
echo 1422 > dev.local            # or set a per-checkout default (gitignored)

# Before pushing
./scripts/format.sh
./scripts/test.sh
./scripts/check.sh

# System tests (Docker + virtual serial)
./scripts/test-system.sh              # Full run (build + Docker + serial + tests)
./scripts/test-system.sh --skip-build # Reuse existing binary
./scripts/test-system.sh --skip-serial # SSH/Telnet only, no serial port setup
./scripts/test-system.sh --keep-infra  # Keep Docker containers after tests

# Per-machine comprehensive system tests (macOS / Linux)
./scripts/test-system-mac.sh                    # macOS (unit + integration, no E2E)
./scripts/test-system-mac.sh --with-all         # Include fault + stress profiles
./scripts/test-system-linux.sh                  # Linux (unit + integration + E2E)
./scripts/test-system-linux.sh --with-fault     # Include network fault tests
./scripts/test-system-windows.sh                # Windows via WSL/Git Bash
```

```cmd
REM Per-machine comprehensive system tests (Windows — cmd.exe)
scripts\test-system-windows.cmd                                          REM Full run
scripts\test-system-windows.cmd --skip-unit                              REM Integration tests only
scripts\test-system-windows.cmd --skip-integration                       REM Unit tests only (Podman — no docker buildx)
scripts\test-system-windows.cmd --skip-e2e                               REM Unit + integration, no E2E

REM Simple general dispatcher (also callable from cmd.exe)
scripts\test-system.cmd                                                  REM Delegates to test-system-windows.sh
```

```bash
# Agent cross-compilation (one-time setup + build)
./scripts/setup-agent-cross.sh        # Install cross-compilation toolchains
./scripts/build-agents.sh             # Build agent for all Linux targets
./scripts/build-agents.sh --targets aarch64-unknown-linux-musl  # Build specific target

# Guided manual tests
python scripts/test-manual.py                     # Run all manual tests for current platform
python scripts/test-manual.py --list              # List applicable tests (no run)
python scripts/test-manual.py --category ssh      # Run SSH tests only
python scripts/test-manual.py --test MT-LOCAL-03  # Run a single test
python scripts/test-manual.py --keep-infra        # Keep Docker containers after session
python scripts/test-manual.py --resume tests/reports/manual-*.json  # Resume previous session

# Post-install smoke test
./scripts/smoke-test.sh ./src-tauri/target/release/termihub       # Linux
./scripts/smoke-test.sh /Applications/termiHub.app                 # macOS
```

## Internal helpers

The `internal/` subdirectory contains scripts that are **not** intended for direct use. They are invoked by other scripts or by tooling. See [`internal/README.md`](internal/README.md) for details.

| File                     | Used by                                  | Purpose                                             |
| ------------------------ | ---------------------------------------- | --------------------------------------------------- |
| `internal/autoformat.sh` | `.claude/settings.json` PostToolUse hook | Auto-format a single file (Prettier / rustfmt)      |
| `internal/kill-port.cjs` | `dev.sh` / `dev.cmd`                     | Kill any process occupying the Vite dev server port |
