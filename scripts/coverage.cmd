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
REM
REM Nightly integration coverage (TOOL-005, #3656): when TERMIHUB_INTEGRATION_LCOV
REM names an lcov from the nightly integration-fixtures lane, it is merged into
REM the unified report per source file (lcov-merge.mjs); TERMIHUB_INTEGRATION_STALE
REM optionally lists files changed since that nightly commit (skipped). Unset
REM locally, so the report stays unit-only.

cd /d "%~dp0\.."

set DRY_RUN=0
if "%~1"=="--dry-run" set DRY_RUN=1

set OUT_DIR=coverage-unified
set FRONTEND_LCOV=coverage\lcov.info
set RUST_LCOV=%OUT_DIR%\rust.lcov
set UNIT_LCOV=%OUT_DIR%\unit.lcov
set MERGED_LCOV=%OUT_DIR%\merged.lcov
set SUMMARY_FILE=%OUT_DIR%\summary.txt
set GAP_REPORT=%OUT_DIR%\integration-gap.md

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
break > "%UNIT_LCOV%"
set FRONTEND_PRESENT=0
set RUST_PRESENT=0
set INTEGRATION_PRESENT=0
if exist "%FRONTEND_LCOV%" (
    type "%FRONTEND_LCOV%" >> "%UNIT_LCOV%"
    set FRONTEND_PRESENT=1
) else (
    echo   note: no frontend lcov at %FRONTEND_LCOV%
)
if exist "%RUST_LCOV%" (
    type "%RUST_LCOV%" >> "%UNIT_LCOV%"
    set RUST_PRESENT=1
) else (
    echo   note: no Rust lcov at %RUST_LCOV%
)

for %%A in ("%UNIT_LCOV%") do set UNIT_SIZE=%%~zA
if "%UNIT_SIZE%"=="0" (
    echo   no coverage data to summarize ^(both lcov files missing^).
    if "%DRY_RUN%"=="1" (
        echo   [dry-run] nothing to summarize — that is expected without a prior run.
        exit /b 0
    )
    exit /b 1
)

REM The integration lcov shares files with the Rust report, so it is merged per
REM file (hits summed, unit report owns the denominator, stale files skipped).
if exist "%GAP_REPORT%" del "%GAP_REPORT%"
set INTEGRATION_SIZE=0
if defined TERMIHUB_INTEGRATION_LCOV if exist "%TERMIHUB_INTEGRATION_LCOV%" (
    for %%A in ("%TERMIHUB_INTEGRATION_LCOV%") do set INTEGRATION_SIZE=%%~zA
)
if not "%INTEGRATION_SIZE%"=="0" (
    echo --- unit tests only ---
    node scripts\internal\lcov-summary.mjs "%UNIT_LCOV%"
    echo --- + nightly integration lane ^(%TERMIHUB_INTEGRATION_LCOV%^) ---
    node scripts\internal\lcov-merge.mjs --base "%UNIT_LCOV%" --overlay "%TERMIHUB_INTEGRATION_LCOV%" --skip-list "%TERMIHUB_INTEGRATION_STALE%" --root "%CD%" --out "%MERGED_LCOV%" --report "%GAP_REPORT%"
    if errorlevel 1 exit /b 1
    set INTEGRATION_PRESENT=1
) else (
    if defined TERMIHUB_INTEGRATION_LCOV echo   note: no integration lcov at %TERMIHUB_INTEGRATION_LCOV%
    copy /y "%UNIT_LCOV%" "%MERGED_LCOV%" >nul
)

REM Sum LF/LH, FNF/FNH, BRF/BRH across the merged tracefile via the shared Node
REM summarizer (Node is already a repo dependency) — identical to coverage.sh.
node scripts\internal\lcov-summary.mjs "%MERGED_LCOV%" > "%SUMMARY_FILE%"
if errorlevel 1 exit /b 1
type "%SUMMARY_FILE%"

echo.
echo Sources merged: frontend=%FRONTEND_PRESENT% rust=%RUST_PRESENT% integration=%INTEGRATION_PRESENT%
echo Merged lcov:    %MERGED_LCOV%
echo Summary:        %SUMMARY_FILE%
if "%INTEGRATION_PRESENT%"=="1" echo Gap report:     %GAP_REPORT%
echo HTML reports:   coverage\ (frontend) — run 'cargo llvm-cov --html' for Rust HTML
endlocal
