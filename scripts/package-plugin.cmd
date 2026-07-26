@echo off
REM Package a plugin source directory into a validated `.termihub-plugin` archive.
REM
REM The manifest validation, zipping (concept §1 layout) and round-trip
REM validation are done by the `termihub-plugin-pack` binary in termihub-core.
REM This wrapper adds the backend-crate build: if the source has a Cargo.toml, it
REM builds the cdylib in --release, stages the DLL into a temp backend\ directory
REM next to the manifest, and packages that staged tree.
REM
REM Usage: scripts\package-plugin.cmd <plugin-source-dir> [--out <dir>] [--no-build]
REM   <plugin-source-dir>   Directory containing manifest.json (required).
REM   --out <dir>           Output directory for the package (default: dist).
REM   --no-build            Do not build a backend crate; package the tree as-is.
REM
REM See docs\plugin-authoring.md for the manifest schema and the ABI caveat.
setlocal enabledelayedexpansion
cd /d "%~dp0\.."
set "ROOT=%CD%"

set "SOURCE="
set "OUT_DIR=dist"
set "BUILD=1"

:parse
if "%~1"=="" goto after_parse
if "%~1"=="--out" (
    set "OUT_DIR=%~2"
    shift
    shift
    goto parse
)
if "%~1"=="--no-build" (
    set "BUILD=0"
    shift
    goto parse
)
if "%~1"=="--help" goto usage
if "%~1"=="-h" goto usage
set "ARG=%~1"
if "!ARG:~0,1!"=="-" (
    echo Unknown argument: %~1 1>&2
    exit /b 2
)
if defined SOURCE (
    echo Unexpected extra argument: %~1 1>&2
    exit /b 2
)
set "SOURCE=%~1"
shift
goto parse
:after_parse

if not defined SOURCE (
    echo ERROR: no plugin source directory given 1>&2
    goto usage
)
if not exist "%SOURCE%\manifest.json" (
    echo ERROR: %SOURCE% has no manifest.json 1>&2
    exit /b 1
)

set "STAGE=%SOURCE%"
set "TMPSTAGE="

if "%BUILD%"=="1" if exist "%SOURCE%\Cargo.toml" (
    echo === Building backend crate (%SOURCE%) ===
    cargo build --release --manifest-path "%SOURCE%\Cargo.toml"
    if errorlevel 1 exit /b 1

    REM Predict the cdylib name from the crate's [lib]/[package] name.
    set "LIB_NAME="
    for /f "tokens=2 delims== " %%n in ('findstr /r /c:"^[ ]*name[ ]*=" "%SOURCE%\Cargo.toml"') do (
        if not defined LIB_NAME set "LIB_NAME=%%~n"
    )
    set "LIB_BASE=!LIB_NAME:-=_!"
    set "DYLIB=!LIB_BASE!.dll"

    set "BUILT="
    if exist "%ROOT%\target\release\!DYLIB!" set "BUILT=%ROOT%\target\release\!DYLIB!"
    if not defined BUILT if exist "%SOURCE%\target\release\!DYLIB!" set "BUILT=%SOURCE%\target\release\!DYLIB!"
    if not defined BUILT (
        echo ERROR: built library !DYLIB! not found under target\release 1>&2
        exit /b 1
    )

    REM Stage a clean tree in a tempdir.
    set "TMPSTAGE=%TEMP%\termihub-plugin-%RANDOM%%RANDOM%"
    set "STAGE=!TMPSTAGE!"
    mkdir "!STAGE!"
    copy /y "%SOURCE%\manifest.json" "!STAGE!\" >nul
    if exist "%SOURCE%\README.md" copy /y "%SOURCE%\README.md" "!STAGE!\" >nul
    if exist "%SOURCE%\themes" xcopy /e /i /q "%SOURCE%\themes" "!STAGE!\themes" >nul
    if exist "%SOURCE%\frontend" xcopy /e /i /q "%SOURCE%\frontend" "!STAGE!\frontend" >nul
    mkdir "!STAGE!\backend"
    copy /y "!BUILT!" "!STAGE!\backend\!DYLIB!" >nul
    echo Staged backend library: backend\!DYLIB!
)

echo === Packaging ===
cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-pack -- --source "!STAGE!" --out "%OUT_DIR%"
set "RC=!errorlevel!"

if defined TMPSTAGE rmdir /s /q "!TMPSTAGE!"
endlocal & exit /b %RC%

:usage
echo Usage: scripts\package-plugin.cmd ^<plugin-source-dir^> [--out ^<dir^>] [--no-build] 1>&2
exit /b 2
