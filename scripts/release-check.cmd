@echo off
REM Release readiness checklist — validates that the repo is ready for a release.
REM Run from the repo root: scripts\release-check.cmd
REM
REM Usage: scripts\release-check.cmd [--versions-only] [--expect-version VER] [--help]
REM   --versions-only         Run only the version checks (5-file consistency, the
REM                           optional expected version, Tauri npm/crate drift) and
REM                           exit. Mirrors release-check.sh --versions-only, the
REM                           release workflow's verify-version gate (PKG-007).
REM   --expect-version VER    Also require every version source to equal VER.
REM   --help                  Show this help and exit.

set VERSIONS_ONLY=0
set "EXPECT_VERSION="

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--versions-only" (
    set VERSIONS_ONLY=1
    shift
    goto :parse_args
)
if /i "%~1"=="--expect-version" (
    if "%~2"=="" (
        echo error: --expect-version needs a value 1>&2
        exit /b 2
    )
    set "EXPECT_VERSION=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="--help" goto :usage
if /i "%~1"=="-h" goto :usage
echo error: unknown argument '%~1' 1>&2
exit /b 2

:usage
echo Usage: scripts\release-check.cmd [--versions-only] [--expect-version VER] [--help]
echo   --versions-only         Run only the version checks and exit (no tests, no git checks).
echo   --expect-version VER    Also require every version source to equal VER (a leading v is ignored).
echo   --help                  Show this help and exit.
exit /b 0

:args_done
REM Accept a tag-style value ("v0.1.0") as well as a bare version.
if defined EXPECT_VERSION if "%EXPECT_VERSION:~0,1%"=="v" set "EXPECT_VERSION=%EXPECT_VERSION:~1%"

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
if "%PKG_VER%"=="" (
    echo   FAIL: Could not read a version from package.json
    set FAILED=1
    set ALL_MATCH=0
)
if %ALL_MATCH%==1 (
    echo   PASS: All 5 files agree on version %PKG_VER%
)

if not defined EXPECT_VERSION goto :expect_done
if "%PKG_VER%"=="%EXPECT_VERSION%" (
    echo   PASS: Repository version %PKG_VER% matches the expected version %EXPECT_VERSION%
) else (
    echo   FAIL: Repository version '%PKG_VER%' ^(package.json^) does not match the expected version '%EXPECT_VERSION%'
    set FAILED=1
)
:expect_done

set VERSION=%PKG_VER%

REM === Tauri npm/crate Version Drift ===
echo.
echo === Tauri npm/crate Version Drift ===

REM `pnpm tauri build` refuses to build when an @tauri-apps/* npm package and its
REM Rust crate drift apart on major/minor (issue #1014). Catch it here instead.
node scripts\internal\check-tauri-version-drift.mjs
if errorlevel 1 (
    echo   FAIL: Tauri npm/crate version drift would block 'pnpm tauri build'
    set FAILED=1
) else (
    echo   PASS: Tauri npm packages and Rust crates are aligned
)

if %VERSIONS_ONLY%==0 goto :full_checks
echo.
if %FAILED%==1 (
    echo   RESULT: version checks FAILED
    exit /b 1
)
echo   RESULT: version checks passed
exit /b 0

:full_checks
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

REM === Unconsolidated Change Fragments ===
echo.
echo === Unconsolidated Change Fragments ===

REM Per-branch change fragments live in docs\changes\ (see docs\changes\README.md).
REM At release they must be consolidated into CHANGELOG.md and deleted; README.md stays.
dir /b /s docs\changes\*.md 2>nul | findstr /v /i "\\README.md" >nul 2>&1
if %errorlevel%==0 (
    echo   WARN: Unconsolidated change fragments remain in docs\changes\ - consolidate into CHANGELOG.md and delete:
    dir /b /s docs\changes\*.md 2>nul | findstr /v /i "\\README.md"
    set /a WARNINGS+=1
) else (
    echo   PASS: No unconsolidated change fragments under docs\changes\
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

REM === Unified Coverage (advisory) ===
echo.
echo === Unified Coverage (advisory) ===

REM Whole-app coverage — frontend + Rust merged into one number (TOOL-001).
REM ADVISORY: a low number WARNs but never blocks (no baseline ratchet yet).
REM Follow-up: compare the unified line %% against a stored baseline and fail on a
REM drop. A missing cargo-llvm-cov is a WARN, never a hard fail. Mirrors release-check.sh.
where cargo-llvm-cov >nul 2>&1
if errorlevel 1 (
    echo   WARN: cargo-llvm-cov not installed - skipping unified coverage ^(install: cargo install cargo-llvm-cov^)
    set /a WARNINGS+=1
) else (
    call scripts\coverage.cmd
    if errorlevel 1 (
        echo   WARN: Unified coverage run did not complete cleanly ^(advisory^)
        set /a WARNINGS+=1
    ) else (
        echo   PASS: Unified coverage report produced ^(advisory - see coverage-unified\summary.txt^)
    )
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

REM === TODO/FIXME/HACK Scan ===
echo.
echo === TODO/FIXME/HACK Scan ===

REM FIXME and HACK mark known-broken code or workarounds and BLOCK a release
REM (WA-CI-030); TODO stays a warning. Mirrors release-check.sh: the blocking scan
REM only matches a marker that opens a comment (// FIXME, /* HACK, * FIXME, ...),
REM so string literals and test fixtures that merely mention the words do not trip it.
set "MARKER_FILES=src\*.ts src\*.tsx src-tauri\src\*.rs core\src\*.rs agent\src\*.rs"
set "MARKER_OUT=%TEMP%\termihub-release-markers.txt"

findstr /s /n /r /c:"//[/!]* *FIXME\>" /c:"//[/!]* *HACK\>" /c:"/\*[*!]* *FIXME\>" /c:"/\*[*!]* *HACK\>" /c:"^ *\* *FIXME\>" /c:"^ *\* *HACK\>" %MARKER_FILES% > "%MARKER_OUT%" 2>nul
if %errorlevel%==0 (
    echo   FAIL: Found FIXME/HACK markers in source code
    type "%MARKER_OUT%"
    set FAILED=1
) else (
    echo   PASS: No FIXME/HACK markers found
)

findstr /s /n /r /c:"\<TODO\>" %MARKER_FILES% > "%MARKER_OUT%" 2>nul
if %errorlevel%==0 (
    echo   WARN: Found TODO markers in source code
    set /a WARNINGS+=1
) else (
    echo   PASS: No TODO markers found
)
del "%MARKER_OUT%" >nul 2>&1

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
