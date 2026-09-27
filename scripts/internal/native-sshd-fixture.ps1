#Requires -Version 7.0
<#
.SYNOPSIS
    Native loopback Win32-OpenSSH fixture for the SSH/SFTP live suites (CI-020, TIN-007).

.DESCRIPTION
    Windows twin of native-sshd-fixture.sh (which forwards here from Git Bash).
    The Docker SSH fixtures only run on Linux; this stands up Windows' own
    OpenSSH server so the sshd-only journeys (core/tests/ssh_native.rs and the
    agent reconnect UI grade) run on the windows runner too.

    Unlike macOS/Linux, Win32-OpenSSH cannot run unprivileged: it must run as
    LocalSystem to log a user on. So `up` (elevated shell required, as on the
    GitHub windows runner):
      * uses the preinstalled %WINDIR%\System32\OpenSSH\sshd.exe, or installs
        the OpenSSH.Server Windows capability when it is absent;
      * creates a dedicated local test user (termihubssh, random password,
        key auth only) -- the system `sshd` service and its config are never
        touched;
      * writes a temporary ed25519 host key, an ed25519 client key and an
        authorized_keys (the repo's tests/fixtures/ssh-keys set + the client
        key) under -Dir with the ACLs Win32-OpenSSH's StrictModes demands;
      * registers a scheduled task (termihub-native-sshd) that runs
        `sshd.exe -D -f <config>` as SYSTEM on 127.0.0.1:<port> -- no Windows
        service, so the SCM's service-start handshake is out of the picture --
        starts it, and proves a real ssh.exe login + sftp subsystem;
      * prints `export NAME='value'` lines (POSIX form, for the Git Bash
        wrapper to eval) and, with -GitHubEnv, appends NAME=value to $GITHUB_ENV:
        TERMIHUB_NATIVE_SSHD=1, _PORT, _USER, _KEY, _HOST_PUBKEY, _DIR and,
        with -AgentBinary, _AGENT_BIN (a copy the test user can execute).

    stop / start take the listener down and bring it back (state kept); stop
    also ends the sessions the fixture's sshd spawned. down removes the
    task, the test user and its profile, and the state dir. On any start or
    self-test failure the sshd log, `sshd -t`, the task result and the
    OpenSSH event log are printed so CI shows the real cause.

    This script cannot be exercised off Windows; it is first verified by the
    nightly native-sshd jobs (integration-fixtures.yml, system-integration.yml).

.EXAMPLE
    pwsh -File scripts/internal/native-sshd-fixture.ps1 -Action up -GitHubEnv
.EXAMPLE
    pwsh -File scripts/internal/native-sshd-fixture.ps1 -Action down
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('up', 'start', 'stop', 'env', 'down')]
    [string]$Action,

    [string]$Dir = (Join-Path $env:ProgramData 'termihub-native-sshd'),

    [int]$Port = 0,

    [switch]$GitHubEnv,

    [string]$AgentBinary = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'termihub-native-sshd'
# Earlier revisions ran a service under this name; down still removes one.
$LegacyServiceName = 'termihub-native-sshd'
$TestUser = 'termihubssh'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$OpenSshDir = Join-Path $env:WINDIR 'System32\OpenSSH'

$HostKey = Join-Path $Dir 'host_ed25519_key'
$ClientKey = Join-Path $Dir 'client_ed25519_key'
$AuthKeys = Join-Path $Dir 'authorized_keys'
$Config = Join-Path $Dir 'sshd_config'
$LogFile = Join-Path $Dir 'sshd.log'
$PortFile = Join-Path $Dir 'port'
$AgentCopy = Join-Path $Dir 'agent\termihub-agent.exe'

# Well-known SIDs, so the ACLs do not depend on the OS display language.
$SidSystem = '*S-1-5-18'
$SidAdmins = '*S-1-5-32-544'

function Write-FixtureLog([string]$Message) {
    # stdout carries only the eval-able exports; progress goes to stderr.
    [Console]::Error.WriteLine("native-sshd: $Message")
}

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'native-sshd-fixture.ps1 needs an elevated (Administrator) shell'
    }
}

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Install-OpenSshServer {
    # Win32-OpenSSH runs its pre-auth worker as the `NT SERVICE\sshd` virtual
    # account, which exists only while the system `sshd` service is registered.
    # So require both the binary and that service (left stopped and untouched:
    # this fixture runs its own sshd with its own config).
    $sshd = Join-Path $OpenSshDir 'sshd.exe'
    if ((Test-Path -LiteralPath $sshd) -and (Get-Service -Name 'sshd' -ErrorAction SilentlyContinue)) {
        Write-FixtureLog "using preinstalled $sshd"
        return
    }
    Write-FixtureLog 'OpenSSH server not (fully) installed; adding the OpenSSH.Server capability'
    $capability = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } |
        Select-Object -First 1
    if ($null -eq $capability) {
        throw 'the OpenSSH.Server Windows capability is not offered on this host'
    }
    if ($capability.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name $capability.Name | Out-Null
    }
    if (-not (Test-Path -LiteralPath $sshd) -or -not (Get-Service -Name 'sshd' -ErrorAction SilentlyContinue)) {
        throw "OpenSSH.Server installed but $sshd or the sshd service is still missing"
    }
}

