@echo off
REM Install toolchains and build custom cross-rs images needed to cross-compile
REM the remote agent for Linux targets (static musl binaries) on Windows.
REM Run once before using build-agents.cmd.
REM
REM Usage: scripts\setup-agent-cross.cmd [--help]
REM
REM Prerequisites: Rust toolchain (rustup), Docker Desktop or Podman Desktop

if "%~1"=="--help" goto :usage
if "%~1"=="-h" goto :usage
goto :start

:usage
echo Usage: setup-agent-cross.cmd
echo.
echo Installs the cross-compilation toolchains required by build-agents.cmd
echo and builds the custom cross-rs Docker images needed for each target.
echo.
echo Windows:
echo   - cross-rs (via cargo install) for all targets
echo   - Verifies Docker Desktop or Podman Desktop is available
echo   - Adds Rust targets for all architectures
echo   - Builds localhost/termihub-cross:^<target^> images with libudev-dev
echo.
echo Prerequisites:
echo   - Rust toolchain (rustup)
echo   - Docker Desktop or Podman Desktop (must be running)
exit /b 0

:start
cd /d "%~dp0\.."

echo === Agent Cross-Compilation Setup ===
echo.

echo --- Adding Rust targets ---
for %%T in (
    x86_64-unknown-linux-musl
    aarch64-unknown-linux-musl
    armv7-unknown-linux-musleabihf
) do (
    rustup target add %%T
)
echo.

echo --- Installing cross-rs ---
where cross >nul 2>&1
if %errorlevel% equ 0 (
    echo   cross is already installed.
) else (
    echo   Installing cross via cargo...
    cargo install cross --git https://github.com/cross-rs/cross
    if errorlevel 1 (
        echo   ERROR: Failed to install cross-rs.
        exit /b 1
    )
)
echo.

echo --- Checking container runtime ---
set CONTAINER_CMD=
docker info >nul 2>&1
if not errorlevel 1 (
    docker --version
    echo   Docker is running.
    set CONTAINER_CMD=docker
    goto :runtime_done
)
podman info >nul 2>&1
if not errorlevel 1 (
    podman --version
    echo   Podman is running.
    set CONTAINER_CMD=podman
    goto :runtime_done
)
echo   ERROR: Neither Docker nor Podman found or running.
echo   Install Docker Desktop: https://www.docker.com/products/docker-desktop/
echo   Or Podman Desktop: https://podman-desktop.io/
exit /b 1
:runtime_done
echo.

echo --- Building custom cross-rs images ---
echo   Images extend ghcr.io/cross-rs/^<target^>:main with libudev-dev for serialport.
echo.

set BUILD_FAILED=0

for %%T in (
    x86_64-unknown-linux-musl
    aarch64-unknown-linux-musl
    armv7-unknown-linux-musleabihf
) do (
    call :build_image %%T
)

if %BUILD_FAILED% gtr 0 (
    echo.
    echo ERROR: Some images failed to build. Resolve the errors above and retry.
    exit /b 1
)

echo.
echo === Setup complete ===
echo Run scripts\build-agents.cmd to cross-compile the agent.
exit /b 0

REM -----------------------------------------------------------------------
:build_image
echo   localhost/termihub-cross:%1 ...

if "%CONTAINER_CMD%"=="podman" (
    REM Podman on Windows: build inside Podman Machine via SSH so the Dockerfile
    REM is read from stdin — avoids "faccessat /mnt/c/..." errors that occur when
    REM Podman Machine (WSL2) tries to access Windows build contexts.
    type "agent\docker\Dockerfile.%1" | podman machine ssh -- "cat > /tmp/termihub-cross-dockerfile && podman build -f /tmp/termihub-cross-dockerfile -t localhost/termihub-cross:%1 . && rm -f /tmp/termihub-cross-dockerfile"
) else (
    REM Docker Desktop on Windows handles Windows paths correctly.
    docker build -t localhost/termihub-cross:%1 -f "agent\docker\Dockerfile.%1" "agent\docker"
)

if errorlevel 1 (
    echo   FAILED: localhost/termihub-cross:%1
    set /a BUILD_FAILED+=1
) else (
    echo   OK: localhost/termihub-cross:%1
)
echo.
exit /b 0
