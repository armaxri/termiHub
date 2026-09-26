@echo off
REM Build the remote agent (termihub-agent) for Linux and Windows targets.
REM Windows twin of scripts/build-agents.sh -- keep the two in feature parity
REM (flags AND outputs); scripts/internal/check-script-parity.sh compares the
REM flags each one parses and fails CI when they drift.
REM
REM Default mode cross-compiles the Linux musl targets via cross-rs.
REM --native builds with the local cargo toolchain. Without --targets it builds
REM the Windows MSVC agents:
REM   - x86_64-pc-windows-msvc (required)  -> termihub-agent.exe
REM   - aarch64-pc-windows-msvc (best effort, needs the ARM64 MSVC build tools)
REM cross-rs cannot build the MSVC ABI, so Windows agents must be built natively
REM on a Windows host with the MSVC toolchain (Visual Studio Build Tools).
REM
REM Every built binary gets a "<binary>.sha256" sidecar ("<hex>  <name>", the
REM sha256sum format release.yml publishes, #1350). A target whose sidecar cannot
REM be written FAILS, and a final gate re-checks every built binary has a
REM non-empty sidecar (WA-CI-036, same as build-agents.sh).
REM
REM Usage: scripts\build-agents.cmd [--targets <list>] [--sequential] [--native]
REM                                 [--dev] [--features <list>] [--sign-key <pem>]
REM                                 [--help]
REM
REM Prerequisites (default Linux mode): Rust, Docker/Podman (running), cross-rs.
REM Run scripts\setup-agent-cross.cmd first to install required toolchains.
REM Prerequisites (--native Windows mode): Rust + MSVC toolchain only.
REM Hashing uses Windows PowerShell (Get-FileHash); --sign-key additionally needs
REM Git Bash with OpenSSL 3 (Git for Windows ships both).

setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set "TARGETS="
set "NATIVE=0"
set "DEV=0"
set "FEATURES="
set "SIGN_KEY="

REM ------------------------------------------------------------------ REM
REM Argument parsing (mirrors build-agents.sh)                            REM
REM ------------------------------------------------------------------ REM
:parse
if "%~1"=="" goto :after_parse
if /i "%~1"=="--help" goto :usage
if /i "%~1"=="-h" goto :usage
if /i "%~1"=="--native" (
    set "NATIVE=1"
    shift
    goto :parse
)
if /i "%~1"=="--sequential" (
    REM Accepted for parity with build-agents.sh; this script always builds
    REM its targets one at a time.
    shift
    goto :parse
)
if /i "%~1"=="--dev" (
    set "DEV=1"
    shift
    goto :parse
)
if /i "%~1"=="--targets" (
    set "LIST_VAR=TARGETS"
    set "LIST_FLAG=--targets"
    shift
    goto :collect_list
)
if /i "%~1"=="--features" (
    set "LIST_VAR=FEATURES"
    set "LIST_FLAG=--features"
    shift
    goto :collect_list
)
if /i "%~1"=="--sign-key" (
    if "%~2"=="" (
        echo ERROR: --sign-key requires a private key path.
        exit /b 1
    )
    set "SIGN_KEY=%~2"
    shift
    shift
    goto :parse
)
echo Unknown option: %~1
echo Run with --help for usage information.
exit /b 1

REM Collect a comma-separated list value. cmd.exe splits unquoted arguments on
REM commas, so "--targets a,b" arrives as two arguments: gather every following
REM argument up to the next option and re-join them with commas. A quoted
REM "a,b" arrives as one argument and is taken as-is.
:collect_list
set "LIST_COUNT=0"
:collect_next
if "%~1"=="" goto :collect_done
set "LIST_ITEM=%~1"
if "%LIST_ITEM:~0,1%"=="-" goto :collect_done
if defined %LIST_VAR% (
    set "%LIST_VAR%=!%LIST_VAR%!,%~1"
) else (
    set "%LIST_VAR%=%~1"
)
set /a LIST_COUNT+=1
shift
goto :collect_next
:collect_done
if %LIST_COUNT% equ 0 (
    echo ERROR: %LIST_FLAG% requires a comma-separated list.
    exit /b 1
)
goto :parse

:usage
echo Usage: build-agents.cmd [OPTIONS]
echo.
echo Build the remote agent for Linux and Windows targets.
echo Linux builds use cross-rs (static musl). Windows builds use native cargo.
echo Targets are built one at a time.
echo.
echo Options:
echo   --targets ^<list^>   Comma-separated list of targets to build (default: all Linux
echo                      targets in cross-rs mode; the Windows MSVC targets in --native
echo                      mode, x64 required and ARM64 best effort)
echo   --sequential       Accepted for parity with build-agents.sh (always sequential here)
echo   --native           Build using the local cargo toolchain instead of cross-rs/Docker.
echo                      Required for Windows targets.
echo   --dev              Build in debug profile (omits --release). Much faster to compile;
echo                      binary lands in target\^<triple^>\debug\ instead of release\.
echo   --features ^<list^>  Comma-separated cargo features to enable (passed through as
echo                      `--features ^<list^>`), e.g. test-hooks for the system-test
echo                      harness; OFF for every real release build.
echo   --sign-key ^<pem^>   Also write a ^<binary^>.sig update signature with this Ed25519
echo                      private key (must match agent\keys\update-signing.pub.pem;
echo                      AGT-005). Runs scripts/internal/agent-update-signing.sh via
echo                      Git Bash + OpenSSL 3. Without it any stale .sig is removed.
echo   --help, -h         Show this help message
echo.
echo Every built binary gets a ^<binary^>.sha256 checksum sidecar; a target whose
echo sidecar cannot be written fails the build.
echo.
echo Linux targets (default, cross-rs):
echo   x86_64-unknown-linux-musl       Static x64 binaries (musl)
echo   aarch64-unknown-linux-musl      Static ARM64 binaries (musl)
echo   armv7-unknown-linux-musleabihf  Static ARMv7 binaries (musl, older Raspberry Pi)
echo.
echo Windows targets (--native, build on a Windows host with MSVC tools):
echo   x86_64-pc-windows-msvc          Windows x64 (emits termihub-agent.exe)
echo   aarch64-pc-windows-msvc         Windows ARM64 (best effort - needs ARM64 MSVC tools)
echo.
echo Prerequisites (Linux mode):
echo   - Rust toolchain (rustup)
echo   - Docker Desktop or Podman Desktop (must be running)
echo   - cross-rs (install via scripts\setup-agent-cross.cmd)
echo.
echo Prerequisites (--native Windows mode):
echo   - Rust toolchain (rustup)
echo   - MSVC toolchain (Visual Studio Build Tools); ARM64 tools for aarch64
echo.
echo Examples:
echo   scripts\build-agents.cmd                                  (all Linux targets)
echo   scripts\build-agents.cmd --targets aarch64-unknown-linux-musl
echo   scripts\build-agents.cmd --native --dev                   (Windows agents, fast)
echo   scripts\build-agents.cmd --native --targets x86_64-pc-windows-msvc --features test-hooks
exit /b 0

REM ------------------------------------------------------------------ REM
REM Validation + profile/feature setup                                    REM
REM ------------------------------------------------------------------ REM
:after_parse
if "%DEV%"=="1" (
    set "PROFILE_FLAG="
    set "PROFILE_DIR=debug"
) else (
    set "PROFILE_FLAG=--release"
    set "PROFILE_DIR=release"
)

REM Rendered into each build command as `--features <list>` (empty when unset).
set "FEATURES_FLAG="
if defined FEATURES set "FEATURES_FLAG=--features %FEATURES%"

REM --sign-key: fail fast (before any build) if signing cannot possibly work.
REM The signing pipeline is scripts/internal/agent-update-signing.sh (bash +
REM OpenSSL 3), the one release.yml uses; Git Bash provides both on Windows.
if defined SIGN_KEY (
    if not exist "%SIGN_KEY%" (
        echo ERROR: --sign-key file not found: %SIGN_KEY%
        exit /b 1
    )
    where bash >nul 2>&1
    if errorlevel 1 (
        echo ERROR: --sign-key needs bash + OpenSSL 3 to run scripts/internal/agent-update-signing.sh.
        echo   Install Git for Windows, which provides Git Bash, and re-run.
        exit /b 1
    )
    set "SIGN_KEY_FWD=%SIGN_KEY:\=/%"
)

set BUILT=0
set FAILED=0
set "PRODUCED="

if "%NATIVE%"=="1" goto :native_start
goto :start

REM ------------------------------------------------------------------ REM
REM Native build (cargo, no cross-rs / container runtime)                 REM
REM ------------------------------------------------------------------ REM
:native_start
echo === Building agent natively with cargo (%PROFILE_DIR%) ===
echo.

REM Default targets: x64 is required; arm64 is best effort (warns instead of
REM failing if the ARM64 MSVC build tools are not installed).
if defined TARGETS (
    for %%T in (%TARGETS%) do call :build_one %%T native required
) else (
    call :build_one x86_64-pc-windows-msvc native required
    call :build_one aarch64-pc-windows-msvc native besteffort
)
goto :finish

REM ------------------------------------------------------------------ REM
REM Linux cross-rs build                                                  REM
REM ------------------------------------------------------------------ REM
:start
if not defined TARGETS set "TARGETS=x86_64-unknown-linux-musl,aarch64-unknown-linux-musl,armv7-unknown-linux-musleabihf"

REM MSVC targets cannot be built via cross-rs (no MSVC ABI support). Fail fast
REM with a clear message instead of a confusing linker error.
for %%T in (%TARGETS%) do (
    set "VT=%%T"
    if not "!VT:-pc-windows-msvc=!"=="!VT!" (
        echo ERROR: Windows target '%%T' requires --native.
        echo   cross-rs cannot build MSVC targets. Re-run with --native.
        exit /b 1
    )
)

echo === Building agent via cross-rs (%PROFILE_DIR%): %TARGETS% ===
echo.

REM Verify cross-rs
where cross >nul 2>&1
if errorlevel 1 (
    echo ERROR: cross-rs not found. Run scripts\setup-agent-cross.cmd first.
    exit /b 1
)

REM Verify container runtime (Docker or Podman)
docker info >nul 2>&1
if not errorlevel 1 goto :runtime_ok
podman info >nul 2>&1
if not errorlevel 1 (
    set CROSS_CONTAINER_ENGINE=podman
    REM Podman is rootless by default; cross-rs adds --user UID:GID which causes
    REM the injected cargo/rustc toolchain to be non-executable inside the container.
    REM Disable rootless handling so the container runs as root and can execute them.
    set CROSS_ROOTLESS_CONTAINER_ENGINE=false
    echo Using Podman as container runtime ^(CROSS_CONTAINER_ENGINE=podman^)
    goto :runtime_ok
)
echo ERROR: No container runtime found. Start Docker Desktop or Podman Desktop and try again.
exit /b 1
:runtime_ok

REM On Windows with Podman, cross-rs tries to bind-mount the workspace as
REM /mnt/c/... inside the container, but Podman (WSL2) cannot statfs those paths.
REM CROSS_REMOTE=1 makes cross copy the workspace into a named volume instead,
REM avoiding the "statfs: input/output error" failure.
REM
REM Custom images (localhost/termihub-cross:<target>) must be built first by
REM running scripts\setup-agent-cross.cmd — they are used via Cross.toml's
REM `image` directive, so cross-rs never needs to build images at compile time.
if defined CROSS_CONTAINER_ENGINE (
    set CROSS_REMOTE=1
    echo Using remote volume mode ^(CROSS_REMOTE=1^) to avoid Windows path mount issues
    echo.
    REM CROSS_REMOTE=1 copies the workspace to a Windows temp directory, then
    REM podman-copies it to the container.  cross-rs uses copy_dir() which
    REM recursively follows Windows junction points (they appear as directories),
    REM causing an infinite hang when it enters node_modules\.pnpm.
    REM
    REM cross-rs respects the CACHEDIR spec (bford.info/cachedir/): any directory
    REM containing a CACHEDIR.TAG file with the required signature is skipped.
    REM Create that marker in node_modules (and dist if present) so the copy
    REM finishes quickly without touching junction-point-laden directories.
    REM target\ is already tagged by cargo; no action needed there.
    if exist node_modules (
        echo Signature: 8a477f597d28d172789f06886806bc55>node_modules\CACHEDIR.TAG
        echo   Marked node_modules\ as cache directory to skip junction-point traversal
    )
    if exist dist (
        echo Signature: 8a477f597d28d172789f06886806bc55>dist\CACHEDIR.TAG
        echo   Marked dist\ as cache directory ^(frontend artifacts not needed for agent build^)
    )
    echo.
    REM Windows reserved device names (NUL, CON, PRN, AUX, COMn, LPTn) that
    REM sometimes appear as real files (e.g. from Git Bash output redirections)
    REM cannot be opened for reading by cross-rs and cause error 87.  Remove any
    REM such files now so the workspace copy succeeds.
    REM Note: `bash -c` may resolve to WSL bash, which cannot chdir to Windows
    REM paths (/mnt/c/...) and would run in the wrong directory, silently skipping
    REM the deletion.  Pass the project dir via an env var using Windows-style
    REM forward-slash path so bash can cd there explicitly.  Git Bash accepts
    REM "C:/path" style; WSL bash will fail the cd gracefully and skip deletion
    REM (correct — WSL does not see the Windows NUL file).
    REM Redirect stderr of the entire bash invocation to nul so WSL relay
    REM diagnostic messages (e.g. "chdir failed") are not shown to the user;
    REM the echo statements inside the script go to stdout and remain visible.
    set "_CROSS_WORKDIR=%CD:\=/%"
    bash -c "cd \"$_CROSS_WORKDIR\" 2>/dev/null; for f in NUL CON PRN AUX COM1 COM2 COM3 COM4 COM5 COM6 COM7 COM8 COM9 LPT1 LPT2 LPT3 LPT4 LPT5 LPT6 LPT7 LPT8 LPT9; do [ -f \"$f\" ] && rm -f \"$f\" && echo \"  Removed stray Windows device file: $f\"; done 2>/dev/null || true" 2>nul
    set "_CROSS_WORKDIR="
)

REM Point cross-rs at the agent-specific Cross.toml so pre-build hooks
REM (libudev-dev installation) are applied for each target.
set CROSS_CONFIG=agent\Cross.toml

REM Prune stopped containers from any previous failed builds so they do not
REM consume memory in Podman Machine and cause subsequent targets to be OOM-killed.
if defined CROSS_CONTAINER_ENGINE (
    podman container prune -f >nul 2>&1
)


for %%T in (%TARGETS%) do call :build_one %%T cross required
goto :finish

REM ------------------------------------------------------------------ REM
REM Checksum sidecar gate (WA-CI-036) + summary                           REM
REM ------------------------------------------------------------------ REM
:finish
REM Every binary reported as built must carry a non-empty .sha256 sidecar.
set "MISSING=0"
if defined PRODUCED (
    for %%B in (%PRODUCED%) do (
        call :sidecar_nonempty "%%B.sha256"
        if errorlevel 1 (
            echo   ERROR: %%B has no checksum sidecar, expected %%B.sha256
            set /a MISSING+=1
        )
    )
)
if %MISSING% gtr 0 (
    echo   FAIL  %MISSING% built binaries missing a .sha256 sidecar
    set /a FAILED+=MISSING
)

echo.
echo === Summary ===
echo Built: %BUILT% ^| Failed: %FAILED%

if %FAILED% gtr 0 exit /b 1
exit /b 0

REM ------------------------------------------------------------------ REM
REM Subroutines                                                           REM
REM ------------------------------------------------------------------ REM

REM Build one target, then checksum (+ optionally sign) its binary.
REM   %1 = target triple, %2 = native or cross, %3 = required or besteffort
:build_one
set "BT=%~1"
echo --- %BT% ---

REM Ensure the Rust std for the target is installed
rustup target add %BT% >nul 2>&1

set "BUILD_RC=0"
if "%~2"=="native" (
    echo   Building with cargo, native...
    cargo build %PROFILE_FLAG% %FEATURES_FLAG% --target %BT% -p termihub-agent
    set "BUILD_RC=!errorlevel!"
) else (
    echo   Building with cross-rs...
    cross build %PROFILE_FLAG% %FEATURES_FLAG% --target %BT% -p termihub-agent
    set "BUILD_RC=!errorlevel!"
)
if not "%BUILD_RC%"=="0" (
    if "%~3"=="besteffort" (
        echo   WARNING: %BT% build failed, best effort - skipping. Install the ARM64 MSVC build tools to enable it.
        exit /b 0
    )
    echo   FAILED: %BT%
    set /a FAILED+=1
    REM Prune stopped containers so the failed build does not leave containers that
    REM consume Podman Machine memory and cause the next target to be OOM-killed.
    if "%~2"=="cross" if defined CROSS_CONTAINER_ENGINE podman container prune -f >nul 2>&1
    exit /b 0
)

REM Binary file name cargo emits for the target (Windows appends .exe).
set "BIN_NAME=termihub-agent"
if not "%BT:-pc-windows-msvc=%"=="%BT%" set "BIN_NAME=termihub-agent.exe"
set "BIN=target\%BT%\%PROFILE_DIR%\%BIN_NAME%"

if not exist "%BIN%" (
    echo   FAILED: binary not found at %BIN%
    set /a FAILED+=1
    exit /b 0
)
call :write_checksum "%BIN%"
if errorlevel 1 (
    echo   FAILED: could not write %BIN%.sha256
    set /a FAILED+=1
    exit /b 0
)
call :write_signature "%BIN%"
if errorlevel 1 (
    echo   FAILED: could not sign %BIN%
    set /a FAILED+=1
    exit /b 0
)
set "PRODUCED=%PRODUCED% %BIN%"
echo   -^> %BIN%
set /a BUILT+=1
exit /b 0

REM Write "<binary>.sha256" next to a built binary: "<lowercase hex>  <file name>"
REM plus LF -- byte-identical to `sha256sum <name>` run in the binary's directory,
REM the format build-agents.sh writes and release.yml publishes (#1350). Uses
REM Windows PowerShell's Get-FileHash (built into every supported Windows; the
REM output is locale-independent, unlike certutil's). Returns non-zero -- and the
REM caller FAILS the target -- if hashing or the write fails or the sidecar is
REM empty: the sidecar feeds the update checksum and the .sig flow, so a
REM silently missing one must never pass as a successful build.
REM   %1 = binary path
:write_checksum
if exist "%~1.sha256" del /q "%~1.sha256"
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $p = (Resolve-Path -LiteralPath '%~1').Path; $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant(); [IO.File]::WriteAllText($p + '.sha256', $h + '  ' + [IO.Path]::GetFileName($p) + [char]10)"
if errorlevel 1 (
    echo   ERROR: could not compute SHA-256 of %~1
    exit /b 1
)
call :sidecar_nonempty "%~1.sha256"
exit /b %errorlevel%

REM Exit 0 if %1 exists and is non-empty, 1 otherwise.
:sidecar_nonempty
if not exist "%~1" exit /b 1
if %~z1 equ 0 exit /b 1
exit /b 0

REM Write (or clear) the "<binary>.sig" update-signature sidecar (AGT-005).
REM With --sign-key, sign via scripts/internal/agent-update-signing.sh -- the same
REM pipeline release.yml uses (the key must match agent\keys\update-signing.pub.pem).
REM Without it, remove any stale .sig so an old signature is never paired with
REM freshly built bytes.
REM   %1 = binary path
:write_signature
if not defined SIGN_KEY (
    if exist "%~1.sig" del /q "%~1.sig"
    exit /b 0
)
set "SIG_BIN=%~1"
set "SIG_BIN=%SIG_BIN:\=/%"
bash scripts/internal/agent-update-signing.sh sign --key "%SIGN_KEY_FWD%" "%SIG_BIN%"
if errorlevel 1 exit /b 1
exit /b 0
