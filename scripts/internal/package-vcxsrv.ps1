<#
.SYNOPSIS
    Build the pinned, minimal VcXsrv .zip that termiHub downloads for SSH X11
    forwarding, compute its SHA-256, and (optionally) patch it into the source.

.DESCRIPTION
    termiHub redistributes a pinned, pre-extracted minimal VcXsrv tree
    (vcxsrv.exe + required DLLs + fonts/) as a versioned .zip hosted on its own
    GitHub releases. `src-tauri/src/terminal/xserver/acquire.rs` downloads that
    .zip, verifies it against a compiled-in SHA-256, and extracts it. This script
    produces that artifact reproducibly from an installed VcXsrv and prints the
    SHA-256 to paste into `PINNED_VCXSRV.sha256` (see issue #1076).

    VcXsrv is GPL-3.0; termiHub runs it as a separate process (mere aggregation)
    - see docs/licensing.md. Install upstream VcXsrv once from
    https://github.com/marchaesen/vcxsrv/releases (pin: 21.1.13) and point -Src
    at its install directory. This script never installs or downloads anything;
    it only repackages a tree you already have, so the bytes are auditable.

    The zip stores files at its ROOT (vcxsrv.exe at top level, not under a
    version subdir) so that acquire.rs's extract-into-install-dir logic yields
    <install_dir>/vcxsrv.exe directly.

.PARAMETER Version
    Upstream VcXsrv version to stamp into the artifact name and (with
    -UpdateAcquire) validate against acquire.rs. Default: 21.1.13.

.PARAMETER Src
    Path to an installed VcXsrv directory (must contain vcxsrv.exe). Defaults to
    the standard install location, falling back to the x86 Program Files dir.

.PARAMETER OutDir
    Directory to write the staging tree and the .zip into. Default:
    <repo>/target/vcxsrv-package (gitignored).

.PARAMETER Full
    Package the entire install tree unchanged (correctness over size). By default
    a small denylist of clearly-unneeded files (the XLaunch wizard, its PuTTY
    helper, the uninstaller, logs) is pruned - everything the running server
    needs is kept.

.PARAMETER UpdateAcquire
    After building, rewrite PINNED_VCXSRV.sha256 in acquire.rs with the computed
    hash. Fails if the file's PINNED_VCXSRV.version does not match -Version.

.EXAMPLE
    powershell -File scripts/internal/package-vcxsrv.ps1 -UpdateAcquire
    # then publish the printed artifact:
    gh release create vcxsrv-21.1.13 target/vcxsrv-package/vcxsrv-21.1.13-minimal.zip `
      --title "VcXsrv 21.1.13 (minimal, for termiHub X11)" --notes "GPL-3.0. See THIRD_PARTY_LICENSES.md."
#>
[CmdletBinding()]
param(
    [string]$Version = "21.1.13",
    [string]$Src,
    [string]$OutDir,
    [switch]$Full,
    [switch]$UpdateAcquire
)

$ErrorActionPreference = "Stop"

# --- Resolve repo root (scripts/internal/ -> repo root) ---------------------
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$AcquireRs = Join-Path $RepoRoot "src-tauri\src\terminal\xserver\acquire.rs"

# --- Resolve the VcXsrv source install dir ----------------------------------
if (-not $Src) {
    $candidates = @(
        (Join-Path $env:ProgramFiles "VcXsrv"),
        (Join-Path ${env:ProgramFiles(x86)} "VcXsrv")
    )
    $Src = $candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ "vcxsrv.exe")) } | Select-Object -First 1
    if (-not $Src) {
        throw "No VcXsrv install found. Install VcXsrv $Version from https://github.com/marchaesen/vcxsrv/releases, or pass -Src <dir>."
    }
}
$Src = (Resolve-Path $Src).Path
$srcExe = Join-Path $Src "vcxsrv.exe"
if (-not (Test-Path $srcExe)) {
    throw "vcxsrv.exe not found under -Src '$Src'."
}

# Sanity-check the installed version against -Version so the artifact name and
# the pinned table cannot silently drift from what is actually packaged.
$fileVersion = (Get-Item $srcExe).VersionInfo.FileVersion
if ($fileVersion -and -not $fileVersion.StartsWith($Version)) {
    Write-Warning "Installed vcxsrv.exe reports version '$fileVersion' but -Version is '$Version'. Confirm you installed the pinned build before publishing."
}

if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "target\vcxsrv-package" }
$staging = Join-Path $OutDir "vcxsrv-$Version"
$zipPath = Join-Path $OutDir "vcxsrv-$Version-minimal.zip"

Write-Host "Packaging VcXsrv $Version"
Write-Host "  source : $Src"
Write-Host "  staging: $staging"
Write-Host "  zip    : $zipPath"

# --- Stage a copy, then prune (never touch the real install) ----------------
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item -Recurse -Force (Join-Path $Src "*") $staging

if (-not $Full) {
    # Clearly-unneeded for a headless `vcxsrv.exe :0 -multiwindow -clipboard
    # -auth <file>` launch. Best-effort: missing entries are fine across builds.
    $deny = @("xlaunch.exe", "plink.exe", "uninstall.exe", "vcxsrv.exe.log", "XLaunch.log")
    foreach ($name in $deny) {
        $p = Join-Path $staging $name
        if (Test-Path $p) {
            Remove-Item -Force -Recurse $p
            Write-Host "  pruned : $name"
        }
    }
}

