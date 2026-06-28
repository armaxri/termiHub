@echo off
REM One-command runner for the Python bridge system-test harness (tests\system\).
REM Delegates to scripts\test-system-py.sh via Git Bash or WSL, so the build /
REM fixtures / pytest-forwarding logic lives in a single place.
REM
REM Usage: scripts\test-system-py.cmd [OPTIONS] [PYTEST ARGS]
REM
REM Options:
REM   --debug              Build/use the debug profile (faster build)
REM   --release            Build/use the release profile (default)
REM   --skip-build         Never build; use the existing binary
REM   --rebuild            Force a rebuild even if the binary looks up to date
REM   --fixtures "<svc>"   Docker compose services to bring up (repeatable)
REM   --dry-run            Print the resolved plan and exit (no build/fixtures/run)
REM   --help, -h           Show this help message
REM   --                   Pass every following argument straight to pytest
REM
REM Everything not recognized above is forwarded verbatim to pytest, e.g.:
REM   scripts\test-system-py.cmd --debug -k sftp_infra -x -s
REM
REM Prerequisites:
REM   - Git for Windows (Git Bash) or WSL to provide bash
REM   - Docker Desktop or Podman Desktop (only when using --fixtures)
REM   - pnpm + Rust toolchain (for builds)

cd /d "%~dp0\.."

REM Detect bash (Git Bash, WSL, or MSYS2)
where bash >nul 2>&1
if errorlevel 1 (
    echo ERROR: bash not found.
    echo.
    echo Install one of the following to provide bash on Windows:
    echo   - Git for Windows ^(includes Git Bash^): https://git-scm.com/download/win
    echo   - WSL: https://learn.microsoft.com/en-us/windows/wsl/install
    echo   - MSYS2: https://www.msys2.org/
    exit /b 1
)

bash scripts/test-system-py.sh %*
exit /b %errorlevel%
