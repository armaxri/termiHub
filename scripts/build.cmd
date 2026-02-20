@echo off
REM Build the app for production (creates platform installer).
REM Run from the repo root: scripts\build.cmd

cd /d "%~dp0\.."

if not exist node_modules (
    echo node_modules missing, running pnpm install...
    call pnpm install
    if errorlevel 1 exit /b 1
    echo.
)

echo Building termiHub for production...
call pnpm tauri build
