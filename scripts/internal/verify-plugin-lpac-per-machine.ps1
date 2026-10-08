<#
.SYNOPSIS
    Prove a native plugin loads in its LPAC through a per-machine install's
    runner, as a standard user (#4252).

.DESCRIPTION
    The host grants each plugin's AppContainer read + execute on the runner
    executable and its folder. Under C:\Program Files a standard user cannot
    rewrite that ACL, so the grant is refused and the runner must start
    through the install folder's inherited "ALL RESTRICTED APPLICATION
    PACKAGES" entry. This script checks that for real, after the MSI has been
    installed (by an administrator, per-machine):

      1. logs the ACL of the installed runner and its folder and requires an
         "ALL RESTRICTED APPLICATION PACKAGES" (S-1-15-2-2) read + execute
         entry on both;
      2. stages the harness (the ignored test core/tests/plugin_runner_installed.rs,
         built with `cargo test --no-run`) and a prebuilt echo_backend.dll in a
         folder the test user can read;
      3. creates a throw-away local user that is a member of Users only;
      4. runs the harness as that user (its own profile loaded, its own TEMP)
         against the installed runner and requires the one test to pass;
      5. requires the runner and its folder to carry no per-plugin
         AppContainer entry afterwards (the grant really was refused, nothing
         leaked into Program Files);
      6. deletes the user, its profile and the staging folder.

    Windows only; must run elevated (it creates a local user). Always ends with
    an explicit exit code: 0 when every check passed, 1 on any failure.

    -SelfTest runs only the ACL-classification checks on fixed SDDL strings
    (no user, no install, no elevation). It still needs Windows: .NET's
    security-descriptor classes throw elsewhere.

.PARAMETER InstallDir
    The per-machine install folder (holds termihub-plugin-runner.exe).

.PARAMETER Harness
    The plugin_runner_installed test executable.

.PARAMETER EchoLib
    A prebuilt echo_backend.dll.

.PARAMETER OutDir
    Where the harness output and ACL logs are written.

.PARAMETER SelfTest
    Run the offline checks of this script's ACL logic and exit.
#>
param(
    [string]$InstallDir = '',
    [string]$Harness = '',
    [string]$EchoLib = '',
    [string]$OutDir = '',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# Any terminating error is a failed check with an explicit exit code (#4207).
trap {
    Write-Output "::error::$($_.Exception.Message)"
    exit 1
}

$TestName = 'echo_backend_loads_in_its_lpac_from_a_per_machine_install'
# ALL RESTRICTED APPLICATION PACKAGES: the only package group an LPAC is in.
$AllRestrictedPackages = 'S-1-15-2-2'
# FILE_GENERIC_READ | FILE_GENERIC_EXECUTE.
$ReadExecute = 0x1200A9

# Whether an SDDL DACL grants $Sid at least read + execute (an allow ACE).
function Test-SddlGrants([string]$Sddl, [string]$Sid) {
    $sd = New-Object System.Security.AccessControl.RawSecurityDescriptor($Sddl)
    foreach ($ace in $sd.DiscretionaryAcl) {
        if ($ace.AceType -ne [System.Security.AccessControl.AceType]::AccessAllowed) { continue }
        if ($ace.SecurityIdentifier.Value -ne $Sid) { continue }
        # An inherit-only entry applies to children, not to this object.
        if ($ace.AceFlags -band [System.Security.AccessControl.AceFlags]::InheritOnly) { continue }
        if (($ace.AccessMask -band $ReadExecute) -eq $ReadExecute) { return $true }
    }
    return $false
}

# The per-app AppContainer SIDs (S-1-15-2-<7 sub-authorities>) in an SDDL
# DACL: what the host's grant would have added. The two package groups
# (S-1-15-2-1, S-1-15-2-2) are not per-app and are not counted.
function Get-SddlAppContainerSids([string]$Sddl) {
    $sd = New-Object System.Security.AccessControl.RawSecurityDescriptor($Sddl)
    $sids = @()
    foreach ($ace in $sd.DiscretionaryAcl) {
        $sid = $ace.SecurityIdentifier.Value
        if ($sid -like 'S-1-15-2-*' -and $sid -ne 'S-1-15-2-1' -and $sid -ne $AllRestrictedPackages) {
            $sids += $sid
        }
    }
    return , $sids
}

if ($SelfTest) {
    # A Program Files-like DACL: Administrators, Users, both package groups.
    $pf = 'D:(A;;FA;;;BA)(A;;0x1200a9;;;BU)(A;;0x1200a9;;;S-1-15-2-1)(A;;0x1200a9;;;S-1-15-2-2)'
    # The same plus a per-plugin AppContainer grant.
    $granted = $pf + '(A;;0x1200a9;;;S-1-15-2-1-2-3-4-5-6-7)'
    # Package group with read only (no execute).
    $readOnly = 'D:(A;;0x120089;;;S-1-15-2-2)'
    # Inherit-only: reaches children but not the object itself.
    $inheritOnly = 'D:(A;OICIIO;0x1200a9;;;S-1-15-2-2)'
    $failures = 0
    $cases = @(
        @{ Name = 'program-files grants the LPAC group'; Got = (Test-SddlGrants $pf $AllRestrictedPackages); Want = $true },
        @{ Name = 'read-only entry is not enough'; Got = (Test-SddlGrants $readOnly $AllRestrictedPackages); Want = $false },
        @{ Name = 'an inherit-only entry is not enough'; Got = (Test-SddlGrants $inheritOnly $AllRestrictedPackages); Want = $false },
        @{ Name = 'no per-app SID in program files'; Got = ((Get-SddlAppContainerSids $pf).Count); Want = 0 },
        @{ Name = 'a per-plugin grant is found'; Got = ((Get-SddlAppContainerSids $granted).Count); Want = 1 }
    )
    foreach ($c in $cases) {
        if ($c.Got -eq $c.Want) {
            Write-Output "ok: $($c.Name)"
        } else {
            Write-Output "FAIL: $($c.Name) (got $($c.Got), want $($c.Want))"
            $failures++
        }
    }
    if ($failures -gt 0) { exit 1 }
    Write-Output 'self-test passed'
    exit 0
}

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
    throw 'this check runs on Windows only (use -SelfTest elsewhere)'
}
foreach ($p in @('InstallDir', 'Harness', 'EchoLib', 'OutDir')) {
    if (-not (Get-Variable -Name $p -ValueOnly)) { throw "pass -$p" }
}
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'run elevated: creating the test user needs an administrator'
}

