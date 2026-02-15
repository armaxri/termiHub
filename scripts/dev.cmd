@echo off
REM Start the app in development mode with hot-reload.
REM Run from the repo root: scripts\dev.cmd

cd /d "%~dp0\.."

echo Starting TermiHub in dev mode...
call pnpm tauri dev
