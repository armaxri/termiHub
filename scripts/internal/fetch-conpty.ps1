<#
.SYNOPSIS
    Fetch and stage the sideloaded ConPTY host for the Windows bundle (#4121).

.DESCRIPTION
    PowerShell twin of fetch-conpty.sh; fetch-conpty.cmd parses the flags and
    calls this script. Same pins, same checks, same staging:

      * reads the version and SHA-256 pins from
        src-tauri/packaging/windows/conpty.env;
      * keeps conpty.dll + OpenConsole.exe already in -Dest when both match
        their pins (no download);
      * otherwise downloads Microsoft.Windows.Console.ConPTY <version>.nupkg
        from nuget.org, refuses it unless its SHA-256 matches, extracts the
        two files for -Arch, checks each against its own pin, and only then
        copies them into -Dest.

    Any mismatch exits 1 and stages nothing.

    Runs on Windows PowerShell 5.1 and PowerShell 7. It uses .NET directly
    (no Get-FileHash / Expand-Archive / Invoke-WebRequest), because a
    powershell.exe launched from pwsh can fail to autoload those cmdlets'
    modules (#4029).

.PARAMETER Arch
    x64 (default) or arm64.

.PARAMETER Dest
    Staging directory (default: src-tauri/binaries/conpty, gitignored).
#>
param(
    [ValidateSet('x64', 'arm64')]
    [string]$Arch = 'x64',
    [string]$Dest = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$pinFile = Join-Path $repoRoot 'src-tauri/packaging/windows/conpty.env'
if ([string]::IsNullOrEmpty($Dest)) { $Dest = Join-Path $repoRoot 'src-tauri/binaries/conpty' }

$pins = @{}
foreach ($line in [System.IO.File]::ReadAllLines($pinFile)) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') { $pins[$Matches[1]] = $Matches[2].Trim() }
}
$version = $pins['CONPTY_VERSION']
$upper = $Arch.ToUpperInvariant()
$dllSha = $pins["CONPTY_DLL_${upper}_SHA256"]
$hostSha = $pins["OPENCONSOLE_${upper}_SHA256"]
$dllEntry = "runtimes/win-$Arch/native/conpty.dll"
$hostEntry = "build/native/runtimes/$Arch/OpenConsole.exe"

function Get-Sha256Hex([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return (-join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }))
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
    $actual = Get-Sha256Hex $Path
    if ($actual -ne $Expected) {
        Write-Output "::error::SHA-256 mismatch for $Label"
        Write-Output "  expected: $Expected"
        Write-Output "  actual:   $actual"
        exit 1
    }
    Write-Output "  verified $Label ($actual)"
}

function Test-Staged {
    $dll = Join-Path $Dest 'conpty.dll'
    $exe = Join-Path $Dest 'OpenConsole.exe'
    return (Test-Path -LiteralPath $dll -PathType Leaf) -and
        (Test-Path -LiteralPath $exe -PathType Leaf) -and
        ((Get-Sha256Hex $dll) -eq $dllSha) -and
        ((Get-Sha256Hex $exe) -eq $hostSha)
}

Write-Output "=== Sideloaded ConPTY $version ($Arch) -> $Dest ==="
if (Test-Staged) {
    Write-Output '  already staged with the pinned hashes; nothing to do'
    exit 0
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("conpty-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $nupkg = Join-Path $work 'conpty.nupkg'
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/$version/microsoft.windows.console.conpty.$version.nupkg"
    Write-Output "  downloading $url"
    # Windows PowerShell 5.1 may default to TLS 1.0; nuget.org needs 1.2+.
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    $client = New-Object System.Net.WebClient
    $attempt = 0
    while ($true) {
        try { $client.DownloadFile($url, $nupkg); break }
        catch {
            $attempt++
            if ($attempt -ge 3) { throw }
            Write-Output "  download failed ($($_.Exception.Message)); retrying"
            Start-Sleep -Seconds 5
        }
    }
    $client.Dispose()
    Assert-Sha256 $nupkg $pins['CONPTY_NUPKG_SHA256'] "Microsoft.Windows.Console.ConPTY $version.nupkg"

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg)
    try {
        foreach ($pair in @(@($dllEntry, 'conpty.dll'), @($hostEntry, 'OpenConsole.exe'))) {
            $entry = $zip.GetEntry($pair[0])
            if ($null -eq $entry) {
                Write-Output "::error::$($pair[0]) not found in the package"
                exit 1
            }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $work $pair[1]), $true)
        }
    } finally {
        $zip.Dispose()
    }
    Assert-Sha256 (Join-Path $work 'conpty.dll') $dllSha $dllEntry
    Assert-Sha256 (Join-Path $work 'OpenConsole.exe') $hostSha $hostEntry

    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Copy-Item -LiteralPath (Join-Path $work 'conpty.dll'), (Join-Path $work 'OpenConsole.exe') -Destination $Dest -Force
    Write-Output "  staged conpty.dll + OpenConsole.exe in $Dest"
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
