@echo off
REM Run the termiHub Python system tests, creating the venv on first use.
REM
REM Wraps the harness virtualenv so you never type the .venv path. All arguments
REM are forwarded verbatim to `python -m pytest`:
REM
REM   pytest.cmd -m "not integration" -v
REM   pytest.cmd -m integration -k ssh -v -s
REM   pytest.cmd --collect-only -q
REM
REM On first run it creates tests\system\.venv and installs requirements.txt;
REM afterwards it just forwards to the existing venv. Override the base
REM interpreter with `set PYTHON=py` (or a full path).
setlocal
cd /d "%~dp0"

if "%PYTHON%"=="" set "PYTHON=python"
set "VENV_PYTHON=.venv\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
    where "%PYTHON%" >nul 2>nul || (
        echo error: '%PYTHON%' not found on PATH ^(set PYTHON=... to override^) 1>&2
        exit /b 1
    )
    echo Creating Python virtualenv in %~dp0.venv ...
    "%PYTHON%" -m venv .venv || exit /b 1
    "%VENV_PYTHON%" -m pip install --quiet --upgrade pip || exit /b 1
    "%VENV_PYTHON%" -m pip install --quiet -r requirements.txt || exit /b 1
    echo virtualenv ready.
)

"%VENV_PYTHON%" -m pytest %*
