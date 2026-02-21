@echo off
REM First-time project setup — installs all dependencies.
REM Run from the repo root: scripts\setup.cmd

cd /d "%~dp0\.."

echo === Installing frontend dependencies ===
call pnpm install
if errorlevel 1 exit /b 1

echo.
echo === Building Rust workspace (first compile takes a while) ===
cargo build --workspace
if errorlevel 1 exit /b 1

echo.
echo Setup complete. Run scripts\dev.cmd to start the app.
