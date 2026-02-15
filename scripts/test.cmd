@echo off
REM Run all unit tests (frontend + backend + agent).
REM Run from the repo root: scripts\test.cmd

cd /d "%~dp0\.."

if not exist node_modules (
    echo node_modules missing, running pnpm install...
    call pnpm install
    if errorlevel 1 exit /b 1
    echo.
)

set FAILED=0

echo === Frontend: Vitest ===
call pnpm test
if errorlevel 1 set FAILED=1

echo.
echo === Backend: cargo test ===
pushd src-tauri
cargo test --all-features
if errorlevel 1 set FAILED=1
popd

echo.
echo === Agent: cargo test ===
pushd agent
cargo test --all-features
if errorlevel 1 set FAILED=1
popd

echo.
if %FAILED%==1 (
    echo SOME TESTS FAILED.
    exit /b 1
) else (
    echo ALL TESTS PASSED.
)
