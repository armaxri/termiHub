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
           workspace; a forced kill leaves NO "exited cleanly" line; a bare
           second launch (no arguments) exits and leaves the first running, and
           with -MinimizeCheck the first instance's minimised main window is
           restored by it (MT-APP-04).
    after  the log holds no "[csp] violation:" line (MT-APP-02).
    -IconCheck  the main window carries an icon (WM_GETICON / the class icon),
           what the taskbar shows (MT-UI-19).
    -PortableExe  a portable copy (portable.marker next to it) launched twice:
           the second launch reports "termiHub is already running from this
           folder" naming the data folder, exits 1 once its error dialog is
           dismissed (WM_CLOSE to its windows), and the first copy keeps running.

  The script DELETES the log it is given before run 1; it refuses to delete a
  non-empty log unless -ClearLog is passed. CI only.

.PARAMETER Close
  window (default): CloseMainWindow, i.e. WM_CLOSE to the app's main window.
  signal: `kill -TERM` (Unix pwsh only) -- for the stub app that
  scripts/internal/check-script-headless.sh drives.

.PARAMETER MinimizeCheck
  Windows only: minimise the main window (ShowWindow SW_MINIMIZE, by the
  launched process's window handle) before the bare relaunch, and require it to
  be restored afterwards.

.PARAMETER IconCheck
  Windows only: require an icon on the main window after run 1.

.PARAMETER PortableExe
  The executable of a portable copy of the app (portable.marker next to it); its
  data folder is deleted first. Close=signal dismisses the refused launch's
  dialog with SIGTERM (the stub app).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $Log,
  [Parameter(Mandatory)] [string] $Version,
  [ValidateSet('window', 'signal')] [string] $Close = 'window',
  [string] $OutDir = '',
  [switch] $ClearLog,
  [switch] $MinimizeCheck,
  [switch] $IconCheck,
  [string] $PortableExe = ''
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
$CspViolation = '[csp] violation:'
$PortableHeld = 'termiHub is already running from this folder'

if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw "-Exe '$Exe' is not a file" }
if ($PortableExe) {
  if (-not (Test-Path -LiteralPath $PortableExe -PathType Leaf)) { throw "-PortableExe '$PortableExe' is not a file" }
  $portableBase = Split-Path -Parent $PortableExe
  if (-not (Test-Path -LiteralPath (Join-Path $portableBase 'portable.marker') -PathType Leaf)) {
    throw "no portable.marker in '$portableBase' (the -PortableExe copy must be portable)"
  }
}
if (($MinimizeCheck -or $IconCheck) -and -not $IsWindows) { throw '-MinimizeCheck / -IconCheck need Windows' }
if ($MinimizeCheck -or $IconCheck -or ($PortableExe -and $Close -eq 'window')) {
  Add-Type -Namespace ThubSmoke -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
[DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int index);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
public static System.Collections.Generic.List<IntPtr> WindowsOf(uint pid) {
  var found = new System.Collections.Generic.List<IntPtr>();
  EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) found.Add(h); return true; }, IntPtr.Zero);
  return found;
}
'@
}
if ((Test-Path -LiteralPath $Log) -and (Get-Item -LiteralPath $Log).Length -gt 0 -and -not $ClearLog) {
  throw "'$Log' exists and is not empty; pass -ClearLog to let this smoke delete it"
}
$work = Join-Path ([IO.Path]::GetTempPath()) ("thub-lifecycle-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $work | Out-Null
if (-not $OutDir) { $OutDir = Join-Path $work 'out' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$script:passed = 0
$script:failed = 0
$script:skipped = 0
function Pass([string] $m) { Write-Output "  PASS: $m"; $script:passed++ }
function Fail([string] $m) { Write-Output "::error::app lifecycle smoke: $m"; $script:failed++ }
function Skip([string] $m) { Write-Output "::warning::app lifecycle smoke skipped a check: $m"; $script:skipped++ }
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

# The main window handle of a launched process (waits for it to appear).
function Get-MainWindow($Proc) {
  for ($i = 0; $i -lt 10; $i++) {
    $Proc.Refresh()
    if ($Proc.MainWindowHandle -ne [IntPtr]::Zero) { return $Proc.MainWindowHandle }
    Start-Sleep -Seconds 1
  }
  return [IntPtr]::Zero
}

function Invoke-BareRelaunch($First) {
  $hwnd = [IntPtr]::Zero
  if ($MinimizeCheck) {
    $hwnd = Get-MainWindow $First
    if ($hwnd -eq [IntPtr]::Zero) {
      Skip 'bare relaunch: the running instance has no main window to minimise'
    } else {
      $null = [ThubSmoke.Win32]::ShowWindow($hwnd, 6)  # SW_MINIMIZE
      Start-Sleep -Seconds 1
      if ([ThubSmoke.Win32]::IsIconic($hwnd)) { Pass 'bare relaunch: the running window is minimised' }
      else { Skip 'bare relaunch: the running window did not minimise'; $hwnd = [IntPtr]::Zero }
    }
  }
  $p = Invoke-AppLaunch 'bare-relaunch'
  if ($p.WaitForExit($ExitTimeout * 1000)) {
    Pass "bare relaunch: the second instance exited (code $($p.ExitCode))"
  } else {
    Fail "bare relaunch: the second instance was still running after ${ExitTimeout}s"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
  if (-not $First.HasExited) { Pass 'bare relaunch: the first instance is still the one running' }
  else { Fail "bare relaunch: the first instance (pid $($First.Id)) is gone" }
  if ($hwnd -eq [IntPtr]::Zero) { return }
  $restored = $false
  for ($i = 0; $i -lt $LogTimeout; $i++) {
    if (-not [ThubSmoke.Win32]::IsIconic($hwnd)) { $restored = $true; break }
    Start-Sleep -Seconds 1
  }
  if ($restored) { Pass 'bare relaunch: the running window was restored' }
  else { Fail "bare relaunch: the running window is still minimised ${LogTimeout}s after a relaunch" }
}

# Dismiss the refused portable launch's error dialog, aimed only at its pid.
function Close-Dialog($Proc) {
  if ($Close -eq 'signal') { & /bin/kill -TERM $Proc.Id; return $true }
  $wins = [ThubSmoke.Win32]::WindowsOf([uint32]$Proc.Id)
  foreach ($h in $wins) { $null = [ThubSmoke.Win32]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }  # WM_CLOSE
  return ($wins.Count -gt 0)
}

function Invoke-PortableDoubleLaunch {
  $data = Join-Path $portableBase 'data'
  $plog = Join-Path $data 'logs/termihub.log'
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $data
  $saved = $script:Exe
  $script:Exe = $PortableExe
  try {
    $first = Invoke-AppLaunch 'portable1'
    $locked = $false
    for ($i = 0; $i -lt $IpcTimeout; $i++) {
      $lock = Join-Path $data '.termihub.lock'
      if (Test-Path -LiteralPath $lock) {
        $fs = [IO.File]::Open($lock, 'Open', 'Read', 'ReadWrite, Delete')
        try { $holder = [IO.StreamReader]::new($fs).ReadToEnd().Trim() } catch { $holder = '' } finally { $fs.Dispose() }
        if ($holder -eq "$($first.Id)") { $locked = $true; break }
      }
      if ($first.HasExited) { break }
      Start-Sleep -Seconds 1
    }
    if (-not $locked) {
      Fail "portable: the first copy did not lock $data within ${IpcTimeout}s"
      return
    }
    Pass "portable: the first copy took the data-dir lock ($data)"
    $second = Invoke-AppLaunch 'portable2'
    $errLog = Join-Path $OutDir 'launch-portable2.err.log'
    $refused = $false
    $text = ''
    for ($i = 0; $i -lt $LogTimeout; $i++) {
      $text = ''
      foreach ($f in @($errLog, $plog)) {
        if (Test-Path -LiteralPath $f) {
          $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite, Delete')
          try { $text += [IO.StreamReader]::new($fs).ReadToEnd() } finally { $fs.Dispose() }
        }
      }
      if ($text.Contains($PortableHeld)) { $refused = $true; break }
      if ($second.HasExited) { break }
      Start-Sleep -Seconds 1
    }
    if ($refused) {
      Pass "portable: the second launch reported '$PortableHeld'"
      $leaf = (Split-Path -Leaf $portableBase)
      if ($text.Contains("$leaf/data") -or $text.Contains("$leaf\data")) {
        Pass 'portable: the refusal names the portable data folder'
      } else { Fail "portable: the refusal does not name the data folder $data" }
    } else {
      Fail "portable: the second launch did not report '$PortableHeld'"
    }
    if (-not $second.HasExited) {
      for ($i = 0; $i -lt 10; $i++) {
        if (Close-Dialog $second) { break }
        if ($second.HasExited) { break }
        Start-Sleep -Seconds 1
      }
    }
    if ($second.WaitForExit($ExitTimeout * 1000)) {
      if ($second.ExitCode -eq 1) { Pass 'portable: the refused launch exited (code 1) after its dialog' }
      else { Fail "portable: the refused launch exited with code $($second.ExitCode), expected 1" }
    } elseif ($refused) {
      Skip "portable: the refused launch's error dialog could not be dismissed; killing it"
      Stop-Process -Id $second.Id -Force -ErrorAction SilentlyContinue
    } else {
      Fail 'portable: the second launch kept running'
      Stop-Process -Id $second.Id -Force -ErrorAction SilentlyContinue
    }
    if (-not $first.HasExited) { Pass 'portable: the first copy is still running' }
    else { Fail "portable: the first copy (pid $($first.Id)) is gone" }
    Stop-Process -Id $first.Id -Force -ErrorAction SilentlyContinue
    $null = $first.WaitForExit($ExitTimeout * 1000)
  } finally {
    $script:Exe = $saved
  }
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

  if ($IconCheck) {
    Section 'Run 1: the main window carries the app icon (MT-UI-19)'
    $hwnd = Get-MainWindow $run1
    $icon = [IntPtr]::Zero
    if ($hwnd -ne [IntPtr]::Zero) {
      $icon = [ThubSmoke.Win32]::SendMessage($hwnd, 0x007F, [IntPtr]1, [IntPtr]::Zero)  # WM_GETICON ICON_BIG
      if ($icon -eq [IntPtr]::Zero) { $icon = [ThubSmoke.Win32]::GetClassLongPtr($hwnd, -14) }  # GCLP_HICON
    }
    if ($icon -ne [IntPtr]::Zero) { Pass "run 1: the main window carries an icon (HICON $icon)" }
    else { Fail 'run 1: the main window carries no icon (the taskbar would show a generic one)' }
  }

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

  Section 'Single instance: a bare relaunch raises the running window (MT-APP-04)'
  Invoke-BareRelaunch $run2
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

  Section 'The shipped CSP blocked nothing (MT-APP-02)'
  $csp = @((Get-LogSince 0) -split "`n" | Where-Object { $_.Contains($CspViolation) })
  if ($csp.Count -gt 0) {
    Fail "the app logged $($csp.Count) CSP violation(s):"
    $csp | Select-Object -First 10 | ForEach-Object { Write-Output "    | $_" }
  } else { Pass "no '$CspViolation' line in the log of both runs" }

  if ($PortableExe) {
    Section 'Portable: the same copy launched twice is refused (MT-APP-04)'
    Invoke-PortableDoubleLaunch
  }
} finally {
  foreach ($p in $launched) {
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
  if (Test-Path -LiteralPath $Log) { Copy-Item -LiteralPath $Log -Destination (Join-Path $OutDir 'app.log') }
}

Write-Output ''
Write-Output "  App lifecycle smoke: $($script:passed) passed, $($script:failed) failed, $($script:skipped) skipped"
if ($script:failed -gt 0) { exit 1 }
exit 0
