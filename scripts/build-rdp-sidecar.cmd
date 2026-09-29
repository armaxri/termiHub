@echo off
REM Build the RDP sidecar (termihub-rdp-helper.exe) and optionally stage it for Tauri.
REM
REM The sidecar (#1747) is a workspace-EXCLUDED crate with its own Cargo.lock:
REM IronRDP's CredSSP crypto and russh pin incompatible RustCrypto pre-releases,
REM and Cargo allows one version per crate per lockfile (#1725). It builds as its
REM own cargo unit, separate from the main workspace build. It runs on the SAME
REM machine as termiHub, so a released build ships it NEXT TO the desktop binary
REM via Tauri `externalBin` (#1754).
REM
REM Usage: scripts\build-rdp-sidecar.cmd [--release] [--target <triple>]
REM                                      [--tauri-externalbin] [--out <dir>]
REM   --release             Build with optimizations (default: debug).
REM   --target <triple>     Cross-build for a specific Rust target triple (e.g.
REM                         aarch64-pc-windows-msvc). Default: the host triple.
REM                         Output lands under rdp-sidecar\target\<triple>\<profile>\.
REM   --tauri-externalbin   Stage the binary into src-tauri\binaries\ named
REM                         termihub-rdp-helper-<triple>.exe, the layout Tauri
REM                         `externalBin` expects, plus a .sha256 sidecar.
REM   --out <dir>           Also copy the binary into <dir> (e.g. next to a
REM                         locally-built desktop binary for manual testing).
REM
REM Mirrors scripts/build-rdp-sidecar.sh (flag parity is checked by
REM scripts/internal/check-script-parity.sh). Relative --out paths resolve against
REM the repo root, as in the .sh. Hashing uses Windows PowerShell's Get-FileHash,
REM the same line build-agents.cmd uses (locale-independent, unlike certutil).
REM
REM cmd pitfalls kept out of this file on purpose: no `if errorlevel` / %var%
REM reads inside parenthesised blocks (they expand when the block is parsed), and
REM the arguments are parsed with goto labels so `shift` never runs inside one.
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set "CARGO_FLAGS="
set "PROFILE=debug"
set "EXTERNALBIN=0"
set "TARGET="
set "OUT_DIR="

:parse
if "%~1"=="" goto after_parse
if "%~1"=="--help" goto usage
if "%~1"=="-h" goto usage
if "%~1"=="/?" goto usage
if "%~1"=="--release" goto opt_release
if "%~1"=="--target" goto opt_target
if "%~1"=="--tauri-externalbin" goto opt_externalbin
if "%~1"=="--out" goto opt_out
echo Unknown argument: %~1 1>&2
exit /b 2

:opt_release
set "CARGO_FLAGS=--release"
set "PROFILE=release"
shift
goto parse

:opt_target
if "%~2"=="" goto missing_value
set "TARGET=%~2"
shift
shift
goto parse

:opt_externalbin
set "EXTERNALBIN=1"
shift
goto parse

:opt_out
if "%~2"=="" goto missing_value
set "OUT_DIR=%~2"
shift
shift
goto parse

:missing_value
if "%~1"=="--target" echo ERROR: --target requires a triple 1>&2
if "%~1"=="--out" echo ERROR: --out requires a directory 1>&2
exit /b 2

:usage
echo Usage: scripts\build-rdp-sidecar.cmd [--release] [--target ^<triple^>]
echo                                      [--tauri-externalbin] [--out ^<dir^>]
echo   --release             Build with optimizations (default: debug).
echo   --target ^<triple^>     Cross-build for a Rust target triple (default: host).
echo   --tauri-externalbin   Stage src-tauri\binaries\termihub-rdp-helper-^<triple^>.exe
echo                         for Tauri externalBin, plus a .sha256 sidecar.
echo   --out ^<dir^>           Also copy the built binary into ^<dir^>.
exit /b 0

:after_parse

REM externalBin staging needs a concrete triple for the filename suffix, so
REM resolve the host triple when none was given. Without either flag keep the
REM historical host-native layout (rdp-sidecar\target\<profile>\) untouched.
if not "%EXTERNALBIN%"=="1" goto have_triple
if defined TARGET goto have_triple
for /f "tokens=2" %%i in ('rustc -vV ^| findstr /b "host:"') do set "TARGET=%%i"
if defined TARGET goto have_triple
echo ERROR: could not determine host target triple from 'rustc -vV' 1>&2
exit /b 1
:have_triple

REM The .exe suffix and cargo output dir depend on the *target*, not the host,
REM so a cross-build for a non-Windows triple names the file correctly.
set "EXE_SUFFIX=.exe"
if defined TARGET if "!TARGET:windows=!"=="!TARGET!" set "EXE_SUFFIX="
set "BIN_NAME=termihub-rdp-helper%EXE_SUFFIX%"
if defined TARGET (
    set "CARGO_FLAGS=%CARGO_FLAGS% --target %TARGET%"
    set "BIN_PATH=rdp-sidecar\target\%TARGET%\%PROFILE%\%BIN_NAME%"
    set "LABEL=%PROFILE%, %TARGET%"
) else (
    set "BIN_PATH=rdp-sidecar\target\%PROFILE%\%BIN_NAME%"
    set "LABEL=%PROFILE%"
)

echo === Building RDP sidecar (%LABEL%) ===
REM `call` so a cargo.cmd/.bat shim on PATH returns here instead of ending this script.
call cargo build --manifest-path rdp-sidecar\Cargo.toml %CARGO_FLAGS%
if errorlevel 1 (
    echo ERROR: cargo build failed 1>&2
    exit /b 1
)

if not exist "%BIN_PATH%" (
    echo ERROR: expected binary not found at %BIN_PATH% 1>&2
    exit /b 1
)
echo Built: %BIN_PATH%

if not "%EXTERNALBIN%"=="1" goto after_externalbin
REM Tauri appends -<triple> (and .exe on Windows targets); it strips the triple
REM at bundle time, leaving termihub-rdp-helper[.exe] next to the app binary.
set "STAGE_DIR=src-tauri\binaries"
set "STAGE_NAME=termihub-rdp-helper-%TARGET%%EXE_SUFFIX%"
set "STAGED=%STAGE_DIR%\%STAGE_NAME%"
if not exist "%STAGE_DIR%" mkdir "%STAGE_DIR%"
copy /y "%BIN_PATH%" "%STAGED%" >nul
if errorlevel 1 (
    echo ERROR: could not stage %BIN_PATH% as %STAGED% 1>&2
    exit /b 1
)
echo Staged for Tauri externalBin: %STAGED%

REM Compute the sidecar's SHA-256 (#1762). core\build.rs hashes this exact staged
REM binary to embed the expected digest the adapter checks before spawn, so this
REM `.sha256` file is transparency/local verification only -- but it must never be
REM empty or bogus (#3475: the old certutil loop skipped the digest line itself).
call :write_checksum "%STAGED%"
if errorlevel 1 (
    echo ERROR: could not write a valid SHA-256 sidecar for %STAGED% 1>&2
    exit /b 1
)
set "DIGEST="
for /f "usebackq tokens=1" %%h in ("%STAGED%.sha256") do if not defined DIGEST set "DIGEST=%%h"
echo SHA-256: %DIGEST%
echo Wrote checksum sidecar: %STAGED%.sha256
:after_externalbin

if not defined OUT_DIR goto print_hint
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
copy /y "%BIN_PATH%" "%OUT_DIR%\" >nul
if errorlevel 1 (
    echo ERROR: could not copy %BIN_PATH% to %OUT_DIR% 1>&2
    exit /b 1
)
echo Copied to: %OUT_DIR%\%BIN_NAME%
echo Point termiHub at it by placing it next to the desktop binary, or set:
echo   set TERMIHUB_RDP_HELPER=%OUT_DIR%\%BIN_NAME%
endlocal
exit /b 0

:print_hint
echo Point termiHub at it by placing it next to the desktop binary, or set:
echo   set TERMIHUB_RDP_HELPER=%CD%\%BIN_PATH%
endlocal
exit /b 0

REM Write "<hex>  <name>" + LF to "%~1.sha256" (the sha256sum text format the .sh
REM writes). Same PowerShell line as build-agents.cmd, plus a check that the
REM first token is exactly 64 characters (a SHA-256 hex digest). Returns
REM non-zero -- and the caller fails the build -- if hashing or the write fails
REM or the result is malformed.
REM   %1 = file to hash
:write_checksum
if exist "%~1.sha256" del /q "%~1.sha256"
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $p = (Resolve-Path -LiteralPath '%~1').Path; $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant(); [IO.File]::WriteAllText($p + '.sha256', $h + '  ' + [IO.Path]::GetFileName($p) + [char]10)"
if errorlevel 1 exit /b 1
if not exist "%~1.sha256" exit /b 1
set "CHECK_DIGEST="
for /f "usebackq tokens=1" %%h in ("%~1.sha256") do set "CHECK_DIGEST=%%h"
if not defined CHECK_DIGEST exit /b 1
if not "!CHECK_DIGEST:~64!"=="" exit /b 1
if "!CHECK_DIGEST:~63!"=="" exit /b 1
exit /b 0
