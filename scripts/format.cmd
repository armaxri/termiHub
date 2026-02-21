@echo off
REM Quick pre-push formatting script.
REM Run from the repo root: scripts\format.cmd
REM Fixes all auto-fixable formatting issues across the entire codebase.

cd /d "%~dp0\.."

if not exist node_modules (
    echo node_modules missing, running pnpm install...
    call pnpm install
    if errorlevel 1 exit /b 1
    echo.
)

echo === Frontend: Prettier ===
call pnpm exec prettier --write "src/**/*.{ts,tsx,css}"
if errorlevel 1 exit /b 1

echo.
echo === Rust workspace: cargo fmt ===
cargo fmt --all
if errorlevel 1 exit /b 1

echo.
echo All formatting applied.
