@echo off
setlocal EnableDelayedExpansion
REM Reproduce the per-PR CI gate locally with ONE command (issue TOOL-006).
REM
REM Run from the repo root:
REM   scripts\ci-local.cmd            REM full gate - the per-PR CI it can reproduce
REM   scripts\ci-local.cmd --quick    REM fast subset (seconds) - used by the pre-push hook
REM
REM Mirrors .github\workflows\code-quality.yml job by job, like ci-local.sh.
REM Composes scripts\check.cmd and adds the steps that gate CI but check.cmd does
REM not cover (tsc, per-feature core builds, the ts-rs/wire-fixture staleness
REM diffs, cargo-machete, the rdp-sidecar and fuzz-crate checks, bundle size,
REM rustdoc, shellcheck/parity/headless, actionlint, tests, the machinery suite,
REM the testid drift guard, plugin packaging, audits, commitlint).
REM scripts\internal\ci-local.mjs maps every code-quality.yml job to these gate
REM titles (or to why it is not reproduced) and ci-local.test.mjs keeps that map
REM in sync with the workflow and with both scripts (#4358, TOOL2-004).
REM Like CI (fail-fast: false) every gate runs to completion; the full failure
REM list prints at the end. Optional tools (cargo-audit, cargo-deny,
REM cargo-machete, uv, shellcheck, actionlint, bash) are SKIPPED with a warning
REM when absent rather than failing the run.
REM
REM Gate titles go through delayed expansion (!T!) because several contain
REM characters cmd would otherwise parse: parentheses and the "<->" arrow.

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

call :run_gate "Quality checks (scripts\check.cmd)" g_check
call :run_gate "Frontend: TypeScript (tsc --noEmit)" g_tsc
call :run_gate "Commit messages (commitlint)" g_commitlint

REM Full mode follows code-quality.yml job by job; keep it in step with
REM ci-local.sh (same gate titles, same order).
if /i not "%MODE%"=="full" goto summary

REM Rust Code Quality (fmt/clippy/toolchain pin ran in check.cmd above).
call :run_gate "Rust: pre-release crates reviewed" g_prerelease
call :run_gate "Rust: core opt-in features in isolation" g_core_features
call :run_gate "Rust: ts-rs bindings not stale" g_tsrs_stale
call :run_gate "Rust: IPC wire fixtures not stale" g_wire_fixtures_stale
call :have_cargo machete
if errorlevel 1 (call :skip_gate "Rust: unused dependencies (cargo-machete)" "cargo-machete not installed") else (call :run_gate "Rust: unused dependencies (cargo-machete)" g_machete)
call :run_gate "Package example plugins" g_package_plugins

REM RDP Sidecar Quality.
call :run_gate "RDP sidecar: fmt + clippy + tests" g_rdp_sidecar

REM Frontend Code Quality (lint/prettier/markdownlint/IPC contract in check.cmd).
call :run_gate "Frontend: manual-test inventory" g_manual_inventory
call :run_gate "Version sources + Tauri drift" g_versions
call :run_gate "Frontend: bundle size budget" g_bundle_size

call :run_gate "Rust: rustdoc (-D warnings)" g_rustdoc
call :run_gate "Plugin IPC fuzz crate (fmt + clippy)" g_plugin_fuzz

REM Shell Script Quality + Workflow Lint. The parity and headless checkers are
REM bash scripts (CI runs them on Ubuntu); here they need Git Bash.
where shellcheck >nul 2>nul
if errorlevel 1 (call :skip_gate "Shell: ShellCheck" "shellcheck not installed") else (call :run_gate "Shell: ShellCheck" g_shellcheck)
where bash >nul 2>nul
if errorlevel 1 (call :skip_gate "Shell: script parity (.sh <-> .cmd)" "bash not installed") else (call :run_gate "Shell: script parity (.sh <-> .cmd)" g_script_parity)
where bash >nul 2>nul
if errorlevel 1 (call :skip_gate "Shell: headless smoke (--help paths)" "bash not installed") else (call :run_gate "Shell: headless smoke (--help paths)" g_script_headless)
where actionlint >nul 2>nul
if errorlevel 1 (call :skip_gate "Workflow lint (actionlint)" "actionlint not installed") else (call :run_gate "Workflow lint (actionlint)" g_actionlint)

REM Run Tests (this host's OS only).
call :run_gate "Rust workspace: cargo test" g_rust_tests
call :run_gate "Frontend: vitest + coverage floors" g_frontend_coverage

REM System-Test Harness (machinery) + Test-ID Drift Guard.
where uv >nul 2>nul
if errorlevel 1 (call :skip_gate "System-test harness (machinery)" "uv not installed") else (call :run_gate "System-test harness (machinery)" g_machinery)
call :run_gate "Test inventory ratchet" g_test_inventory
call :run_gate "Test-ID drift guard" g_testid_drift

REM security-audit.yml (runs on PRs that touch a manifest or lockfile).
call :have_cargo audit
if errorlevel 1 (call :skip_gate "Security: cargo audit" "cargo-audit not installed") else (call :run_gate "Security: cargo audit" g_cargo_audit)
call :have_cargo deny
if errorlevel 1 (call :skip_gate "Security: cargo deny (supply-chain)" "cargo-deny not installed") else (call :run_gate "Security: cargo deny (supply-chain)" g_cargo_deny)
call :have_cargo deny
if errorlevel 1 (call :skip_gate "RDP sidecar: cargo deny" "cargo-deny not installed") else (call :run_gate "RDP sidecar: cargo deny" g_rdp_sidecar_deny)
call :run_gate "Security: pnpm audit (production deps)" g_pnpm_audit_prod

:summary
echo.
echo ======================================================================
if %FAILED%==1 (
    echo SOME GATES FAILED:
    echo !FAILED_GATES!
    echo Run scripts\format.cmd to auto-fix formatting issues.
    exit /b 1
)
if %INCOMPLETE%==1 (
    echo ALL RUN GATES PASSED - but some were SKIPPED, so this run did not fully
    echo reproduce CI. Install the missing tools for a complete gate.
    exit /b 0
)
if /i "%MODE%"=="quick" (
    echo QUICK GATE PASSED. Run scripts\ci-local.cmd for the full CI gate.
    exit /b 0
)
echo ALL REPRODUCED CI GATES PASSED. Deliberately not reproduced here:
for /f "delims=" %%L in ('node scripts\internal\ci-local.mjs not-reproduced') do echo   - %%L
echo Nor the integration/system E2E lanes - Docker fixtures, see docs\testing.md.
exit /b 0

REM --- gate plumbing ------------------------------------------------------------

REM Run one gate: %1 = title, %2 = the :label of its body. Records PASS/FAIL and
REM always returns 0 so every gate runs (CI fail-fast: false).
:run_gate
set "T=%~1"
echo.
echo === !T! ===
call :%~2
if errorlevel 1 (
    set FAILED=1
    set "FAILED_GATES=!FAILED_GATES!  - !T!"
    echo FAIL: !T!
) else (
    echo PASS: !T!
)
exit /b 0

:skip_gate
set "T=%~1"
set "R=%~2"
echo.
echo === !T! ===
echo SKIPPED: !R!
set INCOMPLETE=1
exit /b 0

REM errorlevel 0 when cargo-%1 is installed (on PATH or as a cargo subcommand).
:have_cargo
where cargo-%1 >nul 2>nul
if not errorlevel 1 exit /b 0
cargo %1 --version >nul 2>nul
exit /b %errorlevel%

REM --- gate bodies --------------------------------------------------------------

:g_check
call scripts\check.cmd
exit /b %errorlevel%

:g_tsc
call pnpm exec tsc --noEmit
exit /b %errorlevel%

:g_prerelease
node scripts\internal\check-prerelease-crates.mjs
exit /b %errorlevel%

:g_core_features
rem Clippy termihub-core with each opt-in feature in isolation (#3318). The list
rem comes from `cargo metadata` via the shared helper, as the CI step derives it
rem (#4358: the old hand-kept list had fallen six features behind).
set "CORE_FEATURES="
for /f "delims=" %%F in ('node scripts\internal\ci-local.mjs core-features') do set "CORE_FEATURES=!CORE_FEATURES! %%F"
if not defined CORE_FEATURES exit /b 1
call cargo clippy -p termihub-core --no-default-features --all-targets -- -D warnings || exit /b 1
for %%F in (!CORE_FEATURES!) do (
  call cargo clippy -p termihub-core --no-default-features --features %%F --all-targets -- -D warnings || exit /b 1
)
exit /b 0

:g_tsrs_stale
rem Regenerating rewrites the bindings in place; like CI this fails when they
rem differ from the index (the regenerated files are then ready to commit).
call cargo test -p termihub --lib export_bindings || exit /b 1
call cargo test -p termihub-core --lib --features ssh,docker,embedded-servers,plugin,http-monitor export_bindings || exit /b 1
git diff --exit-code -- src/types/generated
exit /b %errorlevel%

:g_wire_fixtures_stale
call cargo test -p termihub --lib ipc_wire_fixtures || exit /b 1
set "STALE="
for /f "delims=" %%S in ('git status --porcelain -- src/test/fixtures/wire') do set "STALE=1"
if not defined STALE exit /b 0
echo IPC wire fixtures are stale; commit the regenerated files:
git status --porcelain -- src/test/fixtures/wire
exit /b 1

:g_machete
call cargo machete
exit /b %errorlevel%

:g_package_plugins
call scripts\package-plugin.cmd examples\plugins\solarized-night-theme --out target\plugin-dist --no-build || exit /b 1
call scripts\package-plugin.cmd examples\plugins\echo-backend --out target\plugin-dist || exit /b 1
call scripts\package-plugin.cmd examples\plugins\log-highlighter --out target\plugin-dist --no-build || exit /b 1
call scripts\package-plugin.cmd examples\plugins\clock-widget --out target\plugin-dist --no-build || exit /b 1
if not exist target\plugin-dist\log-highlighter-1.0.0.termihub-plugin exit /b 1
if not exist target\plugin-dist\clock-widget-1.0.0.termihub-plugin exit /b 1
if not exist target\plugin-dist\solarized-night-1.0.0.termihub-plugin exit /b 1
if not exist target\plugin-dist\echo-backend-1.0.0.termihub-plugin exit /b 1
exit /b 0

:g_rdp_sidecar
rem The workspace-excluded sidecar has its own lockfile.
pushd rdp-sidecar
call cargo fmt --check && call cargo clippy --locked --all-targets -- -D warnings && call cargo test --locked
set "RC=!errorlevel!"
popd
exit /b !RC!

:g_manual_inventory
python scripts\manual-inventory.py --check
exit /b %errorlevel%

:g_versions
call scripts\release-check.cmd --versions-only
exit /b %errorlevel%

:g_bundle_size
call pnpm build || exit /b 1
call pnpm size
exit /b %errorlevel%

:g_rustdoc
set "RUSTDOCFLAGS=-D warnings"
call cargo doc --no-deps -p termihub-core
if errorlevel 1 (
    set "RUSTDOCFLAGS="
    exit /b 1
)
call cargo doc --no-deps --all-features -p termihub -p termihub-core -p termihub-agent
if errorlevel 1 (
    set "RUSTDOCFLAGS="
    exit /b 1
)
rem Each opt-in core feature alone (#4561): a link to an item gated behind
rem another feature resolves under --all-features but breaks in isolation.
set "DOC_FEATURES="
for /f "delims=" %%F in ('node scripts\internal\ci-local.mjs core-features') do set "DOC_FEATURES=!DOC_FEATURES! %%F"
if not defined DOC_FEATURES (
    set "RUSTDOCFLAGS="
    exit /b 1
)
for %%F in (!DOC_FEATURES!) do (
  call cargo doc --no-deps -p termihub-core --features %%F
  if errorlevel 1 (
      set "RUSTDOCFLAGS="
      exit /b 1
  )
)
set "RUSTDOCFLAGS="
exit /b 0

:g_plugin_fuzz
rem The workspace-excluded fuzz crate, seeded from the workspace lockfile like
rem CI (its own Cargo.lock is gitignored).
copy /y Cargo.lock plugin-runner\fuzz\Cargo.lock >nul || exit /b 1
pushd plugin-runner\fuzz
call cargo fmt -- --check && call cargo clippy --all-targets -- -D warnings
set "RC=!errorlevel!"
popd
exit /b !RC!

:g_shellcheck
node scripts\internal\ci-local.mjs shellcheck
exit /b %errorlevel%

:g_script_parity
bash scripts/internal/check-script-parity.sh
exit /b %errorlevel%

:g_script_headless
bash scripts/internal/check-script-headless.sh
exit /b %errorlevel%

:g_actionlint
actionlint
exit /b %errorlevel%

:g_rust_tests
call cargo test --workspace --all-features
exit /b %errorlevel%

:g_frontend_coverage
call pnpm test:coverage
exit /b %errorlevel%

:g_machinery
call bash tests/system/pytest.sh -m "not integration" -q
exit /b %errorlevel%

:g_test_inventory
python scripts\build-test-inventory.py --check-baseline
exit /b %errorlevel%

:g_testid_drift
python scripts\check-testid-drift.py
exit /b %errorlevel%

:g_cargo_audit
call cargo audit
exit /b %errorlevel%

:g_cargo_deny
call cargo deny check advisories bans licenses sources
exit /b %errorlevel%

:g_rdp_sidecar_deny
pushd rdp-sidecar
call cargo deny check advisories bans licenses sources
set "RC=!errorlevel!"
popd
exit /b !RC!

:g_pnpm_audit_prod
call bash scripts/internal/pnpm-audit-prod-gate.sh
exit /b %errorlevel%

:g_commitlint
set "BASE="
for /f "delims=" %%b in ('git merge-base HEAD origin/develop 2^>nul') do set "BASE=%%b"
if not defined BASE for /f "delims=" %%b in ('git merge-base HEAD develop 2^>nul') do set "BASE=%%b"
if not defined BASE (
    echo no develop base found to lint against; linting HEAD only
    call pnpm exec commitlint --from HEAD~1 --to HEAD --verbose
    exit /b !errorlevel!
)
for /f "delims=" %%h in ('git rev-parse HEAD') do set "HEADSHA=%%h"
if "%BASE%"=="%HEADSHA%" (
    echo no commits ahead of develop; nothing to lint
    exit /b 0
)
call pnpm exec commitlint --from %BASE% --to HEAD --verbose
exit /b %errorlevel%
