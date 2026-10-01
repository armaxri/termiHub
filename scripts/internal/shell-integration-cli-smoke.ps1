# CLI smoke for `termiHub.exe install-shell-integration` /
# `termiHub.exe uninstall-shell-integration` on Windows (#4010, #1368).
#
# Usage: pwsh scripts/internal/shell-integration-cli-smoke.ps1 -Exe <path-to-termihub.exe>
#
# Proves, against a real built binary:
#   * both subcommands exit 0; install prints "Shell integration installed."
#     and uninstall prints "Shell integration removed.";
#   * registration needs no elevation: every key lands under HKEY_CURRENT_USER
#     (HKCU:\Software\Classes), nothing under HKEY_LOCAL_MACHINE;
#   * install writes the Explorer verb for a configured entry with a command
#     line invoking the binary; uninstall removes it again.
#
# CI ONLY. Unlike the Linux smoke, the Windows registration target (the user's
# HKCU class store) cannot be redirected to a sandbox, so this refuses to run
# outside GitHub Actions to never touch a developer's real Explorer menus. It
# also refuses when a termiHub registration already exists, and always runs the
# uninstall on exit. termiHub's settings go to a throwaway TERMIHUB_CONFIG_DIR.
param(
    [Parameter(Mandatory = $true)][string]$Exe
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -ne 'true') {
    [Console]::Error.WriteLine('refusing to run outside CI: this writes real HKCU Explorer ' +
        'context-menu keys (set by GitHub Actions only)')
    exit 2
}

$Exe = (Resolve-Path -LiteralPath $Exe).Path
$classes = 'HKCU:\Software\Classes'
$roots = @('Directory\shell', 'Directory\Background\shell', '*\shell')

function Get-TermihubKeys([string]$base) {
    foreach ($root in $roots) {
        $shell = Join-Path $base $root
        if (Test-Path -LiteralPath $shell) {
            Get-ChildItem -LiteralPath $shell |
                Where-Object { $_.PSChildName -like 'termihub*' }
        }
    }
}

function Invoke-Cli([string]$verb, [string]$expected) {
    $stdout = Join-Path $sandbox "$verb.out"
    $stderr = Join-Path $sandbox "$verb.err"
    $proc = Start-Process -FilePath $Exe -ArgumentList $verb -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $out = "$(Get-Content -LiteralPath $stdout -Raw)$(Get-Content -LiteralPath $stderr -Raw)"
    Write-Host "--- termiHub $verb (exit $($proc.ExitCode))"
    Write-Host $out
    if ($proc.ExitCode -ne 0) { throw "termiHub $verb exited $($proc.ExitCode)" }
    if (-not ($out -split "`r?`n" | Where-Object { $_.Trim() -eq $expected })) {
        throw "termiHub $verb did not print '$expected'"
    }
}

if (Get-TermihubKeys $classes) {
    [Console]::Error.WriteLine('refusing to run: a termiHub Explorer registration already exists in HKCU')
    exit 2
}

$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) "termihub-si-smoke-$PID"
New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
$env:TERMIHUB_CONFIG_DIR = Join-Path $sandbox 'config'
New-Item -ItemType Directory -Force -Path $env:TERMIHUB_CONFIG_DIR | Out-Null
$settings = Join-Path $env:TERMIHUB_CONFIG_DIR 'settings.json'

try {
    # 1. Install with the default (empty) entry list: exits 0, persists settings.
    Invoke-Cli 'install-shell-integration' 'Shell integration installed.'
    if (-not (Test-Path -LiteralPath $settings)) { throw 'install did not persist settings.json' }

    # 2. Seed one entry and install again: its Explorer verb is written to HKCU.
    $doc = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
    $entry = [pscustomobject]@{
        id         = 'smoke'
        name       = 'Open in termiHub Smoke'
        visibility = 'always'
        showFor    = [pscustomobject]@{ folders = $true; files = $false; folderBackground = $true }
    }
    if (-not ($doc.PSObject.Properties.Name -contains 'shellIntegration')) {
        $doc | Add-Member -NotePropertyName shellIntegration -NotePropertyValue ([pscustomobject]@{})
    }
    $doc.shellIntegration | Add-Member -Force -NotePropertyName entries -NotePropertyValue @($entry)
    $doc | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $settings -Encoding utf8

    Invoke-Cli 'install-shell-integration' 'Shell integration installed.'
    $keys = @(Get-TermihubKeys $classes)
    if ($keys.Count -eq 0) { throw 'install wrote no termiHub verb under HKCU\Software\Classes' }
    $command = Get-ItemProperty -LiteralPath (Join-Path $keys[0].PSPath 'command')
    if ($command.'(default)' -notlike "*$Exe*") {
        throw "verb command '$($command.'(default)')' does not invoke $Exe"
    }

    # No elevation: nothing may land in the machine-wide class store.
    if (Get-TermihubKeys 'HKLM:\Software\Classes') {
        throw 'registration wrote under HKEY_LOCAL_MACHINE (would need elevation)'
    }

    # 3. Uninstall: exits 0 and removes every termiHub key.
    Invoke-Cli 'uninstall-shell-integration' 'Shell integration removed.'
    if (Get-TermihubKeys $classes) { throw 'uninstall left termiHub keys under HKCU' }
}
finally {
    # Never leave a registration behind, even when an assertion above failed.
    foreach ($key in @(Get-TermihubKeys $classes)) {
        Remove-Item -LiteralPath $key.PSPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'OK: shell-integration CLI install/uninstall smoke passed (HKCU only, no elevation)'
