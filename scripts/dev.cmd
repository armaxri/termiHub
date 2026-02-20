@echo off
REM Start the app in development mode with hot-reload.
REM Run from the repo root: scripts\dev.cmd

cd /d "%~dp0\.."

if not exist node_modules (
    echo node_modules missing, running pnpm install...
    call pnpm install
    if errorlevel 1 exit /b 1
    echo.
)

REM Kill any process listening on the Vite dev server port (leftover from a previous run).
REM Uses a subroutine to check the LOCAL address column only — avoids false matches
REM on the foreign address (e.g. TIME_WAIT connections TO port 1420).
set DEV_PORT=1420
for /f "tokens=2,5" %%a in ('netstat -ano ^| findstr ":%DEV_PORT% "') do call :TryKillPort %%a %%b
goto :DoneKillPort

:TryKillPort
REM %1 = local address (e.g. 0.0.0.0:1420), %2 = PID
echo %1 | findstr /E ":%DEV_PORT%" >nul 2>&1 || goto :eof
if "%2"=="0" goto :eof
echo Port %DEV_PORT% in use ^(PID %2^), killing...
taskkill /PID %2 /T /F >nul 2>&1
goto :eof

:DoneKillPort

echo Starting TermiHub in dev mode...
call pnpm tauri dev
