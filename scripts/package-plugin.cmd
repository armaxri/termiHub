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
REM                                   [--target <triple>]... [--sign <key>]
REM        scripts\package-plugin.cmd --merge <pkg> --merge <pkg>... [--out <dir>] [--sign <key>]
REM   <plugin-source-dir>   Directory containing manifest.json (required unless --merge).
REM   --out <dir>           Output directory for the package (default: dist).
REM   --no-build            Do not build a backend crate; package the tree as-is.
REM   --target <triple>     Build the backend for this Rust target triple and stage
REM                         it as backend\<triple>\ (multi-platform format). Repeat
REM                         for several targets; `host` means this machine's triple.
REM   --merge <pkg>         Merge per-platform packages (each built with --target)
REM                         into one multi-platform package. Repeat per input.
REM   --sign <key-file>     After packaging, sign with a termihub-plugin-keygen key.
REM
REM See docs\plugin-authoring.md for the manifest schema, signing, and the ABI caveat.
setlocal enabledelayedexpansion
cd /d "%~dp0\.."
set "ROOT=%CD%"

set "SOURCE="
set "OUT_DIR=dist"
set "BUILD=1"
set "SIGN_KEY="
set "TARGETS="
set "MERGE_ARGS="
set "MERGE_COUNT=0"

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
if "%~1"=="--target" (
    if "%~2"=="" (
        echo --target requires a target triple ^(or 'host'^) 1>&2
        exit /b 2
    )
    set "TARGETS=!TARGETS! %~2"
    shift
    shift
    goto parse
)
if "%~1"=="--merge" (
    if "%~2"=="" (
        echo --merge requires a package path 1>&2
        exit /b 2
    )
    set "MERGE_ARGS=!MERGE_ARGS! --merge "%~2""
    set /a MERGE_COUNT+=1
    shift
    shift
    goto parse
)
if "%~1"=="--sign" (
    set "SIGN_KEY=%~2"
    shift
    shift
    goto parse
)
if "%~1"=="--help" goto help
if "%~1"=="-h" goto help
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

set "RC=0"
set "PKG_PATH="
set "TMPSTAGE="

REM --- Merge mode: combine per-platform packages into one fat package. ---
if not "%MERGE_COUNT%"=="0" (
    if defined SOURCE goto merge_conflict
    if defined TARGETS goto merge_conflict
    goto merge
)

if not defined SOURCE (
    echo ERROR: no plugin source directory given 1>&2
    goto usage
)
if not exist "%SOURCE%\manifest.json" (
    echo ERROR: %SOURCE% has no manifest.json 1>&2
    exit /b 1
)
if defined TARGETS (
    set "TARGET_OK=1"
    if "%BUILD%"=="0" set "TARGET_OK=0"
    if not exist "%SOURCE%\Cargo.toml" set "TARGET_OK=0"
    if "!TARGET_OK!"=="0" (
        echo ERROR: --target builds a backend crate; it needs a Cargo.toml and no --no-build 1>&2
        echo        ^(a pre-built backend\^<triple^>\ tree is packaged as-is with --no-build^) 1>&2
        exit /b 2
    )
)

set "STAGE=%SOURCE%"

if "%BUILD%"=="1" if exist "%SOURCE%\Cargo.toml" (
    REM Predict the cdylib name from the crate's [lib]/[package] name.
    set "LIB_NAME="
    for /f "tokens=2 delims== " %%n in ('findstr /r /c:"^[ ]*name[ ]*=" "%SOURCE%\Cargo.toml"') do (
        if not defined LIB_NAME set "LIB_NAME=%%~n"
    )
    set "LIB_BASE=!LIB_NAME:-=_!"

    REM Stage a clean tree in a tempdir.
    set "TMPSTAGE=%TEMP%\termihub-plugin-%RANDOM%%RANDOM%"
    set "STAGE=!TMPSTAGE!"
    mkdir "!STAGE!"
    copy /y "%SOURCE%\manifest.json" "!STAGE!\" >nul
    if exist "%SOURCE%\README.md" copy /y "%SOURCE%\README.md" "!STAGE!\" >nul
    if exist "%SOURCE%\themes" xcopy /e /i /q "%SOURCE%\themes" "!STAGE!\themes" >nul
    if exist "%SOURCE%\frontend" xcopy /e /i /q "%SOURCE%\frontend" "!STAGE!\frontend" >nul
    mkdir "!STAGE!\backend"

    if defined TARGETS (
        REM Multi-platform package: one backend\<triple>\ directory per target.
        REM The packer derives the manifest `libraries` map from this tree.
        for %%t in (!TARGETS!) do (
            call :build_target "%%t"
            if errorlevel 1 (
                set "RC=1"
                goto done
            )
        )
    ) else (
        REM Legacy single-platform package: this OS's DLL, flat in backend\.
        echo === Building backend crate (%SOURCE%^) ===
        cargo build --release --manifest-path "%SOURCE%\Cargo.toml"
        if errorlevel 1 (
            set "RC=1"
            goto done
        )
        set "DYLIB=!LIB_BASE!.dll"
        call :find_built "!DYLIB!" "release"
        if errorlevel 1 (
            set "RC=1"
            goto done
        )
        copy /y "!BUILT!" "!STAGE!\backend\!DYLIB!" >nul
        echo Staged backend library: backend\!DYLIB!
    )
)

