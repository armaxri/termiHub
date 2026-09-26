@echo off
setlocal EnableDelayedExpansion
REM Reproduce the per-PR CI gate locally with ONE command (issue TOOL-006).
REM
REM Run from the repo root:
REM   scripts\ci-local.cmd            REM full gate — everything the PR CI runs
REM   scripts\ci-local.cmd --quick    REM fast subset (seconds) — used by the pre-push hook
REM
REM Mirrors .github\workflows\code-quality.yml. Composes scripts\check.cmd and
REM adds the steps that gate CI but check.cmd does not cover (tsc, per-feature
REM core builds, cargo audit/deny, the pnpm production-audit gate, the Python
REM machinery suite, plugin packaging, commitlint). Like CI (fail-fast: false)
REM every gate runs to completion; the full failure list prints at the end.
REM Optional tools (cargo-audit, cargo-deny, uv) are SKIPPED with a warning when
REM absent rather than failing the run.

cd /d "%~dp0\.."

set "MODE=full"
if /i "%~1"=="--quick" set "MODE=quick"
if /i "%~1"=="--full" set "MODE=full"

set FAILED=0
set "FAILED_GATES="
set INCOMPLETE=0

if not exist node_modules (
    echo node_modules missing, running pnpm install...
    call pnpm install
    if errorlevel 1 exit /b 1
    echo.
)

echo Reproducing the per-PR CI gate locally (mode: %MODE%)

echo.
echo === Quality checks (scripts\check.cmd) ===
call scripts\check.cmd
if errorlevel 1 (call :fail "Quality checks (scripts\check.cmd)") else (echo PASS)

echo.
echo === Frontend: TypeScript (tsc --noEmit) ===
call pnpm exec tsc --noEmit
if errorlevel 1 (call :fail "Frontend: TypeScript (tsc --noEmit)") else (echo PASS)

echo.
echo === Commit messages (commitlint) ===
call :commitlint
if errorlevel 1 (call :fail "Commit messages (commitlint)") else (echo PASS)

if /i "%MODE%"=="full" (
    echo.
    echo === Rust: core opt-in features in isolation ===
    call :core_features
    if errorlevel 1 (call :fail "Rust: core opt-in features in isolation") else (echo PASS)

    echo.
    echo === Rust workspace: cargo test ===
    call cargo test --workspace --all-features
    if errorlevel 1 (call :fail "Rust workspace: cargo test") else (echo PASS)

    echo.
    echo === Frontend: vitest + coverage floors ===
    call pnpm test:coverage
    if errorlevel 1 (call :fail "Frontend: vitest + coverage floors") else (echo PASS)

    echo.
    echo === Security: cargo audit ===
    where cargo-audit >nul 2>nul
    if errorlevel 1 (call :skip "Security: cargo audit" "cargo-audit not installed") else (
        call cargo audit
        if errorlevel 1 (call :fail "Security: cargo audit") else (echo PASS)
    )

    echo.
    echo === Security: cargo deny (supply-chain) ===
    where cargo-deny >nul 2>nul
    if errorlevel 1 (call :skip "Security: cargo deny (supply-chain)" "cargo-deny not installed") else (
        call cargo deny check advisories bans licenses sources
        if errorlevel 1 (call :fail "Security: cargo deny (supply-chain)") else (echo PASS)
    )

    echo.
    echo === Security: pnpm audit (production deps) ===
    call bash scripts/internal/pnpm-audit-prod-gate.sh
    if errorlevel 1 (call :fail "Security: pnpm audit (production deps)") else (echo PASS)

    echo.
    echo === System-test harness (machinery) ===
    where uv >nul 2>nul
    if errorlevel 1 (call :skip "System-test harness (machinery)" "uv not installed") else (
        call bash tests/system/pytest.sh -m "not integration" -q
        if errorlevel 1 (call :fail "System-test harness (machinery)") else (echo PASS)
    )

    echo.
    echo === Package example plugins ===
    call :package_plugins
    if errorlevel 1 (call :fail "Package example plugins") else (echo PASS)
)

echo.
echo ======================================================================
if %FAILED%==1 (
    echo SOME GATES FAILED:
    echo !FAILED_GATES!
    echo Run scripts\format.cmd to auto-fix formatting issues.
    exit /b 1
)
if %INCOMPLETE%==1 (
    echo ALL RUN GATES PASSED — but some were SKIPPED, so this run did not fully
    echo reproduce CI. Install the missing tools for a complete gate.
    exit /b 0
)
if /i "%MODE%"=="quick" (
    echo QUICK GATE PASSED. Run scripts\ci-local.cmd for the full CI gate.
) else (
    echo ALL CI GATES PASSED.
)
exit /b 0

:fail
set FAILED=1
set "FAILED_GATES=!FAILED_GATES!  - %~1"
echo FAIL: %~1
exit /b 0

:skip
set INCOMPLETE=1
echo SKIPPED: %~2
exit /b 0

:core_features
rem Clippy termihub-core with each opt-in feature in isolation (#3318). Mirrors the
rem CI step; keep this list in sync with core/Cargo.toml [features].
call cargo clippy -p termihub-core --no-default-features --all-targets -- -D warnings || exit /b 1
for %%F in (tracing embedded-servers plugin http-monitor serial local-shell telnet ssh docker wsl ftp mock-remote-desktop vnc rdp-sidecar) do (
  call cargo clippy -p termihub-core --no-default-features --features %%F --all-targets -- -D warnings || exit /b 1
)
exit /b 0

:package_plugins
call scripts\package-plugin.cmd examples\plugins\solarized-night-theme --out target\plugin-dist --no-build || exit /b 1
call scripts\package-plugin.cmd examples\plugins\echo-backend --out target\plugin-dist || exit /b 1
if not exist target\plugin-dist\solarized-night-1.0.0.termihub-plugin exit /b 1
if not exist target\plugin-dist\echo-backend-1.0.0.termihub-plugin exit /b 1
exit /b 0

:commitlint
set "BASE="
for /f "delims=" %%b in ('git merge-base HEAD origin/develop 2^>nul') do set "BASE=%%b"
if not defined BASE for /f "delims=" %%b in ('git merge-base HEAD develop 2^>nul') do set "BASE=%%b"
if not defined BASE (
    echo no develop base found to lint against; linting HEAD only
    call pnpm exec commitlint --from HEAD~1 --to HEAD --verbose
    exit /b %errorlevel%
)
for /f "delims=" %%h in ('git rev-parse HEAD') do set "HEADSHA=%%h"
if "%BASE%"=="%HEADSHA%" (
    echo no commits ahead of develop; nothing to lint
    exit /b 0
)
call pnpm exec commitlint --from %BASE% --to HEAD --verbose
exit /b %errorlevel%
