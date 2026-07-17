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

REM A runner's own summary is not the verdict. Vitest exits non-zero when the run
REM hit an unhandled error even though every test passed, so its summary can read
REM "3223 passed" on a run that failed (#1572): the count describes the tests, the
REM exit code describes the run. Only the exit code decides here, and the verdict
REM is printed right after it so the two cannot be read apart. Mirrors test.sh.
echo === Frontend: Vitest ===
call pnpm test
set FRONTEND_STATUS=%errorlevel%
call :verdict %FRONTEND_STATUS% "Frontend: Vitest"

echo.
echo === Rust workspace: cargo test ===
cargo test --workspace --all-features
set RUST_STATUS=%errorlevel%
call :verdict %RUST_STATUS% "Rust workspace: cargo test"

echo.
if %FAILED%==1 (
    echo SOME TESTS FAILED:
    if not "%FRONTEND_STATUS%"=="0" echo   - Frontend: Vitest ^(exit %FRONTEND_STATUS%^)
    if not "%RUST_STATUS%"=="0" echo   - Rust workspace: cargo test ^(exit %RUST_STATUS%^)
    exit /b 1
)
echo ALL TESTS PASSED.
exit /b 0

:verdict
if "%~1"=="0" (
    echo PASS: %~2
) else (
    echo FAIL: %~2 ^(exit %~1^)
    set FAILED=1
)
goto :eof
