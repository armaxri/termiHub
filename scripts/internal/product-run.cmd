@echo off
REM On-demand full product run (#5518) - Windows entry point.
REM Delegates to scripts\internal\product-run.sh via Git Bash or WSL, so the
REM runner, page server and summary logic live in a single place.
REM
REM Usage: scripts\internal\product-run.cmd [OPTIONS] [-- PYTEST ARGS]
REM
REM Options (same as product-run.sh):
REM   --config FILE    setup input (default: product-run.local.json at the repo root)
REM   --build          (re)build the test app first
REM   --no-open        do not open the progress page in the browser
REM   --unattended     nobody is watching: human steps become "not tested" at once
REM   --keep-serving   keep serving the progress page after the run until Ctrl-C
REM   --help, -h       Show the help message
REM
REM Prerequisites: Git for Windows (Git Bash) or WSL to provide bash; uv; the
REM test app (built on demand with --build).

cd /d "%~dp0\..\.."

where bash >nul 2>&1
if errorlevel 1 (
    echo ERROR: bash not found.
    echo.
    echo Install one of the following to provide bash on Windows:
    echo   - Git for Windows ^(includes Git Bash^): https://git-scm.com/download/win
    echo   - WSL: https://learn.microsoft.com/en-us/windows/wsl/install
    exit /b 1
)

bash scripts/internal/product-run.sh %*
exit /b %errorlevel%
