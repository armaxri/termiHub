@echo off
setlocal enabledelayedexpansion
REM Unified whole-app coverage — frontend (vitest/v8) + Rust (cargo-llvm-cov).
REM
REM Produces ONE repo-wide coverage number spanning the React/TypeScript
REM frontend and the Rust backend/agent/core crates, plus a merged lcov file.
REM Flagship tooling: a full-coverage (frontend + backend, unified) picture.
REM Addresses audit findings TOOL-001 (unified number), TOOL-002 (the .tsx glob
REM fix lives in vitest.config.ts), and TOOL-003 (Rust coverage via llvm-cov).
REM
REM Run from the repo root: scripts\coverage.cmd  [--dry-run]
REM
REM ADVISORY, NOT A HARD GATE (yet): reports the unified number; does not fail
REM on a low value. Follow-up: capture a baseline, then add a fail-on-decrease
REM ratchet (see coverage.yml). Mirrors coverage.sh.

cd /d "%~dp0\.."

set DRY_RUN=0
if "%~1"=="--dry-run" set DRY_RUN=1

set OUT_DIR=coverage-unified
set FRONTEND_LCOV=coverage\lcov.info
set RUST_LCOV=%OUT_DIR%\rust.lcov
set MERGED_LCOV=%OUT_DIR%\merged.lcov
set SUMMARY_FILE=%OUT_DIR%\summary.txt

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

echo === Frontend coverage (vitest v8 -^> lcov) ===
if "%DRY_RUN%"=="1" (
    echo   [dry-run] skipping: pnpm test:coverage
) else (
    call pnpm test:coverage
    if errorlevel 1 exit /b 1
)

echo === Rust coverage (cargo llvm-cov -^> lcov) ===
if "%DRY_RUN%"=="1" (
    echo   [dry-run] skipping: cargo llvm-cov --workspace --all-features --lcov
) else (
    cargo llvm-cov --workspace --all-features --lcov --output-path "%RUST_LCOV%"
    if errorlevel 1 exit /b 1
)

echo === Merging lcov + computing unified number ===
break > "%MERGED_LCOV%"
set FRONTEND_PRESENT=0
set RUST_PRESENT=0
if exist "%FRONTEND_LCOV%" (
    type "%FRONTEND_LCOV%" >> "%MERGED_LCOV%"
    set FRONTEND_PRESENT=1
) else (
    echo   note: no frontend lcov at %FRONTEND_LCOV%
)
if exist "%RUST_LCOV%" (
    type "%RUST_LCOV%" >> "%MERGED_LCOV%"
    set RUST_PRESENT=1
) else (
    echo   note: no Rust lcov at %RUST_LCOV%
)

for %%A in ("%MERGED_LCOV%") do set MERGED_SIZE=%%~zA
if "%MERGED_SIZE%"=="0" (
    echo   no coverage data to summarize ^(both lcov files missing^).
    if "%DRY_RUN%"=="1" (
        echo   [dry-run] nothing to summarize — that is expected without a prior run.
        exit /b 0
    )
    exit /b 1
)

REM Sum LF/LH, FNF/FNH, BRF/BRH across the merged tracefile via the shared Node
REM summarizer (Node is already a repo dependency) — identical to coverage.sh.
node scripts\internal\lcov-summary.mjs "%MERGED_LCOV%" > "%SUMMARY_FILE%"
if errorlevel 1 exit /b 1
type "%SUMMARY_FILE%"

echo.
echo Sources merged: frontend=%FRONTEND_PRESENT% rust=%RUST_PRESENT%
echo Merged lcov:    %MERGED_LCOV%
echo Summary:        %SUMMARY_FILE%
echo HTML reports:   coverage\ (frontend) — run 'cargo llvm-cov --html' for Rust HTML
endlocal
