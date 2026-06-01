@echo off
REM Build the remote agent (termihub-agent) for Linux and Windows targets.
REM
REM Default mode cross-compiles the Linux musl targets via cross-rs.
REM --native builds the Windows MSVC targets natively with cargo:
REM   - x86_64-pc-windows-msvc (required)  -> termihub-agent.exe
REM   - aarch64-pc-windows-msvc (best effort, needs the ARM64 MSVC build tools)
REM cross-rs cannot build the MSVC ABI, so Windows agents must be built natively
REM on a Windows host with the MSVC toolchain (Visual Studio Build Tools).
REM
REM Usage: scripts\build-agents.cmd [--native] [--help]
REM
REM Prerequisites (default Linux mode): Rust, Docker/Podman (running), cross-rs.
REM Run scripts\setup-agent-cross.cmd first to install required toolchains.
REM Prerequisites (--native Windows mode): Rust + MSVC toolchain only.

if "%~1"=="--help" goto :usage
if "%~1"=="-h" goto :usage
if "%~1"=="--native" goto :native_start
goto :start

:usage
echo Usage: build-agents.cmd [--native]
echo.
echo Default: cross-compile the agent for Linux targets via cross-rs (static musl).
echo --native: build the Windows MSVC agent (.exe) natively with cargo.
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
exit /b 0

REM ------------------------------------------------------------------ REM
REM Native Windows MSVC build (cargo, no cross-rs / container runtime)    REM
REM ------------------------------------------------------------------ REM
:native_start
cd /d "%~dp0\.."

echo === Building Windows agent natively (MSVC) ===
echo.

set BUILT=0
set FAILED=0

REM x64 is required; arm64 is best effort (warns instead of failing if the
REM ARM64 MSVC build tools are not installed).
call :build_native x86_64-pc-windows-msvc required
call :build_native aarch64-pc-windows-msvc besteffort

echo.
echo === Summary ===
echo Built: %BUILT%  Failed: %FAILED%

if %FAILED% gtr 0 exit /b 1
exit /b 0

:build_native
echo --- %1 ---

REM Ensure the Rust std for the target is installed
rustup target add %1 >nul 2>&1

echo   Building with cargo (native)...
cargo build --release --target %1 -p termihub-agent
if errorlevel 1 (
    if "%2"=="besteffort" (
        echo   WARNING: %1 build failed ^(best effort^) - skipping. Install the ARM64 MSVC build tools to enable it.
        exit /b 0
    )
    echo   FAILED: %1
    set /a FAILED+=1
    exit /b 0
)

echo   -^> target\%1\release\termihub-agent.exe
set /a BUILT+=1
exit /b 0

:start
cd /d "%~dp0\.."

echo === Building agent for 3 Linux targets ===
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

set BUILT=0
set FAILED=0

for %%T in (
    x86_64-unknown-linux-musl
    aarch64-unknown-linux-musl
    armv7-unknown-linux-musleabihf
) do (
    call :build_target %%T
)

echo.
echo === Summary ===
echo Built: %BUILT%  Failed: %FAILED%

if %FAILED% gtr 0 exit /b 1
exit /b 0

:build_target
echo --- %1 ---

REM Ensure Rust target is installed
rustup target add %1 >nul 2>&1

echo   Building with cross-rs...
cross build --release --target %1 -p termihub-agent
if errorlevel 1 (
    echo   FAILED: %1
    set /a FAILED+=1
    REM Prune stopped containers so the failed build does not leave containers that
    REM consume Podman Machine memory and cause the next target to be OOM-killed.
    if defined CROSS_CONTAINER_ENGINE (
        podman container prune -f >nul 2>&1
    )
    exit /b 0
)

echo   -^> target\%1\release\termihub-agent
set /a BUILT+=1
exit /b 0
