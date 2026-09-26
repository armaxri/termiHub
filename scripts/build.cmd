@echo off
REM Build the app for production (creates platform installer).
REM Windows twin of scripts/build.sh. Run from anywhere: scripts\build.cmd

cd /d "%~dp0\.."

if not exist node_modules (
    echo node_modules missing, running pnpm install...
    call pnpm install
    if errorlevel 1 exit /b 1
    echo.
)

REM The RDP sidecar (#1747) ships next to the desktop binary via Tauri
REM `externalBin` (#1754). `externalBin` is declared in a bundle-only config
REM fragment (tauri.sidecar.conf.json) rather than the base config, so per-PR
REM compile/test/clippy jobs -- which never bundle -- don't need the helper built.
REM Here we do bundle, so build+stage the host sidecar first (tauri-build rejects
REM a missing externalBin), then merge the fragment via `--config`. Same steps as
REM build.sh, so a local Windows installer bundles termihub-rdp-helper.exe too.
echo === Building RDP sidecar for bundling ===
call "%~dp0build-rdp-sidecar.cmd" --release --tauri-externalbin
if errorlevel 1 (
    echo ERROR: RDP sidecar build failed; not building the installer without it.
    exit /b 1
)

echo Building termiHub for production...
call pnpm tauri build --config src-tauri/tauri.sidecar.conf.json
if errorlevel 1 exit /b 1
exit /b 0
