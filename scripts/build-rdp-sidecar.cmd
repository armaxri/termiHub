@echo off
REM Build the RDP sidecar (termihub-rdp-helper.exe) for the host platform.
REM
REM The sidecar (#1747) is a workspace-EXCLUDED crate with its own Cargo.lock:
REM IronRDP's CredSSP crypto and russh pin incompatible RustCrypto pre-releases,
REM and Cargo allows one version per crate per lockfile (#1725). It builds as its
REM own cargo unit, separate from the main workspace build. It runs on the SAME
REM machine as termiHub, so only a native host build is needed.
REM
REM Usage: scripts\build-rdp-sidecar.cmd [--release]
setlocal
cd /d "%~dp0\.."

set "CARGO_FLAGS="
set "PROFILE=debug"
if "%~1"=="--release" (
    set "CARGO_FLAGS=--release"
    set "PROFILE=release"
)

echo === Building RDP sidecar (%PROFILE%) ===
cargo build --manifest-path rdp-sidecar\Cargo.toml %CARGO_FLAGS%
if errorlevel 1 exit /b 1

set "BIN_PATH=rdp-sidecar\target\%PROFILE%\termihub-rdp-helper.exe"
if not exist "%BIN_PATH%" (
    echo ERROR: expected binary not found at %BIN_PATH% 1>&2
    exit /b 1
)
echo Built: %BIN_PATH%
echo Point termiHub at it by placing it next to the desktop binary, or set:
echo   set TERMIHUB_RDP_HELPER=%CD%\%BIN_PATH%
endlocal