$InstallDir = $InstallDir.TrimEnd('\')
$runner = Join-Path $InstallDir 'termihub-plugin-runner.exe'
foreach ($f in @($runner, $Harness, $EchoLib)) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "not found: $f" }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 1. The install's ACL must already admit an LPAC.
foreach ($path in @($runner, $InstallDir)) {
    $acl = Get-Acl -LiteralPath $path
    Write-Output "ACL of ${path}:"
    (& icacls.exe $path) | ForEach-Object { Write-Output "  $_" }
    $acl.Sddl | Out-File -Append -Encoding utf8 (Join-Path $OutDir 'acl-before.txt')
    if (-not (Test-SddlGrants $acl.Sddl $AllRestrictedPackages)) {
        throw "$path grants ALL RESTRICTED APPLICATION PACKAGES no read + execute; an LPAC cannot start the runner"
    }
}

# 2. Stage the harness where the test user can read it.
$stage = Join-Path $env:SystemDrive 'termihub-lpac-harness'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stage
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$stagedHarness = Join-Path $stage 'plugin_runner_installed.exe'
$stagedLib = Join-Path $stage 'echo_backend.dll'
Copy-Item -LiteralPath $Harness -Destination $stagedHarness
Copy-Item -LiteralPath $EchoLib -Destination $stagedLib
$userOut = Join-Path $stage 'out'
New-Item -ItemType Directory -Force -Path $userOut | Out-Null
& icacls.exe $userOut /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null

# The user-side wrapper: its own TEMP (the inherited one is the admin's), the
# harness env, and the result written to files the admin side reads back.
$inner = Join-Path $stage 'run-as-user.ps1'
@'
param([string]$Runner, [string]$Lib, [string]$Exe, [string]$Test, [string]$Out)
$ErrorActionPreference = 'Stop'
try {
    # Start-Process -Credential hands this process the caller's environment,
    # so every profile path in it is the administrator's: rebuild them from
    # this user's own profile (by SID, from the profile list).
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
    $userProfile = (Get-ItemProperty -LiteralPath $profileKey).ProfileImagePath
    $env:USERPROFILE = $userProfile
    $env:APPDATA = Join-Path $userProfile 'AppData\Roaming'
    $env:LOCALAPPDATA = Join-Path $userProfile 'AppData\Local'
    $temp = Join-Path $env:LOCALAPPDATA 'Temp'
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    $env:TEMP = $temp
    $env:TMP = $temp
    $env:TERMIHUB_INSTALLED_RUNNER = $Runner
    $env:TERMIHUB_ECHO_BACKEND_LIB = $Lib
    $env:RUST_BACKTRACE = '1'
    $env:RUST_LOG = 'debug'
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $admin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    "user: $($id.Name) administrator: $admin temp: $temp" |
        Out-File -Encoding utf8 (Join-Path $Out 'identity.txt')
    & whoami.exe /groups | Out-File -Append -Encoding utf8 (Join-Path $Out 'identity.txt')
    & $Exe --ignored --exact $Test --nocapture --test-threads=1 *> (Join-Path $Out 'harness.log')
    $LASTEXITCODE | Out-File -Encoding ascii (Join-Path $Out 'exit-code.txt')
} catch {
    "$_" | Out-File -Encoding utf8 (Join-Path $Out 'wrapper-error.txt')
    'wrapper-error' | Out-File -Encoding ascii (Join-Path $Out 'exit-code.txt')
}
'@ | Out-File -Encoding utf8 $inner

