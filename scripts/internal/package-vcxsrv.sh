#!/usr/bin/env bash
# Git-Bash wrapper for scripts/internal/package-vcxsrv.ps1.
#
# Packaging the pinned minimal VcXsrv .zip is inherently Windows-only (VcXsrv is
# a Windows program), so the real work lives in the PowerShell script and this
# wrapper simply forwards long flags to it. Run it from Git Bash on Windows;
# on other platforms it exits with a clear message.
#
# Usage:
#   ./scripts/internal/package-vcxsrv.sh [--version <v>] [--src <dir>]
#                                        [--out <dir>] [--full] [--update-acquire]
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v powershell.exe >/dev/null 2>&1; then
    echo "package-vcxsrv is Windows-only (needs powershell.exe and an installed VcXsrv)." >&2
    exit 1
fi

ps_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
    --version) ps_args+=("-Version" "$2"); shift 2 ;;
    --src) ps_args+=("-Src" "$2"); shift 2 ;;
    --out) ps_args+=("-OutDir" "$2"); shift 2 ;;
    --full) ps_args+=("-Full"); shift ;;
    --update-acquire) ps_args+=("-UpdateAcquire"); shift ;;
    -h | --help)
        echo "See scripts/internal/package-vcxsrv.ps1 for full documentation."
        exit 0
        ;;
    *)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    esac
done

powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File "scripts/internal/package-vcxsrv.ps1" "${ps_args[@]}"