echo === Packaging ===
REM Capture the packer's "Created <path>" line so we can sign the exact artifact.
for /f "tokens=1,* delims= " %%a in ('cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-pack -- --source "!STAGE!" --out "%OUT_DIR%"') do (
    echo %%a %%b
    if "%%a"=="Created" set "PKG_PATH=%%b"
)
if not defined PKG_PATH (
    set "RC=1"
    goto done
)
call :sign
set "RC=!errorlevel!"
goto done

:merge
echo === Merging %MERGE_COUNT% package(s) ===
for /f "tokens=1,* delims= " %%a in ('cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-pack -- !MERGE_ARGS! --out "%OUT_DIR%"') do (
    echo %%a %%b
    if "%%a"=="Created" set "PKG_PATH=%%b"
)
if not defined PKG_PATH (
    set "RC=1"
    goto done
)
cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-pack -- --inspect "!PKG_PATH!"
if errorlevel 1 (
    set "RC=1"
    goto done
)
call :sign
set "RC=!errorlevel!"
goto done

:merge_conflict
echo ERROR: --merge cannot be combined with a source directory or --target 1>&2
exit /b 2

:done
if defined TMPSTAGE rmdir /s /q "!TMPSTAGE!"
endlocal & exit /b %RC%

REM Build the crate for one target triple (%1; `host` = this machine) and stage
REM its library under backend\<triple>\.
:build_target
set "TRIPLE=%~1"
if /i "!TRIPLE!"=="host" (
    for /f "tokens=2" %%h in ('rustc -vV ^| findstr /b /c:"host:"') do set "TRIPLE=%%h"
)
echo === Building backend crate (%SOURCE%^) for !TRIPLE! ===
cargo build --release --manifest-path "%SOURCE%\Cargo.toml" --target "!TRIPLE!"
if errorlevel 1 exit /b 1
set "DYLIB=lib!LIB_BASE!.so"
echo !TRIPLE! | findstr /i /c:"apple" /c:"darwin" >nul && set "DYLIB=lib!LIB_BASE!.dylib"
echo !TRIPLE! | findstr /i /c:"windows" >nul && set "DYLIB=!LIB_BASE!.dll"
call :find_built "!DYLIB!" "!TRIPLE!\release"
if errorlevel 1 exit /b 1
mkdir "!STAGE!\backend\!TRIPLE!"
copy /y "!BUILT!" "!STAGE!\backend\!TRIPLE!\!DYLIB!" >nul
echo Staged backend library: backend\!TRIPLE!\!DYLIB!
exit /b 0

REM Locate a built library (%1) under the workspace or the crate's own target
REM dir, in the profile sub-directory %2; sets BUILT.
:find_built
set "BUILT="
if exist "%ROOT%\target\%~2\%~1" set "BUILT=%ROOT%\target\%~2\%~1"
if not defined BUILT if exist "%SOURCE%\target\%~2\%~1" set "BUILT=%SOURCE%\target\%~2\%~1"
if not defined BUILT (
    echo ERROR: built library %~1 not found under target\%~2 1>&2
    exit /b 1
)
exit /b 0

REM Sign PKG_PATH when --sign was given.
:sign
if not defined SIGN_KEY exit /b 0
echo === Signing (%SIGN_KEY%) ===
cargo run --quiet -p termihub-core --features plugin --bin termihub-plugin-sign -- --key "%SIGN_KEY%" "!PKG_PATH!"
exit /b !errorlevel!

:help
echo Usage: scripts\package-plugin.cmd ^<plugin-source-dir^> [--out ^<dir^>] [--no-build]
echo                                   [--target ^<triple^>]... [--sign ^<key^>]
echo        scripts\package-plugin.cmd --merge ^<pkg^> --merge ^<pkg^>... [--out ^<dir^>] [--sign ^<key^>]
exit /b 0

:usage
echo Usage: scripts\package-plugin.cmd ^<plugin-source-dir^> [--out ^<dir^>] [--no-build] [--target ^<triple^>]... [--sign ^<key^>] 1>&2
echo        scripts\package-plugin.cmd --merge ^<pkg^> --merge ^<pkg^>... [--out ^<dir^>] [--sign ^<key^>] 1>&2
exit /b 2
