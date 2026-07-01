@echo off
REM Run the termiHub Python system tests via uv.
REM
REM Thin wrapper around `uv run pytest` that runs from tests\system regardless of
REM where you call it, so you never manage the venv by hand. All arguments are
REM forwarded verbatim to `python -m pytest`:
REM
REM   pytest.cmd -m "not integration" -v
REM   pytest.cmd -m integration -k ssh -v -s
REM   pytest.cmd --collect-only -q
REM
REM On first run uv creates tests\system\.venv and installs the exact dependency
REM set pinned in uv.lock (`--frozen` = use the committed lock, never re-resolve).
REM After changing dependencies in pyproject.toml, run `uv lock` to refresh it.
REM
REM Pick a specific base interpreter with `set UV_PYTHON=3.12` (or a full path);
REM the legacy `set PYTHON=py` override is honored for compatibility.
setlocal
cd /d "%~dp0"

where uv >nul 2>nul || (
    echo error: 'uv' not found on PATH. 1>&2
    echo   Install it from https://docs.astral.sh/uv/ ^(e.g. via the Windows installer at that page^). 1>&2
    exit /b 1
)

REM Backward-compat: map the old PYTHON override onto uv's UV_PYTHON.
if not "%PYTHON%"=="" if "%UV_PYTHON%"=="" set "UV_PYTHON=%PYTHON%"

uv run --frozen pytest %*
