<#
.SYNOPSIS
    Headless exit-code test for verify-conpty-bundle.ps1 and verify-no-vcruntime.ps1 (#4207).

.DESCRIPTION
    The Windows bundle checks run in a `shell: pwsh` workflow step as

        ./scripts/internal/verify-conpty-bundle.ps1 -Msi $msi.FullName
        if ($LASTEXITCODE -ne 0) { exit 1 }

    A .ps1 that falls off its end without `exit` leaves the caller's
    $LASTEXITCODE as it was. In a fresh pwsh step where no native command has
    run (the -Msi path uses Start-Process, which sets none) that is $null, and
    `$null -ne 0` is true, so the step failed right after the script printed
    success (#4207). A stale non-zero code from an earlier native command
    leaks the same way.

    This test runs the two shipped scripts (copied verbatim into a throwaway
    repo root whose conpty.env pins the dummy files) in a FRESH pwsh process per
    case, behind exactly that workflow guard, and asserts the process exit code:

      * a passing check exits 0 in a fresh session (the #4207 case);
      * a passing check exits 0 after a native command returned non-zero;
      * a passing -Nsis check exits 0 through a fake 7z on PATH;
      * a failing 7z extraction, a failing check, a thrown error and a bad
        argument set all exit 1, also after a native command returned 0.

    The dummy binaries are minimal PE32+ images with no imports. Authenticode
    is not what is under test (and Get-AuthenticodeSignature exists only on
    Windows), so each case defines a Get-AuthenticodeSignature function that
    reports a valid Microsoft signature; it shadows the cmdlet for that process.
    The -Nsis cases need a POSIX shell for the fake 7z and are skipped on
    Windows. No network, no install, no Windows required.

    Run from anywhere:  pwsh -NoProfile -File scripts/internal/test-verify-bundle-scripts.ps1
    Wired into scripts/internal/check-script-headless.sh. Exits 0 when every
    case passed, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$pwshExe = (Get-Process -Id $PID).Path
$onWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows)

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("verify-bundle-test-" + [System.Guid]::NewGuid().ToString('N'))
$failures = 0

# A minimal PE32+ image: MZ header, PE signature, a COFF header with no
# sections and an optional header whose data directories are all empty (no
# imports). $Tag makes each file's bytes, and so its SHA-256, distinct.
function New-DummyPe {
    param([string]$Path, [byte]$Tag)
    $b = New-Object byte[] 0x200
    $b[0] = 0x4D; $b[1] = 0x5A                              # MZ
    [BitConverter]::GetBytes([int32]0x40).CopyTo($b, 0x3C)  # e_lfanew
    [BitConverter]::GetBytes([uint32]0x00004550).CopyTo($b, 0x40)  # PE\0\0
    [BitConverter]::GetBytes([uint16]0x8664).CopyTo($b, 0x44)      # machine x64
    [BitConverter]::GetBytes([uint16]0xF0).CopyTo($b, 0x44 + 16)   # optional header size
    [BitConverter]::GetBytes([uint16]0x20B).CopyTo($b, 0x58)       # PE32+ magic
    $b[0x1FF] = $Tag
    [System.IO.File]::WriteAllBytes($Path, $b)
}

function Get-Sha256 {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([System.IO.File]::ReadAllBytes($Path)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

function Quote { param([string]$s) "'" + $s.Replace("'", "''") + "'" }

# Run one case in a fresh pwsh, like a GitHub `shell: pwsh` step: optionally a
# native command with exit code $PriorExit first, then the script, then the
# workflow's own guard. $Want is the expected process exit code.
function Invoke-Case {
    param([string]$Label, [string]$Script, [string]$ScriptArgs, [int]$Want,
        [object]$PriorExit = $null, [hashtable]$Env = @{})
    $cmd = @'
function Get-AuthenticodeSignature {
    param([string]$LiteralPath)
    [pscustomobject]@{
        Status = 'Valid'
        SignerCertificate = [pscustomobject]@{ Subject = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' }
    }
}
'@
    if ($null -ne $PriorExit) {
        $cmd += "`n& $(Quote $pwshExe) -NoProfile -NonInteractive -Command 'exit $PriorExit'"
        $cmd += "`nif (`$LASTEXITCODE -ne $PriorExit) { Write-Output 'prior native exit not seen'; exit 99 }"
    }
    $cmd += "`n& $(Quote (Join-Path $fakeRoot "scripts/internal/$Script")) $ScriptArgs"
    $cmd += "`nif (`$LASTEXITCODE -ne 0) { exit 1 }"
    $cmd += "`nexit 0"

    $saved = @{}
    foreach ($k in $Env.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k)
        [Environment]::SetEnvironmentVariable($k, $Env[$k])
    }
    try {
        $out = & $pwshExe -NoProfile -NonInteractive -Command $cmd 2>&1
        $rc = $LASTEXITCODE
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    if ($rc -eq $Want) {
        Write-Output "ok    ${Script}: $Label (exit $rc)"
    } else {
        Write-Output "::error file=scripts/internal/${Script}::${Label}: expected exit $Want, got $rc"
        $out | ForEach-Object { Write-Output "    | $_" }
        $script:failures++
    }
}

try {
    # Throwaway repo root holding the shipped scripts verbatim plus a conpty.env
    # that pins the dummy files.
    $fakeRoot = Join-Path $work 'repo'
    New-Item -ItemType Directory -Path (Join-Path $fakeRoot 'scripts/internal') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fakeRoot 'src-tauri/packaging/windows') -Force | Out-Null
    foreach ($s in 'verify-conpty-bundle.ps1', 'verify-no-vcruntime.ps1') {
        Copy-Item -LiteralPath (Join-Path $repoRoot "scripts/internal/$s") -Destination (Join-Path $fakeRoot 'scripts/internal')
    }

    $good = Join-Path $work 'good'
    New-Item -ItemType Directory -Path $good | Out-Null
    New-DummyPe -Path (Join-Path $good 'termihub.exe') -Tag 1
    New-DummyPe -Path (Join-Path $good 'conpty.dll') -Tag 2
    New-DummyPe -Path (Join-Path $good 'OpenConsole.exe') -Tag 3
    $pinDll = Get-Sha256 (Join-Path $good 'conpty.dll')
    $pinHost = Get-Sha256 (Join-Path $good 'OpenConsole.exe')
    [System.IO.File]::WriteAllLines((Join-Path $fakeRoot 'src-tauri/packaging/windows/conpty.env'), @(
            '# test pins for the dummy files',
            "CONPTY_DLL_X64_SHA256=$pinDll",
            "OPENCONSOLE_X64_SHA256=$pinHost",
            "CONPTY_DLL_ARM64_SHA256=$pinDll",
            "OPENCONSOLE_ARM64_SHA256=$pinHost"))

    # Fails both checks: conpty.dll does not match its pin, and a .dll that is
    # not a PE image cannot have its import table read.
    $bad = Join-Path $work 'bad'
    New-Item -ItemType Directory -Path $bad | Out-Null
    Copy-Item -Path (Join-Path $good '*') -Destination $bad
    New-DummyPe -Path (Join-Path $bad 'conpty.dll') -Tag 9
    [System.IO.File]::WriteAllText((Join-Path $bad 'broken.dll'), 'not a PE image')

    $missing = Join-Path $work 'does-not-exist'
    $q = { param($p) Quote $p }

    foreach ($s in 'verify-conpty-bundle.ps1', 'verify-no-vcruntime.ps1') {
        Invoke-Case "passing check exits 0 in a fresh session (#4207)" $s "-Dir $(& $q $good)" 0
        Invoke-Case "passing check exits 0 after a native command exited 3" $s "-Dir $(& $q $good)" 0 -PriorExit 3
        Invoke-Case "failing check exits 1" $s "-Dir $(& $q $bad)" 1
        Invoke-Case "failing check exits 1 after a native command exited 0" $s "-Dir $(& $q $bad)" 1 -PriorExit 0
        Invoke-Case "conflicting arguments exit 1" $s "-Dir $(& $q $good) -Msi $(& $q $good)" 1 -PriorExit 0
    }
    Invoke-Case "missing directory exits 1 (thrown error -> trap)" 'verify-no-vcruntime.ps1' "-Dir $(& $q $missing)" 1 -PriorExit 0
    Invoke-Case "missing binaries exit 1" 'verify-conpty-bundle.ps1' "-Dir $(& $q $missing)" 1 -PriorExit 0

    if ($onWindows) {
        Write-Output "skip  -Nsis cases: the fake 7z is a POSIX shell script"
    } else {
        # Fake 7z: "extracts" FAKE_7Z_SRC into the -o<dir> it is given, or
        # exits FAKE_7Z_EXIT without extracting.
        $fakeBin = Join-Path $work 'fakebin'
        New-Item -ItemType Directory -Path $fakeBin | Out-Null
        $fake7z = Join-Path $fakeBin '7z'
        [System.IO.File]::WriteAllText($fake7z, @'
#!/bin/sh
for a in "$@"; do case "$a" in -o*) out="${a#-o}" ;; esac; done
if [ "${FAKE_7Z_EXIT:-0}" -ne 0 ]; then exit "$FAKE_7Z_EXIT"; fi
mkdir -p "$out" && cp "$FAKE_7Z_SRC"/* "$out"/
'@.Replace("`r`n", "`n"))
        & chmod +x $fake7z
        if ($LASTEXITCODE -ne 0) { throw "chmod +x $fake7z failed" }
        $setup = Join-Path $work 'termiHub_0.0.0_x64-setup.exe'
        [System.IO.File]::WriteAllText($setup, 'dummy installer')
        $path = $fakeBin + [System.IO.Path]::PathSeparator + $env:PATH
        foreach ($s in 'verify-conpty-bundle.ps1', 'verify-no-vcruntime.ps1') {
            Invoke-Case "-Nsis through a passing 7z exits 0 after a native command exited 3" $s `
                "-Nsis $(& $q $setup)" 0 -PriorExit 3 -Env @{ PATH = $path; FAKE_7Z_SRC = $good; FAKE_7Z_EXIT = '0' }
            Invoke-Case "-Nsis with a failing 7z exits 1" $s `
                "-Nsis $(& $q $setup)" 1 -Env @{ PATH = $path; FAKE_7Z_SRC = $good; FAKE_7Z_EXIT = '2' }
            Invoke-Case "-Nsis of a failing bundle exits 1" $s `
                "-Nsis $(& $q $setup)" 1 -PriorExit 0 -Env @{ PATH = $path; FAKE_7Z_SRC = $bad; FAKE_7Z_EXIT = '0' }
        }
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures -gt 0) {
    Write-Output "verify-bundle script exit-code test FAILED: $failures case(s)."
    exit 1
}
Write-Output 'verify-bundle script exit-code test OK.'
exit 0
