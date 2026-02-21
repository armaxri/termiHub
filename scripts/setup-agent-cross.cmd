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
echo   - Verifies Docker Desktop is available
echo   - Adds Rust targets for all 6 architectures
echo.
echo Prerequisites:
echo   - Rust toolchain (rustup)
echo   - Docker Desktop (must be running)
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

echo --- Checking Docker Desktop ---
where docker >nul 2>&1
if %errorlevel% equ 0 (
    docker --version
    docker info >nul 2>&1
    if errorlevel 1 (
        echo   WARNING: Docker daemon is not running. Start Docker Desktop before building.
    ) else (
        echo   Docker is running.
    )
) else (
    echo   ERROR: Docker not found. cross-rs requires Docker Desktop on Windows.
    echo   Install Docker Desktop: https://www.docker.com/products/docker-desktop/
    exit /b 1
)

echo.
echo === Setup complete ===
echo Run scripts\build-agents.cmd to cross-compile the agent.
