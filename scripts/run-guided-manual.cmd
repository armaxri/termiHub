@echo off
REM Starter for the guided-manual system-test suite (issue #957) — Windows.
REM
REM Mirrors run-guided-manual.sh: builds if stale, brings up the SSH Docker
REM fixtures, runs the suite in --manual mode, and tees the full transcript to a
REM gitignored log (tests\reports\manual-run.log) for later review.
REM
REM The X11-forwarding test skips on Windows (macOS/Linux feature), so there is
REM no DISPLAY to resolve here.
REM
REM Usage (run from anywhere in the repo):
REM   scripts\run-guided-manual.cmd
REM   scripts\run-guided-manual.cmd -k test_terminal_clipboard_copy_paste
REM
REM Any arguments are forwarded to pytest; with none, the external-app suite is
REM selected (-k external_app). --manual and -s are always added.
REM
REM Note: the tee uses PowerShell's Tee-Object (cmd has no native tee). If the
REM interactive prompts misbehave, run run-guided-manual.sh under Git Bash.
setlocal
pushd "%~dp0\.." >nul

set "LOGDIR=tests\reports"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOGFILE=%LOGDIR%\manual-run.log"

set "SELECT=%*"
if "%SELECT%"=="" set "SELECT=-k external_app"

echo [setup] capturing full output to %LOGFILE%
echo.

set "PYTHONUNBUFFERED=1"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& '%~dp0test-system-py.cmd' --manual -s -rs %SELECT% 2>&1 | Tee-Object -FilePath '%LOGFILE%'"
set "STATUS=%ERRORLEVEL%"

echo.
echo [done] exit=%STATUS% . full transcript: %LOGFILE%
popd >nul
exit /b %STATUS%