function Invoke-SshKeygen([string]$Path, [string]$Comment) {
    # Start-Process with one argument string: an empty `-N ""` passphrase
    # survives on every PowerShell version (a bare '' arg is dropped by 5.1).
    $keygen = Join-Path $OpenSshDir 'ssh-keygen.exe'
    $argLine = "-q -t ed25519 -N `"`" -C $Comment -f `"$Path`""
    $proc = Start-Process -FilePath $keygen -ArgumentList $argLine -Wait -NoNewWindow -PassThru
    if ($proc.ExitCode -ne 0) {
        throw "ssh-keygen failed for $Path (exit $($proc.ExitCode))"
    }
}

function Protect-FixtureFile([string]$Path, [string[]]$Grants) {
    # Owner Administrators, inheritance off, exactly the listed grants: what
    # Win32-OpenSSH's permission check accepts for keys and authorized_keys.
    $adminsName = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544').Translate(
        [Security.Principal.NTAccount]).Value
    Invoke-Native 'icacls.exe' @($Path, '/setowner', $adminsName, '/Q')
    Invoke-Native 'icacls.exe' (@($Path, '/inheritance:r', '/Q') + ($Grants | ForEach-Object { @('/grant:r', $_) }))
    # /grant:r leaves other explicit ACEs alone -- notably the one ssh-keygen
    # gives its creator (runneradmin on CI), which sshd running as SYSTEM
    # rejects ("Bad permissions ... host key"). Strip every ACE not granted.
    $allowed = @($Grants | ForEach-Object {
            $who = ($_ -split ':')[0]
            if ($who.StartsWith('*')) {
                $who.Substring(1)
            } else {
                [Security.Principal.NTAccount]::new($who).Translate([Security.Principal.SecurityIdentifier]).Value
            }
        })
    $acl = Get-Acl -LiteralPath $Path
    $extra = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) |
            ForEach-Object { $_.IdentityReference.Value } | Where-Object { $allowed -notcontains $_ } |
            Select-Object -Unique)
    foreach ($sid in $extra) {
        Invoke-Native 'icacls.exe' @($Path, '/remove', "*$sid", '/Q')
    }
}

function Get-TestUserSid {
    try {
        $account = [Security.Principal.NTAccount]::new($TestUser)
        return $account.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $null
    }
}

function Initialize-TestUser {
    $bytes = [byte[]]::new(16)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    # Hex plus a fixed prefix: meets complexity rules, and holds no `/` that
    # net.exe would read as a switch. Key auth only; the password is never used
    # or exported. `/y` answers net.exe's ">14 characters" confirmation prompt.
    $password = 'Tn!' + ([BitConverter]::ToString($bytes) -replace '-', '')
    if ($null -ne (Get-TestUserSid)) {
        Invoke-Native 'net.exe' @('user', $TestUser, $password, '/y') | Out-Null
    } else {
        Invoke-Native 'net.exe' @('user', $TestUser, $password, '/add', '/expires:never', '/y') | Out-Null
    }
    Write-FixtureLog "local test user $TestUser ready"
}

function Unregister-TestUser {
    $sid = Get-TestUserSid
    if ($null -eq $sid) {
        return
    }
    & net.exe user $TestUser /delete | Out-Null
    Get-CimInstance -ClassName Win32_UserProfile | Where-Object { $_.SID -eq $sid } |
        Remove-CimInstance -ErrorAction SilentlyContinue
    Write-FixtureLog "local test user $TestUser removed"
}

