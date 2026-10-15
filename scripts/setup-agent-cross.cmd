@echo off
REM Install toolchains and build custom cross-rs images needed to cross-compile
REM the remote agent for Linux targets (static musl binaries) on Windows.
REM Run once before using build-agents.cmd.
REM
REM Not needed for the native Windows agent: build-agents.cmd --native builds the
REM *-pc-windows-msvc target with cargo and only needs the MSVC build tools
REM (Visual Studio Build Tools) - no cross-rs / container runtime required.
REM
REM cross-rs is installed at the ONE version pinned in .github\cross-version, the
REM same release CI installs through .github/actions/setup-cross (#4360, #4731).
REM The pinned SHA256 covers only the x86_64 Linux release tarball, so Windows
REM builds the same tag from source:
REM   cargo install cross --locked --git ... --tag vX.Y.Z
REM
REM Usage: scripts\setup-agent-cross.cmd [--dry-run] [--help]
REM
REM Prerequisites: Rust toolchain (rustup), Docker Desktop or Podman Desktop

setlocal EnableExtensions
set DRY_RUN=0
:parse_args
if "%~1"=="" goto :args_done
if "%~1"=="--help" goto :usage
if "%~1"=="-h" goto :usage
if "%~1"=="--dry-run" (
    set DRY_RUN=1
) else (
    echo Unknown argument: %~1 ^(see --help^) 1>&2
    exit /b 2
)
shift
goto :parse_args

:usage
echo Usage: setup-agent-cross.cmd [--dry-run]
echo.
echo Installs the cross-compilation toolchains required by build-agents.cmd
echo and builds the custom cross-rs Docker images needed for each target.
echo.
echo Not needed for the native Windows agent: build-agents.cmd --native builds
echo the *-pc-windows-msvc target with cargo and only needs the MSVC build tools.
echo.
echo Windows:
echo   - cross-rs at the version pinned in .github\cross-version ^(same as CI^),
echo     via cargo install cross --locked --git ... --tag v^<version^>
echo   - Verifies Docker Desktop or Podman Desktop is available
echo   - Adds Rust targets for all architectures
echo   - Builds localhost/termihub-cross:^<target^> images with libudev-dev
echo.
echo Options:
echo   --dry-run   Resolve the pinned cross-rs version, print how it would be
echo               installed, and exit without changing anything
echo.
echo Prerequisites:
echo   - Rust toolchain (rustup)
echo   - Docker Desktop or Podman Desktop (must be running)
exit /b 0

:args_done
cd /d "%~dp0\.."

REM --- Resolve the pinned cross-rs release (docs/contributing.md -> "cross-rs version") ---
set CROSS_PIN_FILE=.github\cross-version
set CROSS_GIT_URL=https://github.com/cross-rs/cross
set CROSS_VERSION=
if not exist "%CROSS_PIN_FILE%" (
    echo ERROR: cross-rs pin file not found: %CROSS_PIN_FILE% 1>&2
    exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%CROSS_PIN_FILE%") do (
    if "%%A"=="version" set "CROSS_VERSION=%%B"
)
echo %CROSS_VERSION%| findstr /r /x "[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" >nul
if errorlevel 1 (
    echo ERROR: missing or malformed cross-rs pin in %CROSS_PIN_FILE% 1>&2
    exit /b 1
)

REM The version of the cross on PATH ("cross 0.2.5 (...)" -> 0.2.5), or empty.
set INSTALLED_CROSS=
where cross >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=1,2" %%A in ('cross --version 2^>nul') do (
        if "%%A"=="cross" if not defined INSTALLED_CROSS set "INSTALLED_CROSS=%%B"
    )
)

if "%DRY_RUN%"=="1" (
    echo === Agent Cross-Compilation Setup ^(dry run^) ===
    echo   Pinned cross-rs: v%CROSS_VERSION% ^(from .github\cross-version^)
    if defined INSTALLED_CROSS (
        echo   Installed cross: %INSTALLED_CROSS%
    ) else (
        echo   Installed cross: none
    )
    echo   Install method:  cargo install cross --locked --git %CROSS_GIT_URL% --tag v%CROSS_VERSION%
    echo   Nothing was changed.
    exit /b 0
)

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
    echo   cross is already installed: v%INSTALLED_CROSS% ^(pinned: v%CROSS_VERSION%^)
    if not "%INSTALLED_CROSS%"=="%CROSS_VERSION%" (
        echo   WARNING: the installed cross differs from .github\cross-version, so local
        echo   agent builds may not match CI. Remove it ^(cargo uninstall cross^) and re-run.
    )
) else (
    echo   Building cross-rs v%CROSS_VERSION% from source via cargo...
    cargo install cross --locked --git %CROSS_GIT_URL% --tag v%CROSS_VERSION%
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
