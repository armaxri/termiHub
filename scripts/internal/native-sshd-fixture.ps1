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
      * registers its own service (termihub-native-sshd) running sshd.exe on
        127.0.0.1:<port> with that config, starts it, and proves a real
        ssh.exe login + sftp subsystem;
      * prints `export NAME='value'` lines (POSIX form, for the Git Bash
        wrapper to eval) and, with -GitHubEnv, appends NAME=value to $GITHUB_ENV:
        TERMIHUB_NATIVE_SSHD=1, _PORT, _USER, _KEY, _HOST_PUBKEY, _DIR and,
        with -AgentBinary, _AGENT_BIN (a copy the test user can execute).

    stop / start take the listener down and bring it back (state kept); stop
    also ends the sessions the service's sshd spawned. down removes the
    service, the test user and its profile, and the state dir.

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

$ServiceName = 'termihub-native-sshd'
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
    # this fixture runs its own service with its own config).
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

function Get-ServicePid {
    $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'"
    if ($null -eq $svc -or $svc.ProcessId -eq 0) {
        return $null
    }
    return [int]$svc.ProcessId
}

function Resume-Fixture {
    Start-Service -Name $ServiceName
    $tcpPort = [int](Get-Content -LiteralPath $PortFile)
    if (-not (Wait-Listening $tcpPort $true)) {
        if (Test-Path -LiteralPath $LogFile) {
            Get-Content -LiteralPath $LogFile -Tail 50 | ForEach-Object { Write-FixtureLog "  | $_" }
        }
        throw "sshd did not listen on 127.0.0.1:$tcpPort"
    }
    Write-FixtureLog "sshd listening on 127.0.0.1:$tcpPort (service $ServiceName)"
}

function Suspend-Fixture {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        return
    }
    # The per-connection sshd processes the service's sshd spawned, collected by
    # parent PID (never by name alone) before the master goes, so an established
    # session is severed along with the listener.
    $children = @()
    $masterPid = Get-ServicePid
    if ($null -ne $masterPid) {
        $children = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$masterPid" |
                Where-Object { $_.Name -like 'sshd*' } | ForEach-Object { [int]$_.ProcessId })
    }
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
    }
    foreach ($child in $children) {
        $proc = Get-Process -Id $child -ErrorAction SilentlyContinue
        if ($null -ne $proc -and $proc.ProcessName -like 'sshd*') {
            Stop-Process -Id $child -Force -ErrorAction SilentlyContinue
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
        throw "ssh login as $TestUser on 127.0.0.1:$TcpPort failed (exit $LASTEXITCODE, whoami '$who'); log: $LogFile"
    }
    $sftp = Join-Path $OpenSshDir 'sftp.exe'
    'pwd' | & $sftp -b - -P $TcpPort @opts "$TestUser@127.0.0.1" | Out-Null
    if ($LASTEXITCODE -ne 0) {
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
    if ((Test-Path -LiteralPath $Dir) -or (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
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

    $sshd = Join-Path $OpenSshDir 'sshd.exe'
    $binPath = "`"$sshd`" -f `"$Config`" -E `"$LogFile`""
    New-Service -Name $ServiceName -BinaryPathName $binPath -StartupType Manual `
        -DisplayName 'termiHub native sshd test fixture' | Out-Null
    Resume-Fixture
    Test-Fixture $ListenPort
    Write-FixtureEnvironment $ToGitHubEnv
}

function Invoke-Down {
    Assert-Admin
    Suspend-Fixture
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        Invoke-Native 'sc.exe' @('delete', $ServiceName) | Out-Null
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
