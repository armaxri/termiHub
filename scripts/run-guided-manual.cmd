@echo off
REM Starter for the guided-manual system-test suite (issue #957) — Windows.
REM
REM Mirrors run-guided-manual.sh: loads the fixture ssh-agent key, builds if
REM stale, runs the suite in --manual mode, and tees the full transcript to a
REM gitignored log (tests\reports\manual-run.log). Docker (for the SSH fixtures)
REM is checked and a warning is printed if it is not up; start Docker Desktop
REM first if you want the SSH tests to run. The X11-forwarding test skips on
REM Windows, so there is no DISPLAY to resolve here.
REM
REM Usage (run from anywhere in the repo):
REM   scripts\run-guided-manual.cmd
REM   scripts\run-guided-manual.cmd -k test_terminal_clipboard_copy_paste
REM
REM Any arguments are forwarded to pytest; with none, the external-app suite is
REM selected (-k external_app). --manual, -s and -rs are always added.
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

REM Load the fixture ssh-agent key so the agent-auth test runs (best-effort).
ssh-add "tests\fixtures\ssh-keys\ed25519" >nul 2>&1 ^
  && echo [setup] ssh-agent key loaded. ^
  || echo [setup] WARNING: could not load the ssh key - agent-auth test will skip.

REM Warn if Docker is not up (SSH/SFTP fixtures need it).
docker info >nul 2>&1 ^
  && echo [setup] Docker is running. ^
  || echo [setup] WARNING: Docker is not running - start Docker Desktop for the SSH tests.

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
