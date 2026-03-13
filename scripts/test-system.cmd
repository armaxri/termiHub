@echo off
REM System test orchestration for Windows.
REM Delegates to scripts\test-system-windows.sh via Git Bash or WSL.
REM
REM Usage: scripts\test-system.cmd [OPTIONS]
REM
REM Options:
REM   --skip-build    Skip cargo/pnpm build steps
REM   --skip-unit     Skip unit tests (integration only)
REM   --skip-serial   No-op on Windows (serial ports not available; accepted for
REM                   compatibility with cross-platform invocations)
REM   --skip-e2e      Skip E2E tests
REM   --with-fault    Include network fault injection tests (profile: fault)
REM   --with-stress   Include SFTP stress tests (profile: stress)
REM   --with-all      Include all profiles (fault + stress)
REM   --keep-infra    Keep Docker/Podman containers running after tests
REM   --help, -h      Show this help message

if "%~1"=="--help" goto :usage
if "%~1"=="-h" goto :usage
goto :start

:usage
echo Usage: scripts\test-system.cmd [OPTIONS]
echo.
echo Run system-level tests with container infrastructure (SSH, Telnet).
echo Delegates to scripts\test-system-windows.sh via Git Bash or WSL.
echo.
echo Options:
echo   --skip-build    Skip cargo/pnpm build steps
echo   --skip-unit     Skip unit tests (integration only)
echo   --skip-serial   No-op on Windows (serial ports not available)
echo   --skip-e2e      Skip E2E tests
echo   --with-fault    Include network fault injection tests
echo   --with-stress   Include SFTP stress tests
echo   --with-all      Include all profiles (fault + stress)
echo   --keep-infra    Keep containers running after tests
echo   --help, -h      Show this help message
echo.
echo Prerequisites:
echo   - Git for Windows (Git Bash): https://git-scm.com/download/win
echo     OR WSL: https://learn.microsoft.com/en-us/windows/wsl/install
echo   - Docker Desktop or Podman Desktop (must be running)
echo   - Rust toolchain (rustup): https://rustup.rs/
echo   - pnpm: npm install -g pnpm
exit /b 0

:start
cd /d "%~dp0\.."

REM Detect bash (Git Bash, WSL, or MSYS2)
where bash >nul 2>&1
if errorlevel 1 (
    echo ERROR: bash not found.
    echo.
    echo Install one of the following to provide bash on Windows:
    echo   - Git for Windows ^(includes Git Bash^): https://git-scm.com/download/win
    echo   - WSL: https://learn.microsoft.com/en-us/windows/wsl/install
    echo   - MSYS2: https://www.msys2.org/
    exit /b 1
)

bash scripts/test-system-windows.sh %*
exit /b %errorlevel%
