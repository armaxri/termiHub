@echo off
REM Quick pre-push quality check script.
REM Run from the repo root: scripts\check.cmd
REM Mirrors the CI Code Quality checks locally without modifying files.

cd /d "%~dp0\.."

if not exist node_modules (
    echo node_modules missing, running pnpm install...
    call pnpm install
    if errorlevel 1 exit /b 1
    echo.
)

set FAILED=0

echo === Frontend: Prettier ===
call pnpm run format:check
if errorlevel 1 set FAILED=1

echo.
echo === Frontend: ESLint ===
call pnpm run lint
if errorlevel 1 set FAILED=1

echo.
echo === Rust workspace: cargo fmt ===
cargo fmt --all -- --check
if errorlevel 1 set FAILED=1

echo.
echo === Rust workspace: clippy ===
cargo clippy --workspace --all-targets --all-features -- -D warnings
if errorlevel 1 set FAILED=1

echo.
if %FAILED%==1 (
    echo SOME CHECKS FAILED. Run scripts\format.cmd to auto-fix formatting.
    exit /b 1
) else (
    echo ALL CHECKS PASSED.
)
