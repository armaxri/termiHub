<#
.SYNOPSIS
    Assert no shipped Windows binary needs the Visual C++ redistributable (#4172).

.DESCRIPTION
    Release builds link the Visual C++ runtime statically (src-tauri/build.rs for
    termihub.exe, scripts/build-rdp-sidecar.* for termihub-rdp-helper.exe,
    scripts/build-plugin-runner.* for termihub-plugin-runner.exe), so a
    user installs termiHub without first installing the VC++ redistributable.
    The Windows agent binaries are built the same way (#4175: release.yml and
    scripts/build-agents.* add -C target-feature=+crt-static), so the agent the
    desktop deploys over SSH starts on a minimal host (Server Core, a fresh VM).
    If a toolchain or dependency change silently brings back the dynamic runtime,
    the binary would fail to start on a clean machine with "VCRUNTIME140.dll was
    not found". This check makes that a build failure instead.

    It reads the PE import table and the delay-load import table of every .exe and
    .dll it is pointed at, and fails if any of them names a Visual C++ runtime DLL:
    VCRUNTIME*.dll, MSVCP*.dll, CONCRT*.dll, VCOMP*.dll, or any of their debug
    (*D.dll) variants. The Universal CRT (ucrtbase.dll, api-ms-win-crt-*.dll) is
    part of Windows 10 and later and is allowed.

      * -Msi: administrative-extracts the MSI (msiexec /a, no install) and checks
        every .exe/.dll in it;
      * -Nsis: extracts the NSIS setup.exe with 7-Zip (no install) and checks
        every .exe/.dll in it except the NSIS uninstaller stub;
      * -Dir: checks the .exe/.dll files directly in a directory (not its
        subdirectories), e.g. the target/<triple>/release dir of `tauri build`;
      * -Exe: checks the given standalone PE files, e.g. the agent binaries
        (target/<triple>/release/termihub-agent.exe). Every path must exist.

    With -Msi, -Nsis and -Dir, termihub.exe and the bundled plugin runner
    termihub-plugin-runner.exe (#4202) must be among the checked files, so a
    wrong path cannot pass by checking nothing and an installer that dropped the
    runner fails; with -Exe a missing file fails.
    The PE parsing is plain .NET, so -Dir and -Exe also run on macOS and Linux
    with pwsh; -Msi and -Nsis need Windows (msiexec) or 7-Zip.

    Always ends with an explicit exit code: 0 when every check passed, 1 on any
    failure, so a caller can test $LASTEXITCODE (#4207). msiexec's 3010
    (success, reboot required) counts as success.

.PARAMETER Msi
    MSI to check.

.PARAMETER Nsis
    NSIS setup.exe to check.

.PARAMETER Dir
    Directory whose .exe/.dll files to check (instead of -Msi / -Nsis).

.PARAMETER Exe
    One or more standalone PE files to check (instead of -Msi / -Nsis / -Dir).
#>
param(
    [string]$Msi = '',
    [string]$Nsis = '',
    [string]$Dir = '',
    [string[]]$Exe = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# Any terminating error is a failed check with an explicit exit code, never a
# thrown exception that leaves the caller's $LASTEXITCODE as it was (#4207).
trap {
    Write-Output "::error::$($_.Exception.Message)"
    exit 1
}

$Exe = @($Exe | Where-Object { $_ })
$modes = @($Msi, $Nsis, $Dir | Where-Object { $_ }).Count + [int]($Exe.Count -gt 0)
if ($modes -ne 1) {
    Write-Output '::error::pass exactly one of -Msi, -Nsis, -Dir or -Exe'
    exit 1
}

# Visual C++ runtime DLLs that ship only with the redistributable.
$vcRuntimePattern = '^(vcruntime|msvcp|concrt|vcomp|vccorlib)\d+.*\.dll$'

function Get-PeImportedDlls {
    param([string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 0x40 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        throw "not a PE file (no MZ header)"
    }
    $pe = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($pe -lt 0 -or $pe + 24 -gt $bytes.Length -or
        [BitConverter]::ToUInt32($bytes, $pe) -ne 0x00004550) {
        throw "not a PE file (no PE signature)"
    }
    $coff = $pe + 4
    $sectionCount = [BitConverter]::ToUInt16($bytes, $coff + 2)
    $optSize = [BitConverter]::ToUInt16($bytes, $coff + 16)
    $opt = $coff + 20
    $magic = [BitConverter]::ToUInt16($bytes, $opt)
    $dataDirs = switch ($magic) {
        0x10B { $opt + 96 }   # PE32
        0x20B { $opt + 112 }  # PE32+
        default { throw ("unknown optional-header magic 0x{0:X}" -f $magic) }
    }
    $sections = $opt + $optSize

    # Map a relative virtual address to its file offset via the section table.
    $toOffset = {
        param([uint32]$Rva)
        for ($i = 0; $i -lt $sectionCount; $i++) {
            $s = $sections + 40 * $i
            $vsize = [BitConverter]::ToUInt32($bytes, $s + 8)
            $va = [BitConverter]::ToUInt32($bytes, $s + 12)
            $rawSize = [BitConverter]::ToUInt32($bytes, $s + 16)
            $raw = [BitConverter]::ToUInt32($bytes, $s + 20)
            $span = [Math]::Max($vsize, $rawSize)
            if ($Rva -ge $va -and $Rva -lt $va + $span) { return [int64]($Rva - $va + $raw) }
        }
        return [int64]-1
    }
    $readName = {
        param([int64]$Offset)
        if ($Offset -lt 0 -or $Offset -ge $bytes.Length) { return $null }
        $end = $Offset
        while ($end -lt $bytes.Length -and $bytes[$end] -ne 0) { $end++ }
        return [System.Text.Encoding]::ASCII.GetString($bytes, [int]$Offset, [int]($end - $Offset))
    }

    $names = New-Object System.Collections.Generic.List[string]
    # Data directory 1 = import table (20-byte descriptors, name RVA at +12);
    # 13 = delay-load import table (32-byte descriptors, name RVA at +4).
    foreach ($dir in @(@{ Index = 1; Size = 20; NameAt = 12 }, @{ Index = 13; Size = 32; NameAt = 4 })) {
        $entry = $dataDirs + 8 * $dir.Index
        if ($entry + 8 -gt $sections) { continue }
        $rva = [BitConverter]::ToUInt32($bytes, $entry)
        if ($rva -eq 0) { continue }
        $off = & $toOffset $rva
        if ($off -lt 0) { throw "import directory $($dir.Index) points outside every section" }
        while ($off + $dir.Size -le $bytes.Length) {
            $nameRva = [BitConverter]::ToUInt32($bytes, [int]($off + $dir.NameAt))
            if ($nameRva -eq 0) { break }
            $name = & $readName (& $toOffset $nameRva)
            if ($name) { $names.Add($name) }
            $off += $dir.Size
        }
    }
    return , $names
}

# msiexec exit codes that mean success: 0, and 3010 (ERROR_SUCCESS_REBOOT_REQUIRED).
$msiexecOk = @(0, 3010)

$extract = $null
$files = @()
$failed = 0
try {
    if ($Msi -or $Nsis) {
        $extract = Join-Path ([System.IO.Path]::GetTempPath()) ("bundle-" + [System.Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $extract | Out-Null
        if ($Msi) {
            $source = [System.IO.Path]::GetFullPath($Msi)
            $log = Join-Path $extract 'admin-extract.log'
            # Start-Process does not set $LASTEXITCODE; read the code off the process.
            $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
                '/a', "`"$source`"", '/qn', "TARGETDIR=`"$extract`"", '/l*v', "`"$log`""
            )
            $code = $p.ExitCode
            $ok = $null -ne $code -and $msiexecOk -contains $code
        } else {
            $source = [System.IO.Path]::GetFullPath($Nsis)
            & 7z x -y "-o$extract" $source | Out-Null
            $code = $LASTEXITCODE
            $ok = $code -eq 0
        }
        if (-not $ok) {
            Write-Output "::error::extracting $source failed with exit code $code"
            exit 1
        }
        # The MSI admin image also holds a copy of the .msi itself; skip it, and
        # skip 7-Zip's $PLUGINSDIR (NSIS's own installer plugins, not installed).
        $files = @(Get-ChildItem -LiteralPath $extract -Recurse -File |
            Where-Object { $_.Extension -in '.exe', '.dll' -and $_.FullName -notmatch '[\\/]\$PLUGINSDIR[\\/]' })
    } elseif ($Exe.Count -gt 0) {
        foreach ($path in $Exe) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                Write-Output "::error::$path does not exist"
                exit 1
            }
        }
        $files = @($Exe | ForEach-Object { Get-Item -LiteralPath $_ })
    } else {
        $files = @(Get-ChildItem -LiteralPath $Dir -File |
            Where-Object { $_.Extension -in '.exe', '.dll' })
    }

    if ($Exe.Count -eq 0) {
        foreach ($required in 'termihub.exe', 'termihub-plugin-runner.exe') {
            if (-not ($files | Where-Object { $_.Name -eq $required })) {
                Write-Output "::error::$required is not among the checked files ($($Msi + $Nsis + $Dir))"
                exit 1
            }
        }
    }

    Write-Output "Checking $($files.Count) PE file(s) for a Visual C++ runtime dependency"
    foreach ($f in $files) {
        try {
            $imports = Get-PeImportedDlls -Path $f.FullName
        } catch {
            Write-Output "::error::$($f.Name): cannot read the import table: $_"
            $failed++
            continue
        }
        $bad = @($imports | Where-Object { $_ -match $vcRuntimePattern } | Sort-Object -Unique)
        if ($bad.Count -gt 0) {
            Write-Output "::error::$($f.Name) imports $($bad -join ', ') (needs the VC++ redistributable)"
            $failed++
        } else {
            Write-Output "  ok  $($f.Name)  ($($imports.Count) imported DLLs, no VC++ runtime)"
        }
    }
} finally {
    if ($extract) { Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failed -gt 0) { exit 1 }
Write-Output 'No shipped binary depends on the Visual C++ redistributable.'
# Always end with an explicit exit code (#4207): a script that just falls off the
# end leaves the caller's $LASTEXITCODE untouched -- $null in a fresh pwsh step
# (Start-Process and the pure-.NET PE parsing set none), and `$null -ne 0` is
# true, so the workflow's `if ($LASTEXITCODE -ne 0) { exit 1 }` failed a passing check.
exit 0
