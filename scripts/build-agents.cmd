@echo off
REM Cross-compile the remote agent (termihub-agent) for 6 Linux targets.
REM Uses cross-rs exclusively (no native Linux toolchains on Windows).
REM
REM Usage: scripts\build-agents.cmd [--help]
REM
REM Prerequisites: Rust, Docker Desktop or Podman Desktop (running), cross-rs
REM Run scripts\setup-agent-cross.cmd first to install required toolchains.

if "%~1"=="--help" goto :usage
if "%~1"=="-h" goto :usage
goto :start

:usage
echo Usage: build-agents.cmd
echo.
echo Cross-compile the remote agent for 6 Linux targets using cross-rs.
echo.
echo Targets:
echo   x86_64-unknown-linux-gnu        Standard x64 servers (glibc)
echo   aarch64-unknown-linux-gnu       Raspberry Pi 3/4/5, ARM servers (glibc)
echo   armv7-unknown-linux-gnueabihf   Raspberry Pi 2, older ARM (glibc)
echo   x86_64-unknown-linux-musl       Static x64 binaries (musl)
echo   aarch64-unknown-linux-musl      Static ARM64 binaries (musl)
echo   armv7-unknown-linux-musleabihf  Static ARMv7 binaries (musl)
echo.
echo Prerequisites:
echo   - Rust toolchain (rustup)
echo   - Docker Desktop or Podman Desktop (must be running)
echo   - cross-rs (install via scripts\setup-agent-cross.cmd)
exit /b 0

:start
cd /d "%~dp0\.."

echo === Building agent for 6 Linux targets ===
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
    bash -c "for f in NUL CON PRN AUX COM1 COM2 COM3 COM4 COM5 COM6 COM7 COM8 COM9 LPT1 LPT2 LPT3 LPT4 LPT5 LPT6 LPT7 LPT8 LPT9; do [ -f \"$f\" ] && rm -f \"$f\" && echo \"  Removed stray Windows device file: $f\"; done 2>/dev/null || true"
)

REM Point cross-rs at the agent-specific Cross.toml so pre-build hooks
REM (libudev-dev installation) are applied for each target.
set CROSS_CONFIG=agent\Cross.toml

set BUILT=0
set FAILED=0

for %%T in (
    x86_64-unknown-linux-gnu
    aarch64-unknown-linux-gnu
    armv7-unknown-linux-gnueabihf
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
    exit /b 0
)

echo   -^> target\%1\release\termihub-agent
set /a BUILT+=1
exit /b 0
