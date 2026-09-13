@echo off
REM First-time project setup — installs all dependencies.
REM Run from the repo root: scripts\setup.cmd

cd /d "%~dp0\.."

echo === Installing frontend dependencies ===
call pnpm install
if errorlevel 1 exit /b 1

echo.
echo === Enabling git hooks (pre-commit, commit-msg, pre-push) ===
REM Point git at the committed scripts\hooks directory (git's native mechanism,
REM no extra dependency). Per-clone setting, so hooks stay opt-in. Bypass any hook
REM with --no-verify or by setting TERMIHUB_SKIP_HOOKS=1.
git config core.hooksPath scripts/hooks
echo Git hooks enabled via core.hooksPath=scripts/hooks.

echo.
echo === Building Rust workspace (first compile takes a while) ===
cargo build --workspace
if errorlevel 1 exit /b 1

echo.
echo Setup complete. Run scripts\dev.cmd to start the app.
