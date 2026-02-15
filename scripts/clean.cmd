@echo off
REM Remove all build artifacts and caches for a fresh start.
REM Run from the repo root: scripts\clean.cmd

cd /d "%~dp0\.."

echo === Cleaning frontend ===
if exist node_modules rmdir /s /q node_modules
if exist dist rmdir /s /q dist

echo === Cleaning backend ===
pushd src-tauri
cargo clean
popd

echo === Cleaning agent ===
pushd agent
cargo clean
popd

echo.
echo All build artifacts removed. Run scripts\setup.cmd to reinstall.
