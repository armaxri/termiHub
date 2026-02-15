@echo off
REM Build the app for production (creates platform installer).
REM Run from the repo root: scripts\build.cmd

cd /d "%~dp0\.."

echo Building TermiHub for production...
call pnpm tauri build
