@echo off
REM Windows system test orchestration — delegates to test-system-windows.sh via WSL or Git Bash.
REM Run from the repo root: scripts\test-system-windows.cmd [options]
REM
REM Options are passed through to test-system-windows.sh (e.g., --skip-unit, --keep-infra).

cd /d "%~dp0\.."

REM Prefer WSL, fall back to Git Bash
wsl --status >nul 2>&1
if %errorlevel%==0 (
    echo Running test-system-windows.sh via WSL...
    wsl bash scripts/test-system-windows.sh %*
    exit /b %errorlevel%
)

where bash >nul 2>&1
if %errorlevel%==0 (
    echo Running test-system-windows.sh via Git Bash...
    bash scripts/test-system-windows.sh %*
    exit /b %errorlevel%
)

echo Error: Neither WSL nor Git Bash found.
echo Install WSL (wsl --install) or Git for Windows (https://git-scm.com).
exit /b 1
