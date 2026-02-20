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
set DEV_PORT=1420
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%DEV_PORT% " ^| findstr "LISTENING"') do (
    echo Port %DEV_PORT% in use ^(PID %%a^), killing...
    taskkill /PID %%a /F >nul 2>&1
)

echo Starting TermiHub in dev mode...
call pnpm tauri dev
