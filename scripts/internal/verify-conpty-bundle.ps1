<#
.SYNOPSIS
    Assert a Windows build ships the sideloaded ConPTY host next to termihub.exe (#4121).

.DESCRIPTION
    portable-pty loads a conpty.dll found beside termihub.exe in preference to
    the inbox ConPTY, and that conpty.dll starts the OpenConsole.exe beside it.
    If either file is missing, misplaced or altered, local terminals silently
    fall back to the inbox host and inline images disappear again. This check
    makes that a build failure instead:

      * -Msi: administrative-extracts the MSI (msiexec /a, no install) and
        looks in the directory that holds termihub.exe;
      * -Nsis: extracts the NSIS setup.exe with 7-Zip (preinstalled on the
        GitHub windows runner; no install) and does the same;
      * -Dir: looks in an existing directory (an install dir, or the
        target/<profile> dir of a `tauri build`).

    In that directory conpty.dll and OpenConsole.exe must both exist, match
    the SHA-256 pins in src-tauri/packaging/windows/conpty.env for -Arch, and
    carry a valid Authenticode signature from Microsoft Corporation.

    Windows only (msiexec, 7-Zip, Get-AuthenticodeSignature). Exits 1 on any
    failure.

.PARAMETER Msi
    MSI to check.

.PARAMETER Nsis
    NSIS setup.exe to check.

.PARAMETER Dir
    Directory to check (instead of -Msi / -Nsis).

.PARAMETER Arch
    x64 (default) or arm64: which pins to compare against.
#>
param(
    [string]$Msi = '',
    [string]$Nsis = '',
    [string]$Dir = '',
    [ValidateSet('x64', 'arm64')]
    [string]$Arch = 'x64'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if (@($Msi, $Nsis, $Dir | Where-Object { $_ }).Count -ne 1) {
    Write-Output '::error::pass exactly one of -Msi, -Nsis or -Dir'
    exit 1
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$pins = @{}
foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $repoRoot 'src-tauri/packaging/windows/conpty.env'))) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') { $pins[$Matches[1]] = $Matches[2].Trim() }
}
$upper = $Arch.ToUpperInvariant()
$expected = [ordered]@{
    'conpty.dll'      = $pins["CONPTY_DLL_${upper}_SHA256"]
    'OpenConsole.exe' = $pins["OPENCONSOLE_${upper}_SHA256"]
}

$extract = $null
if ($Msi -or $Nsis) {
    $extract = Join-Path ([System.IO.Path]::GetTempPath()) ("bundle-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $extract | Out-Null
    if ($Msi) {
        $source = [System.IO.Path]::GetFullPath($Msi)
        $log = Join-Path $extract 'admin-extract.log'
        $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
            '/a', "`"$source`"", '/qn', "TARGETDIR=`"$extract`"", '/l*v', "`"$log`""
        )
        $code = $p.ExitCode
    } else {
        $source = [System.IO.Path]::GetFullPath($Nsis)
        & 7z x -y "-o$extract" $source | Out-Null
        $code = $LASTEXITCODE
    }
    if ($code -ne 0) {
        Write-Output "::error::extracting $source failed with exit code $code"
        exit 1
    }
    $exe = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter 'termihub.exe' | Select-Object -First 1
    if (-not $exe) {
        Write-Output "::error::termihub.exe not found in the extracted $source"
        exit 1
    }
    $Dir = $exe.DirectoryName
}

try {
    Write-Output "Checking the sideloaded ConPTY host in $Dir"
    $failed = 0
    foreach ($name in $expected.Keys) {
        $path = Join-Path $Dir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Write-Output "::error::$name is not next to termihub.exe in $Dir"
            $failed++
            continue
        }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $stream = [System.IO.File]::OpenRead($path)
        try { $hash = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
        finally { $stream.Dispose(); $sha.Dispose() }
        if ($hash -ne $expected[$name]) {
            Write-Output "::error::$name SHA-256 $hash does not match the pin $($expected[$name])"
            $failed++
            continue
        }
        $sig = Get-AuthenticodeSignature -LiteralPath $path
        $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '(unsigned)' }
        if ($sig.Status -ne 'Valid' -or $subject -notmatch 'O=Microsoft Corporation') {
            Write-Output "::error::$name signature is $($sig.Status) by '$subject' (want Valid, Microsoft Corporation)"
            $failed++
            continue
        }
        Write-Output "  ok  $name  sha256=$hash  signer=$subject"
    }
    if ($failed -gt 0) { exit 1 }
    Write-Output 'Sideloaded ConPTY host present, pinned and Microsoft-signed.'
} finally {
    if ($extract) { Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue }
}
