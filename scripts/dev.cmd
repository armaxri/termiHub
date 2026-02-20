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

REM Kill any process occupying the Vite dev server port (leftover from a previous run).
REM Avoids matching the state name because netstat localizes it (e.g. ABHÖREN on German Windows).
REM Uses /T to kill child processes that may also hold the port.
set DEV_PORT=1420
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%DEV_PORT% "') do (
    echo Port %DEV_PORT% in use ^(PID %%a^), killing...
    taskkill /PID %%a /T /F >nul 2>&1
)
REM If port is still occupied after killing, wait for the OS to release it
netstat -ano 2>nul | findstr ":%DEV_PORT% " >nul 2>&1
if not errorlevel 1 (
    echo Waiting for port %DEV_PORT% to be released...
    timeout /t 3 /nobreak >nul 2>&1
)

echo Starting TermiHub in dev mode...
call pnpm tauri dev
