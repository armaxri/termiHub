@echo off
REM Quick pre-push quality check script.
REM Run from the repo root: scripts\check.cmd
REM Mirrors the CI Code Quality checks locally without modifying files.

cd /d "%~dp0\.."

set FAILED=0

echo === Frontend: Prettier ===
call pnpm run format:check
if errorlevel 1 set FAILED=1

echo.
echo === Frontend: ESLint ===
call pnpm run lint
if errorlevel 1 set FAILED=1

echo.
echo === Backend: cargo fmt ===
pushd src-tauri
cargo fmt --check
if errorlevel 1 set FAILED=1
popd

echo.
echo === Backend: clippy ===
pushd src-tauri
cargo clippy --all-targets --all-features -- -D warnings
if errorlevel 1 set FAILED=1
popd

echo.
echo === Agent: cargo fmt ===
pushd agent
cargo fmt --check
if errorlevel 1 set FAILED=1
popd

echo.
echo === Agent: clippy ===
pushd agent
cargo clippy --all-targets --all-features -- -D warnings
if errorlevel 1 set FAILED=1
popd

echo.
if %FAILED%==1 (
    echo SOME CHECKS FAILED. Run scripts\format.cmd to auto-fix formatting.
    exit /b 1
) else (
    echo ALL CHECKS PASSED.
)
