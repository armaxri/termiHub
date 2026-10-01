<#
.SYNOPSIS
  Release install-smoke: application log + single-instance lifecycle (Windows twin
  of release-smoke-app-lifecycle.sh; #1570, PER-005, SM-025, #4011).

.DESCRIPTION
  Drives an INSTALLED release build through two runs and checks what its durable
  log (src-tauri/src/utils/file_log.rs) and the single-instance plugin
  (src-tauri/src/utils/single_instance.rs) promise:

    run 1  launch; the frontend reaches the backend (IPC marker in the log); the
           startup banner carries this release's version and the launched pid;
           the log holds no ANSI escape; closing the main window (WM_CLOSE, what
           the title-bar X sends) ends with "termiHub exited cleanly".
    run 2  relaunch; the log was APPENDED (run 1's bytes are untouched, a second
           banner follows); a second launch with --workspace <name> and one with
           --workspace-file <file> each exit while the first instance keeps
           running, and the first instance logs that it opened the forwarded
           workspace; a forced kill leaves NO "exited cleanly" line.

  The script DELETES the log it is given before run 1; it refuses to delete a
  non-empty log unless -ClearLog is passed. CI only.

.PARAMETER Close
  window (default): CloseMainWindow, i.e. WM_CLOSE to the app's main window.
  signal: `kill -TERM` (Unix pwsh only) -- for the stub app that
  scripts/internal/check-script-headless.sh drives.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $Log,
  [Parameter(Mandatory)] [string] $Version,
  [ValidateSet('window', 'signal')] [string] $Close = 'window',
  [string] $OutDir = '',
  [switch] $ClearLog
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-EnvInt([string] $Name, [int] $Default) {
  $v = [Environment]::GetEnvironmentVariable($Name)
  if ($v) { return [int]$v }
  return $Default
}
$IpcTimeout = Get-EnvInt 'SMOKE_IPC_TIMEOUT' 90
$ExitTimeout = Get-EnvInt 'SMOKE_EXIT_TIMEOUT' 30
$LogTimeout = Get-EnvInt 'SMOKE_LOG_TIMEOUT' 30

# Log lines this smoke keys on (see release-smoke-app-lifecycle.sh for sources).
$IpcMarker = 'Loading connections and folders'
$Banner = 'termiHub starting'
$CleanExit = 'termiHub exited cleanly'
$Forwarded = 'single-instance: opening forwarded workspace'
$ForwardName = 'SmokeDemo'
$ForwardFileName = 'SmokeForwardedFile'

if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw "-Exe '$Exe' is not a file" }
if ((Test-Path -LiteralPath $Log) -and (Get-Item -LiteralPath $Log).Length -gt 0 -and -not $ClearLog) {
  throw "'$Log' exists and is not empty; pass -ClearLog to let this smoke delete it"
}
$work = Join-Path ([IO.Path]::GetTempPath()) ("thub-lifecycle-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $work | Out-Null
if (-not $OutDir) { $OutDir = Join-Path $work 'out' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$script:passed = 0
$script:failed = 0
function Pass([string] $m) { Write-Output "  PASS: $m"; $script:passed++ }
function Fail([string] $m) { Write-Output "::error::app lifecycle smoke: $m"; $script:failed++ }
function Section([string] $m) { Write-Output ''; Write-Output "--- $m ---" }

$launched = [Collections.Generic.List[Diagnostics.Process]]::new()

function Get-LogSize { if (Test-Path -LiteralPath $Log) { (Get-Item -LiteralPath $Log).Length } else { 0 } }

# The log from byte offset $Offset on, as text (the log is UTF-8).
function Get-LogSince([long] $Offset) {
  if (-not (Test-Path -LiteralPath $Log)) { return '' }
  $fs = [IO.File]::Open($Log, 'Open', 'Read', 'ReadWrite, Delete')
  try {
    if ($Offset -gt $fs.Length) { return '' }
    $null = $fs.Seek($Offset, 'Begin')
    return [IO.StreamReader]::new($fs, [Text.Encoding]::UTF8).ReadToEnd()
  } finally { $fs.Dispose() }
}

function Invoke-AppLaunch([string] $Tag, [string[]] $AppArgs = @()) {
  $splat = @{
    FilePath               = $Exe
    PassThru               = $true
    RedirectStandardOutput = (Join-Path $OutDir "launch-$Tag.log")
    RedirectStandardError  = (Join-Path $OutDir "launch-$Tag.err.log")
  }
  if ($AppArgs.Count -gt 0) { $splat.ArgumentList = $AppArgs }
  $p = Start-Process @splat
  $null = $p.Handle  # keep ExitCode readable after exit (Start-Process quirk)
  $launched.Add($p)
  return $p
}

function Wait-Log([long] $Offset, [string] $Text, [int] $Timeout, $Proc = $null) {
  for ($i = 0; $i -lt $Timeout; $i++) {
    if ((Get-LogSince $Offset).Contains($Text)) { return $true }
    if ($Proc -and $Proc.HasExited) { return (Get-LogSince $Offset).Contains($Text) }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Test-Banner([long] $Offset, $Proc, [string] $Label) {
  $line = (Get-LogSince $Offset) -split "`n" | Where-Object { $_.Contains($Banner) } | Select-Object -First 1
  if (-not $line) { Fail "${Label}: no '$Banner' banner in the log"; return }
  $ver = if ($line -match 'version="([^"]*)"') { $Matches[1] } else { '' }
  $bannerPid = if ($line -match ' pid=(\d+)') { [int]$Matches[1] } else { -1 }
  if ($ver -eq $Version) { Pass "${Label}: banner carries version $Version" }
  else { Fail "${Label}: banner version '$ver', expected '$Version' ($line)" }
  if ($bannerPid -eq $Proc.Id) { Pass "${Label}: banner pid $bannerPid is the launched process" }
  else { Fail "${Label}: banner pid $bannerPid is not the launched process $($Proc.Id) ($line)" }
}

function Request-Close($Proc) {
  if ($Close -eq 'signal') { & /bin/kill -TERM $Proc.Id; return $true }
  # The main window may take a moment to get a handle after launch.
  for ($i = 0; $i -lt 10; $i++) {
    $Proc.Refresh()
    if ($Proc.MainWindowHandle -ne [IntPtr]::Zero) { return $Proc.CloseMainWindow() }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Invoke-SecondLaunch([string] $Tag, [string] $Want, [string[]] $AppArgs, $First) {
  $offset = Get-LogSize
  $p = Invoke-AppLaunch $Tag $AppArgs
  if ($p.WaitForExit($ExitTimeout * 1000)) {
    Pass "${Tag}: the second instance exited (code $($p.ExitCode))"
  } else {
    Fail "${Tag}: the second instance was still running after ${ExitTimeout}s"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
  if (-not $First.HasExited) { Pass "${Tag}: the first instance is still the one running" }
  else { Fail "${Tag}: the first instance (pid $($First.Id)) is gone" }
  $ok = (Wait-Log $offset $Forwarded $LogTimeout) -and
    ((Get-LogSince $offset) -split "`n" | Where-Object {
      $_.Contains($Forwarded) -and $_.Contains("workspace=$Want") })
  if ($ok) { Pass "${Tag}: the running instance opened the forwarded workspace '$Want'" }
  else { Fail "${Tag}: the running instance did not log '$Forwarded' for '$Want'" }
}

try {
  Write-Output '=== termiHub release smoke: app log + single instance ==='
  Write-Output "  exe: $Exe"; Write-Output "  log: $Log"; Write-Output "  version: $Version"
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $Log

  $wsFile = Join-Path $work 'forwarded.json'
  $ws = '{"id":"smoke-forwarded-file","name":"' + $ForwardFileName +
    '","tabGroups":[{"name":"Main","layout":{"type":"leaf","tabs":[]}}]}'
  [IO.File]::WriteAllText($wsFile, $ws)

  Section 'Run 1: launch'
  $run1 = Invoke-AppLaunch 'run1'
  if (-not (Wait-Log 0 $IpcMarker $IpcTimeout $run1)) {
    Fail "run 1: no '$IpcMarker' in the log within ${IpcTimeout}s"
    exit 1
  }
  Pass 'run 1: the frontend reached the backend'
  Test-Banner 0 $run1 'run 1'

  Section 'Run 1: no ANSI escapes in the log'
  if ((Get-LogSince 0).Contains([string][char]27)) { Fail 'the log contains ANSI escape sequences' }
  else { Pass 'the log has no ANSI escape sequences' }

  Section "Run 1: close for real ($Close)"
  if (-not (Request-Close $run1)) {
    Fail 'could not ask the app to close (no main window / close refused)'
    Stop-Process -Id $run1.Id -Force -ErrorAction SilentlyContinue
  } elseif ($run1.WaitForExit($ExitTimeout * 1000)) {
    Pass 'run 1: the app exited after the close request'
  } else {
    Fail "run 1: the app was still running ${ExitTimeout}s after the close request"
    Stop-Process -Id $run1.Id -Force -ErrorAction SilentlyContinue
  }
  if ((Get-LogSince 0).Contains($CleanExit)) { Pass "run 1: '$CleanExit' logged on the way out" }
  else { Fail "run 1: no '$CleanExit' line after a real close" }

  Section 'Run 2: relaunch appends to the log'
  $run1Bytes = Get-LogSize
  $run1Copy = [IO.File]::ReadAllBytes($Log)
  $run2 = Invoke-AppLaunch 'run2'
  if (-not (Wait-Log $run1Bytes $IpcMarker $IpcTimeout $run2)) {
    Fail "run 2: no '$IpcMarker' in the log within ${IpcTimeout}s"
    exit 1
  }
  Pass 'run 2: the frontend reached the backend'
  $now = [IO.File]::ReadAllBytes($Log)
  $prefix = $now[0..([Math]::Max(0, $run1Copy.Length - 1))]
  if ($now.Length -ge $run1Copy.Length -and
    [Linq.Enumerable]::SequenceEqual([byte[]]$prefix, [byte[]]$run1Copy)) {
    Pass "run 2 appended: run 1's $run1Bytes bytes are intact"
  } else {
    Fail "run 2 did not append: run 1's log content changed (truncated or rotated)"
  }
  Test-Banner $run1Bytes $run2 'run 2'
  $banners = @((Get-LogSince 0) -split "`n" | Where-Object { $_.Contains($Banner) }).Count
  if ($banners -ge 2) { Pass "the log holds both runs' banners ($banners)" }
  else { Fail "expected 2 banners after a relaunch, found $banners" }

  Section 'Single instance: --workspace is forwarded'
  Invoke-SecondLaunch 'forward-name' $ForwardName @('--workspace', $ForwardName) $run2
  Section 'Single instance: --workspace-file is forwarded'
  Invoke-SecondLaunch 'forward-file' $ForwardFileName @('--workspace-file', "`"$wsFile`"") $run2

  Section 'Run 2: a forced kill leaves no clean-exit line'
  Stop-Process -Id $run2.Id -Force -ErrorAction SilentlyContinue
  $null = $run2.WaitForExit($ExitTimeout * 1000)
  Start-Sleep -Seconds 1
  if ((Get-LogSince $run1Bytes).Contains($CleanExit)) {
    Fail "run 2 logged '$CleanExit' although it was force-killed"
  } else {
    Pass "run 2 (force-killed) left no '$CleanExit' line"
  }
} finally {
  foreach ($p in $launched) {
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
  if (Test-Path -LiteralPath $Log) { Copy-Item -LiteralPath $Log -Destination (Join-Path $OutDir 'app.log') }
}

Write-Output ''
Write-Output "  App lifecycle smoke: $($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { exit 1 }
exit 0
