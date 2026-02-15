# Scripts

Helper scripts for common development tasks. Each script has a `.sh` (Unix/macOS) and `.cmd` (Windows) variant. All scripts can be run from anywhere in the repo.

| Script | What it does |
|--------|-------------|
| `setup` | Install all dependencies and do an initial build |
| `dev` | Start the app in development mode with hot-reload |
| `build` | Build the app for production (creates platform installer) |
| `test` | Run all unit tests (frontend + backend + agent) |
| `check` | Read-only quality checks mirroring CI (formatting, linting, clippy) |
| `format` | Auto-fix all formatting issues (Prettier + cargo fmt) |
| `clean` | Remove all build artifacts for a fresh start |

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
```
