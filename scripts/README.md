# Scripts

Helper scripts for common development tasks. Each script has a `.sh` (Unix/macOS) and `.cmd` (Windows) variant. All scripts can be run from anywhere in the repo.

| Script                | What it does                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `setup`               | Install all dependencies and do an initial build                                                                         |
| `dev`                 | Start the app in development mode with hot-reload                                                                        |
| `build`               | Build the app for production (creates platform installer); on macOS also cross-compiles agent for Linux x86_64 + aarch64 |
| `test`                | Run all unit tests (frontend + backend + agent)                                                                          |
| `check`               | Read-only quality checks mirroring CI (formatting, linting, clippy)                                                      |
| `format`              | Auto-fix all formatting issues (Prettier + cargo fmt)                                                                    |
| `clean`               | Remove all build artifacts for a fresh start                                                                             |
| `test-system`         | Start Docker infra + virtual serial ports and run system-level E2E tests                                                 |
| `test-system-mac`     | macOS system test orchestration: Docker containers, unit tests, Rust integration tests (no E2E)                          |
| `test-system-linux`   | Linux system test orchestration: Docker containers, unit tests, integration tests, E2E tests                             |
| `test-system-windows` | Windows system test orchestration via WSL/Git Bash: Docker, unit tests, integration tests, E2E                           |
| `setup-agent-cross`   | Install cross-compilation toolchains for building the agent for 6 Linux targets                                          |
| `build-agents`        | Cross-compile the remote agent for up to 6 Linux targets (x64/ARM64/ARMv7 × glibc/musl)                                  |
| `test-manual.py`      | Guided manual test runner — walks through manual tests from `tests/manual/*.yaml` with platform filtering and JSON reports |

## Typical workflow

```bash
# First time
./scripts/setup.sh

# Daily development
./scripts/dev.sh

# Before pushing
./scripts/format.sh
./scripts/test.sh
./scripts/check.sh

# System tests (Docker + virtual serial)
./scripts/test-system.sh              # Full run (build + Docker + serial + tests)
./scripts/test-system.sh --skip-build # Reuse existing binary
./scripts/test-system.sh --skip-serial # SSH/Telnet only, no serial port setup
./scripts/test-system.sh --keep-infra  # Keep Docker containers after tests

# Per-machine comprehensive system tests
./scripts/test-system-mac.sh                    # macOS (unit + integration, no E2E)
./scripts/test-system-mac.sh --with-all         # Include fault + stress profiles
./scripts/test-system-linux.sh                  # Linux (unit + integration + E2E)
./scripts/test-system-linux.sh --with-fault     # Include network fault tests
./scripts/test-system-windows.sh                # Windows via WSL/Git Bash
./scripts/test-system-windows.sh --skip-unit    # Integration tests only

# Agent cross-compilation (one-time setup + build)
./scripts/setup-agent-cross.sh        # Install cross-compilation toolchains
./scripts/build-agents.sh             # Build agent for all 6 Linux targets
./scripts/build-agents.sh --targets aarch64-unknown-linux-gnu  # Build specific target

# Guided manual tests
python scripts/test-manual.py                     # Run all manual tests for current platform
python scripts/test-manual.py --list              # List applicable tests (no run)
python scripts/test-manual.py --category ssh      # Run SSH tests only
python scripts/test-manual.py --test MT-LOCAL-03  # Run a single test
python scripts/test-manual.py --keep-infra        # Keep Docker containers after session
python scripts/test-manual.py --resume tests/reports/manual-*.json  # Resume previous session
```
