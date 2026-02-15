@echo off
REM Quick pre-push formatting script.
REM Run from the repo root: scripts\format.cmd
REM Fixes all auto-fixable formatting issues across the entire codebase.

cd /d "%~dp0\.."

echo === Frontend: Prettier ===
call pnpm exec prettier --write "src/**/*.{ts,tsx,css}"
if errorlevel 1 exit /b 1

echo.
echo === Backend: cargo fmt ===
pushd src-tauri
cargo fmt
if errorlevel 1 (popd & exit /b 1)
popd

echo.
echo === Agent: cargo fmt ===
pushd agent
cargo fmt
if errorlevel 1 (popd & exit /b 1)
popd

echo.
echo All formatting applied.
