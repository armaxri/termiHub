@echo off
REM Start the app in development mode with hot-reload.
REM Run from the repo root: scripts\dev.cmd [PORT]
REM
REM All per-checkout settings live in dev.local.json (gitignored):
REM   { "dev_port": 1422 }
REM
REM Port resolution order (first match wins):
REM   1. CLI argument:      scripts\dev.cmd 1422
REM   2. dev.local.json     { "dev_port": 1422 }
REM   3. dev.local (legacy) echo 1422 > dev.local
REM   4. Default:           1420
REM
REM Dev agent (dev_agent_port in dev.local.json): not supported on Windows.
REM
REM Multiple instances can run in parallel by using different ports.

cd /d "%~dp0\.."

REM Resolve dev port (dev.local.json wins over legacy dev.local)
set DEV_PORT=1420
if not "%~1"=="" (
    set DEV_PORT=%~1
) else if exist dev.local.json (
    for /f "tokens=2 delims=:, " %%a in ('findstr /r "dev_port" dev.local.json') do (
        set _CONF_PORT=%%~a
    )
    if defined _CONF_PORT (
        set DEV_PORT=%_CONF_PORT%
    )
) else if exist dev.local (
    set /p DEV_PORT=<dev.local
)

if not exist node_modules (
    echo node_modules missing, running pnpm install...
    call pnpm install
    if errorlevel 1 exit /b 1
    echo.
)

REM Kill any process occupying the Vite dev server port (leftover from a previous run)
node scripts\internal\kill-port.cjs %DEV_PORT%

echo Starting termiHub in dev mode (port %DEV_PORT%)...
set TERMIHUB_DEV_PORT=%DEV_PORT%
call pnpm tauri dev --config "{\"build\":{\"devUrl\":\"http://localhost:%DEV_PORT%\"}}"
