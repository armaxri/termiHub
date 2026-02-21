@echo off
REM Cross-compile the remote agent (termihub-agent) for 6 Linux targets.
REM Uses cross-rs exclusively (no native Linux toolchains on Windows).
REM
REM Usage: scripts\build-agents.cmd [--help]
REM
REM Prerequisites: Rust, Docker Desktop (running), cross-rs
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
echo   - Docker Desktop (must be running)
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

REM Verify Docker
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not running. Start Docker Desktop and try again.
    exit /b 1
)

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
