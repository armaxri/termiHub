@echo off
REM First-time project setup — installs all dependencies.
REM Run from the repo root: scripts\setup.cmd

cd /d "%~dp0\.."

echo === Installing frontend dependencies ===
call pnpm install
if errorlevel 1 exit /b 1

echo.
echo === Building Rust backend (first compile takes a while) ===
pushd src-tauri
cargo build
if errorlevel 1 (popd & exit /b 1)
popd

echo.
echo === Building Agent ===
pushd agent
cargo build
if errorlevel 1 (popd & exit /b 1)
popd

echo.
echo Setup complete. Run scripts\dev.cmd to start the app.
