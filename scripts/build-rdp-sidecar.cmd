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
REM Usage: scripts\build-rdp-sidecar.cmd [--release] [--tauri-externalbin]
REM   --release             Build with optimizations (default: debug).
REM   --tauri-externalbin   Stage the binary into src-tauri\binaries\ named
REM                         termihub-rdp-helper-<host-triple>.exe, the layout
REM                         Tauri `externalBin` expects.
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set "CARGO_FLAGS="
set "PROFILE=debug"
set "EXTERNALBIN=0"

:parse
if "%~1"=="" goto after_parse
if "%~1"=="--release" (
    set "CARGO_FLAGS=--release"
    set "PROFILE=release"
) else if "%~1"=="--tauri-externalbin" (
    set "EXTERNALBIN=1"
) else (
    echo Unknown argument: %~1 1>&2
    exit /b 2
)
shift
goto parse
:after_parse

echo === Building RDP sidecar (%PROFILE%) ===
cargo build --manifest-path rdp-sidecar\Cargo.toml %CARGO_FLAGS%
if errorlevel 1 exit /b 1

set "BIN_PATH=rdp-sidecar\target\%PROFILE%\termihub-rdp-helper.exe"
if not exist "%BIN_PATH%" (
    echo ERROR: expected binary not found at %BIN_PATH% 1>&2
    exit /b 1
)
echo Built: %BIN_PATH%

if "%EXTERNALBIN%"=="1" (
    REM Resolve the host target triple for the externalBin filename suffix.
    for /f "tokens=2" %%i in ('rustc -vV ^| findstr /b "host:"') do set "TRIPLE=%%i"
    if not defined TRIPLE (
        echo ERROR: could not determine host target triple from 'rustc -vV' 1>&2
        exit /b 1
    )
    if not exist "src-tauri\binaries" mkdir "src-tauri\binaries"
    set "STAGE_NAME=termihub-rdp-helper-!TRIPLE!.exe"
    copy /y "%BIN_PATH%" "src-tauri\binaries\!STAGE_NAME!" >nul
    echo Staged for Tauri externalBin: src-tauri\binaries\!STAGE_NAME!

    REM Compute the sidecar's SHA-256 (#1762). core\build.rs hashes this exact
    REM staged binary to embed the expected digest the adapter checks before
    REM spawn; this writes a `.sha256` sidecar and prints the digest purely for
    REM transparency/local verification. certutil ships with Windows.
    for /f "skip=1 tokens=* delims=" %%h in ('certutil -hashfile "src-tauri\binaries\!STAGE_NAME!" SHA256 ^| findstr /r "^[0-9a-fA-F ]*$"') do (
        if not defined DIGEST set "DIGEST=%%h"
    )
    REM certutil prints the hash with spaces between byte pairs; strip them.
    set "DIGEST=!DIGEST: =!"
    >"src-tauri\binaries\!STAGE_NAME!.sha256" echo !DIGEST!  !STAGE_NAME!
    echo SHA-256: !DIGEST!
    echo Wrote checksum sidecar: src-tauri\binaries\!STAGE_NAME!.sha256
)

echo Point termiHub at it by placing it next to the desktop binary, or set:
echo   set TERMIHUB_RDP_HELPER=%CD%\%BIN_PATH%
endlocal