function Test-Listening([int]$TcpPort) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync('127.0.0.1', $TcpPort)
        return ($task.Wait(500) -and $client.Connected)
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Wait-Listening([int]$TcpPort, [bool]$Up) {
    for ($i = 0; $i -lt 150; $i++) {
        if ((Test-Listening $TcpPort) -eq $Up) {
            return $true
        }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

function Get-FreePort {
    # Below every ephemeral range, offset per checkout like the .sh twin.
    $offset = 0
    if ($env:TERMIHUB_TEST_PORT_OFFSET) {
        $offset = [int]$env:TERMIHUB_TEST_PORT_OFFSET
    }
    $base = 22400 + $offset
    for ($candidate = $base; $candidate -lt $base + 50; $candidate++) {
        if (-not (Test-Listening $candidate)) {
            return $candidate
        }
    }
    throw "no free loopback port in $base..$($base + 49)"
}

function Write-SshdConfig([int]$TcpPort) {
    $fwd = { param($p) $p -replace '\\', '/' }
    $lines = @(
        '# Generated by scripts/internal/native-sshd-fixture.ps1 -- test-only, loopback.'
        "Port $TcpPort"
        'ListenAddress 127.0.0.1'
        "HostKey $(& $fwd $HostKey)"
        "AuthorizedKeysFile $(& $fwd $AuthKeys)"
        'PubkeyAuthentication yes'
        'PasswordAuthentication no'
        'AllowTcpForwarding yes'
        "AllowUsers $TestUser"
        'Subsystem sftp sftp-server.exe'
        'LogLevel VERBOSE'
        '# The suites open many sessions at once; lift the 10-startup default.'
        'MaxStartups 200:30:300'
        'MaxSessions 100'
    )
    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($Config, (($lines -join "`n") + "`n"), $utf8NoBom)

    # OpenSSH 9.8+ penalises a source after failed auths, which the rejection
    # tests cause on purpose; older sshd rejects the keyword, so probe it.
    $withPenalties = ($lines + 'PerSourcePenalties no') -join "`n"
    [IO.File]::WriteAllText($Config, $withPenalties + "`n", $utf8NoBom)
    & (Join-Path $OpenSshDir 'sshd.exe') -t -f $Config 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        [IO.File]::WriteAllText($Config, (($lines -join "`n") + "`n"), $utf8NoBom)
    }
}

function Get-FixtureSshdProcess {
    # Every sshd process started with the fixture config (the master and, on
    # Win32-OpenSSH builds that re-exec sshd.exe per connection, its children).
    $needle = $Config.ToLowerInvariant()
    @(Get-CimInstance -ClassName Win32_Process -Filter "Name='sshd.exe'" |
            Where-Object { $null -ne $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) })
}

function Get-SshdMasterPid {
    # The listener: a fixture sshd whose parent is not itself a fixture sshd.
    $procs = Get-FixtureSshdProcess
    $pids = @($procs | ForEach-Object { [int]$_.ProcessId })
    $master = $procs | Where-Object { $pids -notcontains [int]$_.ParentProcessId } | Select-Object -First 1
    if ($null -eq $master) {
        return $null
    }
    return [int]$master.ProcessId
}

function Get-SshdDescendantPid([int]$RootPid) {
    # sshd / sshd-session processes below $RootPid, collected by parent PID
    # (never by name alone), so another sshd on the host is never touched.
    $all = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Name -like 'sshd*' })
    $found = [Collections.Generic.List[int]]::new()
    $frontier = @($RootPid)
    while ($frontier.Count -gt 0) {
        $next = @($all | Where-Object { $frontier -contains [int]$_.ParentProcessId } |
                ForEach-Object { [int]$_.ProcessId } | Where-Object { -not $found.Contains($_) })
        foreach ($child in $next) {
            $found.Add($child)
        }
        $frontier = $next
    }
    return , $found.ToArray()
}

function Show-SshdDiagnostic {
    # Best effort: never let a diagnostics hiccup mask the original failure.
    try {
        Write-SshdDiagnostic
    } catch {
        Write-FixtureLog "diagnostics failed: $($_.Exception.Message)"
    }
}

function Write-SshdDiagnostic {
    Write-FixtureLog '---- diagnostics ----'
    if (Test-Path -LiteralPath $LogFile) {
        Write-FixtureLog "sshd log ($LogFile, last 80 lines):"
        Get-Content -LiteralPath $LogFile -Tail 80 | ForEach-Object { Write-FixtureLog "  | $_" }
    } else {
        Write-FixtureLog "no sshd log at $LogFile"
    }
    if (Test-Path -LiteralPath $Config) {
        Write-FixtureLog "sshd -t -f $Config (as $([Environment]::UserName)):"
        $out = & (Join-Path $OpenSshDir 'sshd.exe') -t -f $Config 2>&1 | Out-String
        Write-FixtureLog "  exit $LASTEXITCODE"
        $out -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Write-FixtureLog "  | $_" }
    }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-FixtureLog ("task {0}: state {1}, last result 0x{2:X8}, last run {3}" -f
            $TaskName, $task.State, $info.LastTaskResult, $info.LastRunTime)
    }
    Get-FixtureSshdProcess | ForEach-Object {
        Write-FixtureLog "  process $($_.ProcessId) (parent $($_.ParentProcessId)): $($_.CommandLine)"
    }
    try {
        Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 15 -ErrorAction Stop |
            Sort-Object TimeCreated | ForEach-Object {
                Write-FixtureLog "  event $($_.TimeCreated.ToString('HH:mm:ss')) [$($_.LevelDisplayName)] $($_.Message)"
            }
    } catch {
        Write-FixtureLog "  (no OpenSSH/Operational events: $($_.Exception.Message))"
    }
    Write-FixtureLog '---- end diagnostics ----'
}

