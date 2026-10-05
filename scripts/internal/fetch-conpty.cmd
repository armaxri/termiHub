@echo off
REM Fetch and stage the sideloaded ConPTY host for the Windows bundle (#4121).
REM Windows twin of scripts/internal/fetch-conpty.sh: same pins
REM (src-tauri/packaging/windows/conpty.env), same checks. The download, the
REM SHA-256 checks and the extraction live in fetch-conpty.ps1; this wrapper
REM parses the same flags as the .sh and hands them over.
REM
REM Usage: scripts\internal\fetch-conpty.cmd [--arch x64^|arm64] [--dest DIR]
REM   --arch   Host architecture of the files (default: x64).
REM   --dest   Where to stage conpty.dll + OpenConsole.exe
REM            (default: src-tauri\binaries\conpty, gitignored).
setlocal

set "ARCH=x64"
set "DEST="

:parse
if "%~1"=="" goto run
if "%~1"=="--help" goto help
if "%~1"=="-h" goto help
if "%~1"=="--arch" (
    if "%~2"=="" (echo --arch needs a value 1>&2& exit /b 1)
    set "ARCH=%~2"
    shift
    shift
    goto parse
)
if "%~1"=="--dest" (
    if "%~2"=="" (echo --dest needs a value 1>&2& exit /b 1)
    set "DEST=%~2"
    shift
    shift
    goto parse
)
echo Unknown argument: %~1 (see --help) 1>&2
exit /b 1

:help
echo Fetch and stage the sideloaded ConPTY host for the Windows bundle (#4121).
echo.
echo Usage: scripts\internal\fetch-conpty.cmd [--arch x64^|arm64] [--dest DIR]
echo   --arch   Host architecture of the files (default: x64).
echo   --dest   Where to stage conpty.dll + OpenConsole.exe
echo            (default: src-tauri\binaries\conpty, gitignored).
exit /b 0

:run
if /i not "%ARCH%"=="x64" if /i not "%ARCH%"=="arm64" (
    echo Unsupported --arch '%ARCH%' ^(expected x64 or arm64^) 1>&2
    exit /b 1
)
REM Launched from pwsh, powershell.exe would inherit pwsh's PSModulePath and
REM fail to autoload cmdlets (#4029); unset, Windows PowerShell rebuilds its
REM own default. setlocal scopes this.
set "PSModulePath="
if defined DEST (
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fetch-conpty.ps1" -Arch "%ARCH%" -Dest "%DEST%"
) else (
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fetch-conpty.ps1" -Arch "%ARCH%"
)
exit /b %ERRORLEVEL%
