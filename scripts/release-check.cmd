@echo off
REM Release readiness checklist — validates that the repo is ready for a release.
REM Run from the repo root: scripts\release-check.cmd

cd /d "%~dp0\.."

set FAILED=0
set WARNINGS=0

REM === Version Consistency ===
echo === Version Consistency ===

for /f "tokens=2 delims=:, " %%a in ('findstr /r /c:"\"version\": *\"" package.json') do (
    set "PKG_VER=%%~a"
    goto :got_pkg_ver
)
:got_pkg_ver

for /f "tokens=2 delims=:, " %%a in ('findstr /r /c:"\"version\": *\"" src-tauri\tauri.conf.json') do (
    set "TAURI_VER=%%~a"
    goto :got_tauri_ver
)
:got_tauri_ver

for /f "tokens=2 delims== " %%a in ('findstr /r /c:"^version = " src-tauri\Cargo.toml') do (
    set "TAURI_CARGO_VER=%%~a"
    goto :got_tauri_cargo_ver
)
:got_tauri_cargo_ver

for /f "tokens=2 delims== " %%a in ('findstr /r /c:"^version = " agent\Cargo.toml') do (
    set "AGENT_VER=%%~a"
    goto :got_agent_ver
)
:got_agent_ver

for /f "tokens=2 delims== " %%a in ('findstr /r /c:"^version = " core\Cargo.toml') do (
    set "CORE_VER=%%~a"
    goto :got_core_ver
)
:got_core_ver

set ALL_MATCH=1
if not "%TAURI_VER%"=="%PKG_VER%" (
    echo   FAIL: src-tauri\tauri.conf.json has version '%TAURI_VER%', expected '%PKG_VER%'
    set FAILED=1
    set ALL_MATCH=0
)
if not "%TAURI_CARGO_VER%"=="%PKG_VER%" (
    echo   FAIL: src-tauri\Cargo.toml has version '%TAURI_CARGO_VER%', expected '%PKG_VER%'
    set FAILED=1
    set ALL_MATCH=0
)
if not "%AGENT_VER%"=="%PKG_VER%" (
    echo   FAIL: agent\Cargo.toml has version '%AGENT_VER%', expected '%PKG_VER%'
    set FAILED=1
    set ALL_MATCH=0
)
if not "%CORE_VER%"=="%PKG_VER%" (
    echo   FAIL: core\Cargo.toml has version '%CORE_VER%', expected '%PKG_VER%'
    set FAILED=1
    set ALL_MATCH=0
)
if %ALL_MATCH%==1 (
    echo   PASS: All 5 files agree on version %PKG_VER%
)

set VERSION=%PKG_VER%

REM === CHANGELOG Dated Section ===
echo.
echo === CHANGELOG Dated Section ===

findstr /r /c:"## \[%VERSION%\] - [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]" CHANGELOG.md >nul 2>&1
if %errorlevel%==0 (
    echo   PASS: Found dated section for version %VERSION%
) else (
    echo   FAIL: No dated section for version %VERSION% found in CHANGELOG.md
    set FAILED=1
)

REM === Tests ===
echo.
echo === Tests ===

call pnpm test
if errorlevel 1 (
    echo   FAIL: Frontend tests failed
    set FAILED=1
) else (
    echo   PASS: Frontend tests passed
)

echo.
cargo test --workspace --all-features
if errorlevel 1 (
    echo   FAIL: Rust tests failed
    set FAILED=1
) else (
    echo   PASS: Rust tests passed
)

REM === Quality Checks ===
echo.
echo === Quality Checks ===

call scripts\check.cmd
if errorlevel 1 (
    echo   FAIL: Quality checks failed
    set FAILED=1
) else (
    echo   PASS: Quality checks passed
)

REM === Git Clean Working Tree ===
echo.
echo === Git Clean Working Tree ===

for /f %%i in ('git status --porcelain') do (
    echo   FAIL: Working tree has uncommitted changes
    git status --short
    set FAILED=1
    goto :branch_check
)
echo   PASS: Working tree is clean

REM === Branch Check ===
:branch_check
echo.
echo === Branch Check ===

for /f %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
if "%BRANCH%"=="main" (
    echo   PASS: On branch 'main'
) else (
    echo %BRANCH% | findstr /r /c:"^release/" >nul 2>&1
    if %errorlevel%==0 (
        echo   PASS: On branch '%BRANCH%'
    ) else (
        echo   FAIL: Expected branch 'main' or 'release/*', but on '%BRANCH%'
        set FAILED=1
    )
)

REM === Summary ===
echo.
echo ===========================================
echo   Release Readiness Summary
echo ===========================================

if %FAILED%==1 (
    echo   RESULT: NOT READY — one or more blocking checks failed
    exit /b 1
) else (
    echo   RESULT: READY for release
)