function Register-SshdTask {
    # A scheduled task, not a service: it runs sshd.exe in plain foreground
    # mode (-D) as SYSTEM -- SYSTEM is what lets Win32-OpenSSH log another
    # user on -- with no service-control handshake to fail.
    $sshd = Join-Path $OpenSshDir 'sshd.exe'
    $action = New-ScheduledTaskAction -Execute $sshd -Argument "-D -f `"$Config`" -E `"$LogFile`""
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings `
        -Description 'termiHub native sshd test fixture' -Force | Out-Null
}

function Resume-Fixture {
    $tcpPort = [int](Get-Content -LiteralPath $PortFile)
    try {
        Start-ScheduledTask -TaskName $TaskName
    } catch {
        Show-SshdDiagnostic
        throw
    }
    $graceEnd = [DateTime]::UtcNow.AddSeconds(3)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Listening $tcpPort)) {
        # sshd exits at once on a config / host key error: fail fast then
        # (after a short grace, while the task may still be spawning it).
        $state = (Get-ScheduledTask -TaskName $TaskName).State
        $gone = [DateTime]::UtcNow -gt $graceEnd -and $state -ne 'Running' -and $null -eq (Get-SshdMasterPid)
        if ($gone -or [DateTime]::UtcNow -gt $deadline) {
            Show-SshdDiagnostic
            throw "sshd did not listen on 127.0.0.1:$tcpPort (task state $state)"
        }
        Start-Sleep -Milliseconds 200
    }
    Write-FixtureLog "sshd listening on 127.0.0.1:$tcpPort (pid $(Get-SshdMasterPid), task $TaskName)"
}

function Suspend-Fixture {
    # The master and every sshd it spawned (collected before the master goes),
    # so an established session is severed along with the listener.
    $victims = @()
    $masterPid = Get-SshdMasterPid
    if ($null -ne $masterPid) {
        $victims = @(Get-SshdDescendantPid $masterPid) + @($masterPid)
    }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    foreach ($victim in $victims) {
        $proc = Get-Process -Id $victim -ErrorAction SilentlyContinue
        if ($null -ne $proc -and $proc.ProcessName -like 'sshd*') {
            Stop-Process -Id $victim -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $PortFile) {
        $tcpPort = [int](Get-Content -LiteralPath $PortFile)
        if (-not (Wait-Listening $tcpPort $false)) {
            throw "sshd still listening on 127.0.0.1:$tcpPort after stop"
        }
    }
}

function Test-Fixture([int]$TcpPort) {
    $ssh = Join-Path $OpenSshDir 'ssh.exe'
    $opts = @('-i', $ClientKey, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'LogLevel=ERROR',
        '-o', 'ConnectTimeout=15')
    $who = (& $ssh -p $TcpPort @opts "$TestUser@127.0.0.1" whoami | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $who -notlike "*\$TestUser") {
        Show-SshdDiagnostic
        throw "ssh login as $TestUser on 127.0.0.1:$TcpPort failed (exit $LASTEXITCODE, whoami '$who'); log: $LogFile"
    }
    $sftp = Join-Path $OpenSshDir 'sftp.exe'
    'pwd' | & $sftp -b - -P $TcpPort @opts "$TestUser@127.0.0.1" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Show-SshdDiagnostic
        throw "sftp subsystem on 127.0.0.1:$TcpPort failed (exit $LASTEXITCODE); log: $LogFile"
    }
    Write-FixtureLog "self-test ok: ssh + sftp as $TestUser on 127.0.0.1:$TcpPort"
}

function Write-FixtureEnvironment([bool]$ToGitHubEnv) {
    $vars = [ordered]@{
        TERMIHUB_NATIVE_SSHD             = '1'
        TERMIHUB_NATIVE_SSHD_PORT        = (Get-Content -LiteralPath $PortFile).Trim()
        TERMIHUB_NATIVE_SSHD_USER        = $TestUser
        TERMIHUB_NATIVE_SSHD_KEY         = $ClientKey
        TERMIHUB_NATIVE_SSHD_HOST_PUBKEY = "$HostKey.pub"
        TERMIHUB_NATIVE_SSHD_DIR         = $Dir
    }
    if (Test-Path -LiteralPath $AgentCopy) {
        $vars['TERMIHUB_NATIVE_SSHD_AGENT_BIN'] = $AgentCopy
    }
    foreach ($name in $vars.Keys) {
        Write-Output "export $name='$($vars[$name])'"
    }
    if ($ToGitHubEnv) {
        if (-not $env:GITHUB_ENV) {
            throw '-GitHubEnv given but GITHUB_ENV is not set'
        }
        $vars.Keys | ForEach-Object { "$_=$($vars[$_])" } |
            Add-Content -LiteralPath $env:GITHUB_ENV -Encoding utf8
    }
}

function Invoke-Up([int]$ListenPort, [string]$AgentSource, [bool]$ToGitHubEnv) {
    Assert-Admin
    if ((Test-Path -LiteralPath $Dir) -or (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) -or
        (Get-Service -Name $LegacyServiceName -ErrorAction SilentlyContinue)) {
        Write-FixtureLog 'previous fixture found; tearing it down first'
        Invoke-Down
    }
    Install-OpenSshServer
    Initialize-TestUser

    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    # The test user may read/execute inside (the agent copy); keys are tightened below.
    Invoke-Native 'icacls.exe' @($Dir, '/inheritance:r', '/Q',
        '/grant:r', "${SidSystem}:(OI)(CI)F", '/grant:r', "${SidAdmins}:(OI)(CI)F",
        '/grant:r', "${TestUser}:(OI)(CI)RX")

    Invoke-SshKeygen $HostKey 'termihub-native-sshd-host'
    Invoke-SshKeygen $ClientKey 'termihub-native-sshd-client'
    $fixtureKeys = Get-Content -LiteralPath (Join-Path $RepoRoot 'tests\fixtures\ssh-keys\authorized_keys')
    $clientPub = Get-Content -LiteralPath "$ClientKey.pub"
    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($AuthKeys, ((@($fixtureKeys) + @($clientPub)) -join "`n") + "`n", $utf8NoBom)

    Protect-FixtureFile $HostKey @("${SidSystem}:F", "${SidAdmins}:F")
    Protect-FixtureFile $ClientKey @("${SidSystem}:F", "${SidAdmins}:F", "$([Environment]::UserName):F")
    Protect-FixtureFile $AuthKeys @("${SidSystem}:F", "${SidAdmins}:F", "${TestUser}:R")

    if ($AgentSource) {
        New-Item -ItemType Directory -Path (Split-Path $AgentCopy) -Force | Out-Null
        Copy-Item -LiteralPath $AgentSource -Destination $AgentCopy -Force
    }

    if ($ListenPort -eq 0) {
        $ListenPort = Get-FreePort
    }
    Set-Content -LiteralPath $PortFile -Value $ListenPort -Encoding ascii
    Write-SshdConfig $ListenPort

    Register-SshdTask
    Resume-Fixture
    Test-Fixture $ListenPort
    Write-FixtureEnvironment $ToGitHubEnv
}

function Invoke-Down {
    Assert-Admin
    Suspend-Fixture
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    if (Get-Service -Name $LegacyServiceName -ErrorAction SilentlyContinue) {
        Stop-Service -Name $LegacyServiceName -Force -ErrorAction SilentlyContinue
        Invoke-Native 'sc.exe' @('delete', $LegacyServiceName) | Out-Null
    }
    Unregister-TestUser
    if (Test-Path -LiteralPath $Dir) {
        Remove-Item -LiteralPath $Dir -Recurse -Force
    }
    Write-FixtureLog "fixture torn down ($Dir removed)"
}

function Assert-State {
    if (-not (Test-Path -LiteralPath $PortFile)) {
        throw "no fixture state in $Dir (run 'up' first)"
    }
}

switch ($Action) {
    'up' { Invoke-Up -ListenPort $Port -AgentSource $AgentBinary -ToGitHubEnv $GitHubEnv.IsPresent }
    'start' { Assert-State; Resume-Fixture }
    'stop' { Assert-State; Suspend-Fixture; Write-FixtureLog "sshd stopped (state kept in $Dir)" }
    'env' { Assert-State; Write-FixtureEnvironment $GitHubEnv.IsPresent }
    'down' { Invoke-Down }
}
