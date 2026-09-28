@echo off
REM Release readiness checklist — validates that the repo is ready for a release.
REM Run from the repo root: scripts\release-check.cmd
REM
REM Usage: scripts\release-check.cmd [--versions-only] [--expect-version VER] [--help]
REM
REM The full run (no flags) gates on: versions, CHANGELOG, unit tests, the coverage
REM ratchet, quality checks, a clean tree on main/release/*, green CI integration
REM lanes for HEAD (needs gh, logged in), a blocking TODO/FIXME/HACK scan with an
REM allowlist, and a real bundle build plus smoke test (needs a display). Slow.
REM
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
echo   The full run also requires green CI integration lanes for HEAD ^(gh, logged in^), a
echo   blocking TODO/FIXME/HACK scan ^(scripts\release-marker-allowlist.json^) and a real
echo   bundle build + smoke test ^(needs a display^).
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

REM === Coverage Ratchet ===
echo.
echo === Coverage Ratchet ===

REM Whole-app coverage — frontend + Rust (TOOL-001) — graded against the committed
REM per-platform baseline in scripts\coverage-baseline.json (TOOL-011, #3740): a
REM per-component drop beyond the tolerance FAILS the release gate, the same
REM ratchet coverage.yml enforces. cargo-llvm-cov is required. Mirrors release-check.sh.
cargo llvm-cov --version >nul 2>&1
if errorlevel 1 (
    echo   FAIL: cargo-llvm-cov not installed - cannot grade coverage ^(install: cargo install cargo-llvm-cov^)
    set FAILED=1
) else (
    call scripts\coverage.cmd
    if errorlevel 1 (
        echo   FAIL: Coverage ratchet failed - coverage dropped below scripts\coverage-baseline.json ^(or the run failed^)
        set FAILED=1
    ) else (
        echo   PASS: Coverage at or above the committed baseline ^(see coverage-unified\ratchet.md^)
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

REM === Integration / System Tests (CI lanes on this commit) ===
echo.
echo === Integration / System Tests (CI lanes on this commit) ===

REM The unit tests above never touch the bridge integration lane, the Docker
REM fixture suites or the agent live tests (TOOL-011, #3750), and running them
REM locally is not reliable (Docker fixtures, a real display, a quiet machine).
REM So, like the Release workflow, require the newest 'Release Candidate: Full
REM Integration' run and the post-merge Code Quality and Dev Build push runs to
REM be green on this exact commit, via the same release-integration-gate.mjs.
REM Needs the gh CLI, logged in. Mirrors release-check.sh.
for /f %%s in ('git rev-parse HEAD') do set "HEAD_SHA=%%s"
set "GATE_REF=%BRANCH%"
if "%GATE_REF%"=="HEAD" set "GATE_REF=RELEASE-BRANCH-OR-TAG"
set "GATE_REPO=armaxri/termiHub"
set "GATE_TOKEN="
where gh >nul 2>&1
if errorlevel 1 (
    echo   FAIL: gh CLI not installed - cannot verify the integration lanes ^(https://cli.github.com^)
    set FAILED=1
    goto :markers
)
for /f %%r in ('gh repo view --json nameWithOwner -q .nameWithOwner 2^>nul') do set "GATE_REPO=%%r"
set "DISPATCH_CMD=gh workflow run release-candidate.yml --repo %GATE_REPO% --ref %GATE_REF%"
for /f %%t in ('gh auth token 2^>nul') do set "GATE_TOKEN=%%t"
if not defined GATE_TOKEN (
    echo   FAIL: gh CLI not logged in - cannot verify the integration lanes ^(run: gh auth login^)
    set FAILED=1
    goto :markers
)
set "ON_REMOTE="
for /f %%b in ('git branch -r --contains %HEAD_SHA% 2^>nul') do set "ON_REMOTE=1"
if not defined ON_REMOTE (
    echo   FAIL: HEAD %HEAD_SHA% is on no remote branch, so no CI run can exist for it
    echo     Push it first ^(git push^), then run the full integration lanes on it:
    echo       %DISPATCH_CMD%
    echo     If you pushed it from elsewhere, run 'git fetch' and re-run this script.
    set FAILED=1
    goto :markers
)
set "RELEASE_GATE_LOCAL=1"
set "RELEASE_SHA=%HEAD_SHA%"
set "RELEASE_REF_NAME=%GATE_REF%"
set "GITHUB_REPOSITORY=%GATE_REPO%"
set "GITHUB_TOKEN=%GATE_TOKEN%"
node scripts\internal\release-integration-gate.mjs
set GATE_RC=%errorlevel%
set "GITHUB_TOKEN="
set "RELEASE_GATE_LOCAL="
if not %GATE_RC%==0 (
    echo     The dispatched run grades the ref's tip, so dispatch it on a ref whose tip is
    echo     %HEAD_SHA% ^(the release branch you are on, or the release tag^).
    echo   FAIL: Integration lanes not green on %HEAD_SHA% - run: %DISPATCH_CMD%
    set FAILED=1
) else (
    echo   PASS: Integration lanes green on %HEAD_SHA%
)

REM === TODO/FIXME/HACK Scan ===
:markers
echo.
echo === TODO/FIXME/HACK Scan ===

REM A TODO/FIXME/HACK comment in shipped source BLOCKS the release unless it is
REM listed, with a reason, in scripts\release-marker-allowlist.json (TOOL-011,
REM #3750; WA-CI-030). Only markers that open a comment count. The scan is one
REM Node script, so this and release-check.sh run the identical check.
node scripts\internal\release-marker-scan.mjs
if errorlevel 1 (
    echo   FAIL: TODO/FIXME/HACK markers block the release ^(allowlist: scripts\release-marker-allowlist.json^)
    set FAILED=1
) else (
    echo   PASS: No un-allowlisted TODO/FIXME/HACK markers
)

REM === Release Bundle Build + Smoke Test ===
echo.
echo === Release Bundle Build + Smoke Test ===

REM Build the real installable bundle with the installers' recipe (build.cmd:
REM RDP sidecar + notices + 'pnpm tauri build'), then launch it with
REM smoke-test.cmd (TOOL-011, #3750). Runs last: slowest step, needs a desktop
REM session. Mirrors release-check.sh.
set "SMOKE_APP=target\release\termihub.exe"
call scripts\build.cmd
if errorlevel 1 (
    echo   FAIL: Release bundle build failed ^(scripts\build.cmd^)
    set FAILED=1
    goto :summary
)
set "INSTALLER="
for %%f in (target\release\bundle\msi\*.msi target\release\bundle\nsis\*.exe) do set "INSTALLER=%%f"
if defined INSTALLER (
    echo   PASS: Bundle build produced %INSTALLER%
) else (
    echo   FAIL: Bundle build produced no installer ^(expected target\release\bundle\msi\*.msi or nsis\*.exe^)
    set FAILED=1
)
if not exist "%SMOKE_APP%" (
    echo   FAIL: Built app not found at %SMOKE_APP% - cannot smoke-test it
    set FAILED=1
    goto :summary
)
call scripts\smoke-test.cmd "%SMOKE_APP%"
if errorlevel 1 (
    echo   FAIL: Smoke test failed against %SMOKE_APP%
    set FAILED=1
) else (
    echo   PASS: Smoke test passed against %SMOKE_APP%
)

REM === Summary ===
:summary
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