# --- Guard: the running server must still have what it needs -----------------
if (-not (Test-Path (Join-Path $staging "vcxsrv.exe"))) {
    throw "Staged tree is missing vcxsrv.exe - refusing to package."
}
if (-not (Test-Path (Join-Path $staging "fonts"))) {
    Write-Warning "Staged tree has no fonts/ directory - the server may fail to start core fonts."
}

# --- Zip the CONTENTS of the staging dir (files at the zip root) -------------
# Build entries by hand with forward-slash names. `Compress-Archive` (and .NET
# Framework's ZipFile) on Windows PowerShell 5.1 stores backslash separators,
# which is non-conformant ZIP; the extractor in acquire.rs and other tools
# expect `/`. Emitting `/` keeps the artifact portable and matches the
# forward-slash archives the Rust extraction tests exercise.
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
$stagingFull = (Resolve-Path $staging).Path.TrimEnd('\')
$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::CreateNew)
try {
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem -Path $staging -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($stagingFull.Length + 1) -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $archive.Dispose() }
} finally { $zipStream.Dispose() }
$zipPath = (Resolve-Path $zipPath).Path

# --- Compute the SHA-256 (lowercase hex, as acquire.rs expects) --------------
$sha = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
$sizeMB = "{0:N1}" -f ((Get-Item $zipPath).Length / 1MB)

Write-Host ""
Write-Host "Artifact : $zipPath ($sizeMB MB)"
Write-Host "SHA-256  : $sha"
Write-Host ""

# --- Optionally patch PINNED_VCXSRV.sha256 in acquire.rs ---------------------
if ($UpdateAcquire) {
    $text = Get-Content -Raw -Path $AcquireRs
    if ($text -notmatch "version:\s*""$([regex]::Escape($Version))""") {
        throw "acquire.rs PINNED_VCXSRV.version does not match -Version '$Version'. Update the pinned version (and THIRD_PARTY_LICENSES.md) first."
    }
    $updated = [regex]::Replace($text, 'sha256:\s*"[0-9a-fA-F]{64}"', "sha256: `"$sha`"")
    if ($updated -eq $text) {
        Write-Warning "No sha256 field replaced in acquire.rs (already up to date?)."
    } else {
        Set-Content -Path $AcquireRs -Value $updated -NoNewline
        Write-Host "Patched PINNED_VCXSRV.sha256 in $AcquireRs"
    }
}

Write-Host "Next: publish the artifact, then verify the pinned URL resolves:"
Write-Host "  gh release create vcxsrv-$Version `"$zipPath`" \"
Write-Host "    --title `"VcXsrv $Version (minimal, for termiHub X11)`" \"
Write-Host "    --notes `"GPL-3.0. See THIRD_PARTY_LICENSES.md and licenses/GPL-3.0.txt.`""
Write-Host "  cargo test -p termihub -- --ignored pinned_artifact_downloads_verifies_and_contains_exe"