# 3. A throw-away standard user (Users only).
$userName = 'thlpac' + (Get-Random -Minimum 10000 -Maximum 99999)
$chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
$plain = -join (1..24 | ForEach-Object { $chars | Get-Random }) + '#9aA'
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
$failed = $false
$userSid = $null
try {
    $user = New-LocalUser -Name $userName -Password $secure -AccountNeverExpires `
        -PasswordNeverExpires -Description 'termiHub LPAC per-machine check (#4252)'
    $userSid = $user.SID.Value
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $userName
    $admins = Get-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-544') |
        Where-Object { $_.SID.Value -eq $userSid }
    if ($admins) { throw "$userName is an administrator" }
    Write-Output "test user: $userName ($userSid), member of Users only"

    # 4. Run the harness as that user, with its profile loaded (the
    # AppContainer profile lives in the user's registry hive). Start-Process
    # joins -ArgumentList with spaces unquoted, so every argument is quoted
    # (the install dir is under "Program Files").
    $cred = New-Object System.Management.Automation.PSCredential(".\$userName", $secure)
    $shell = (Get-Process -Id $PID).Path
    $p = Start-Process -FilePath $shell -Credential $cred -LoadUserProfile -PassThru -Wait `
        -WorkingDirectory $stage `
        -RedirectStandardOutput (Join-Path $OutDir 'user-stdout.log') `
        -RedirectStandardError (Join-Path $OutDir 'user-stderr.log') `
        -ArgumentList (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', $inner, '-Runner', $runner, '-Lib', $stagedLib, '-Exe', $stagedHarness,
            '-Test', $TestName, '-Out', $userOut) | ForEach-Object { "`"$_`"" })
    Write-Output "user process exited with $($p.ExitCode)"
    Copy-Item -Path (Join-Path $userOut '*') -Destination $OutDir -ErrorAction SilentlyContinue

    foreach ($f in @('identity.txt', 'wrapper-error.txt', 'harness.log')) {
        $path = Join-Path $OutDir $f
        if (Test-Path -LiteralPath $path) {
            Write-Output "----- $f -----"
            Get-Content -LiteralPath $path | ForEach-Object { Write-Output $_ }
        }
    }
    $codeFile = Join-Path $OutDir 'exit-code.txt'
    if (-not (Test-Path -LiteralPath $codeFile)) {
        throw 'the harness never ran as the test user (no exit-code.txt)'
    }
    if (Test-Path -LiteralPath (Join-Path $OutDir 'wrapper-error.txt')) {
        throw 'the user-side wrapper failed (see wrapper-error.txt above)'
    }
    $identity = Get-Content -Raw -LiteralPath (Join-Path $OutDir 'identity.txt')
    if ($identity -notmatch [regex]::Escape($userName) -or $identity -notmatch 'administrator: False') {
        throw 'the harness did not run as the non-administrator test user'
    }
    $code = (Get-Content -Raw -LiteralPath $codeFile).Trim()
    if ($code -ne '0') { throw "the harness failed as the standard user (exit $code)" }
    $log = Get-Content -Raw -LiteralPath (Join-Path $OutDir 'harness.log')
    # Guard against a filter that matched nothing ("0 passed" is also exit 0).
    if ($log -notmatch 'test result: ok\. 1 passed') {
        throw 'the harness did not run exactly one passing test'
    }
    Write-Output 'echo-backend loaded and echoed in its LPAC through the installed runner'

    # 5. Nothing leaked into the install's ACL.
    foreach ($path in @($runner, $InstallDir)) {
        $sddl = (Get-Acl -LiteralPath $path).Sddl
        $sddl | Out-File -Append -Encoding utf8 (Join-Path $OutDir 'acl-after.txt')
        $leaked = Get-SddlAppContainerSids $sddl
        if ($leaked.Count -gt 0) {
            throw "$path gained per-plugin AppContainer entries: $($leaked -join ', ')"
        }
    }
    Write-Output 'the install ACL is unchanged (the per-plugin grant was refused, as expected)'
} catch {
    Write-Output "::error::$($_.Exception.Message)"
    $failed = $true
} finally {
    # 6. Clean up the user, its profile and the staging folder.
    if ($userSid) {
        Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
            Where-Object { $_.SID -eq $userSid } |
            Remove-CimInstance -ErrorAction SilentlyContinue
    }
    Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stage
}
if ($failed) { exit 1 }
exit 0
