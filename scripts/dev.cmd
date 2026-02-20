@echo off
REM Start the app in development mode with hot-reload.
REM Run from the repo root: scripts\dev.cmd

cd /d "%~dp0\.."

if not exist node_modules (
    echo node_modules missing, running pnpm install...
    call pnpm install
    if errorlevel 1 exit /b 1
    echo.
)

REM Kill any process occupying the Vite dev server port (leftover from a previous run)
node scripts\kill-port.cjs 1420

echo Starting termiHub in dev mode...
call pnpm tauri dev
