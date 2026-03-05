@echo off
REM Install toolchains needed to cross-compile the remote agent for 6 Linux
REM targets on Windows. Run once before using build-agents.cmd.
REM
REM Usage: scripts\setup-agent-cross.cmd [--help]
REM
REM Prerequisites: Rust toolchain (rustup), Docker Desktop

if "%~1"=="--help" goto :usage
if "%~1"=="-h" goto :usage
goto :start

:usage
echo Usage: setup-agent-cross.cmd
echo.
echo Installs the cross-compilation toolchains required by build-agents.cmd.
echo.
echo Windows:
echo   - cross-rs (via cargo install) for all targets
echo   - Verifies Docker Desktop or Podman Desktop is available
echo   - Adds Rust targets for all 6 architectures
echo.
echo Prerequisites:
echo   - Rust toolchain (rustup)
echo   - Docker Desktop or Podman Desktop (must be running)
echo   - Set CROSS_CONTAINER_ENGINE=podman to use Podman with cross-rs
exit /b 0

:start
echo === Agent Cross-Compilation Setup ===
echo.

echo --- Adding Rust targets ---
for %%T in (
    x86_64-unknown-linux-gnu
    aarch64-unknown-linux-gnu
    armv7-unknown-linux-gnueabihf
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
where docker >nul 2>&1
if %errorlevel% equ 0 (
    docker --version
    docker info >nul 2>&1
    if errorlevel 1 (
        echo   WARNING: Docker daemon is not running. Start Docker Desktop before building.
    ) else (
        echo   Docker is running.
    )
    goto :runtime_done
)
where podman >nul 2>&1
if %errorlevel% equ 0 (
    podman --version
    podman info >nul 2>&1
    if errorlevel 1 (
        echo   WARNING: Podman daemon is not running. Start Podman Desktop before building.
    ) else (
        echo   Podman is running.
        echo   Set CROSS_CONTAINER_ENGINE=podman before running build-agents.cmd
    )
    goto :runtime_done
)
echo   ERROR: Neither Docker nor Podman found. cross-rs requires a container runtime on Windows.
echo   Install Docker Desktop: https://www.docker.com/products/docker-desktop/
echo   Or Podman Desktop: https://podman-desktop.io/
exit /b 1
:runtime_done

echo.
echo === Setup complete ===
echo Run scripts\build-agents.cmd to cross-compile the agent.
