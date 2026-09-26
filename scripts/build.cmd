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

REM Third-party license notices (PKG-009): bundled via tauri.notices.conf.json
REM when the pinned cargo-about is installed (release.yml always generates them).
set "NOTICES_CONFIG="
where cargo-about >nul 2>nul
if errorlevel 1 (
    echo cargo-about not found: skipping bundled third-party notices
    echo   ^(install: cargo install cargo-about --locked --version 0.9.2^)
) else (
    echo === Generating third-party notices ===
    call pnpm notices:generate
    if errorlevel 1 exit /b 1
    set "NOTICES_CONFIG=--config src-tauri/tauri.notices.conf.json"
)

echo Building termiHub for production...
call pnpm tauri build %NOTICES_CONFIG%
