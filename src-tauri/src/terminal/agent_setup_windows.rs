//! What a Windows agent setup runs on the host (#5946, #5992, #5996).
//!
//! The setup uploads the agent and one PowerShell script to the user profile
//! and types a single line into the setup tab that runs it
//! ([`windows_setup_lines`]), the same script from every login shell. The
//! script replaces the agent so that a failure at any point leaves a usable
//! one:
//!
//! 1. The new binary is moved next to the install under its own name and must
//!    start **before** the installed agent is touched.
//! 2. The installed agent is renamed to [`WINDOWS_BACKUP_EXE`] and the new one
//!    to the install name: two renames in one directory, the only moment
//!    without an agent at the install path. Windows can rename a running
//!    image, so an agent in use is no obstacle.
//! 3. The install must start; anything else puts the previous agent back.
//!
//! Nothing is overwritten: every move fails when its target exists, and a copy
//! is only restored over an agent that does not start. Copies are deleted only
//! while the installed agent starts.
//!
//! A setup killed in between (a lost link, a closed tab) cannot clean up. Its
//! `termihub-agent.previous.exe` is put back by [`windows_recover_command`],
//! which the desktop runs once the tab's shell ended, by the next setup, and by
//! the next deploy. A lock file held for the life of the script, which Windows
//! releases when the process dies, keeps these from running at the same time.

use crate::terminal::agent_install::{
    powershell_encoded_command, WindowsDeployShell, WindowsShell, WINDOWS_AGENT_EXE,
    WINDOWS_BACKUP_EXE, WINDOWS_INSTALL_SUBDIR, WINDOWS_POWERSHELL_EXE, WINDOWS_STALE_PREFIX,
    WINDOWS_UPLOAD_NAME,
};

/// File name of the uploaded setup script, in the user profile like the agent.
pub(super) const WINDOWS_SETUP_SCRIPT_NAME: &str = "termihub-agent-setup.ps1";

/// The uploaded agent next to the install, before it replaces it.
const WINDOWS_NEW_EXE: &str = "termihub-agent.new.exe";

/// The lock file of a running setup or recovery.
const WINDOWS_LOCK_NAME: &str = "termihub-agent.lock";

/// What [`windows_recover_command`] prints when a setup holds the lock.
pub(super) const RECOVER_BUSY: &str = "termihub-recover busy";

/// The functions the setup and the recovery share. Windows PowerShell 5.1
/// syntax, ASCII only, and no `Move-Item -Force`: a move onto an existing file
/// must fail.
const LIBRARY: &str = r#"$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA '__SUBDIR__'
$dst = Join-Path $dir '__AGENT__'
$bak = Join-Path $dir '__BACKUP__'
$new = Join-Path $dir '__NEW__'
$src = Join-Path $env:USERPROFILE '__UPLOAD__'
$ps1 = Join-Path $env:USERPROFILE '__SCRIPT__'
function Lock-Setup($seconds) {
  for ($i = 0; $i -le $seconds; $i++) {
    if ($i) { Start-Sleep 1 }
    try { return [IO.File]::Open((Join-Path $dir '__LOCK__'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { }
  }
}
function Test-Agent($path) {
  $ErrorActionPreference = 'Continue'
  try {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $out = @(& $path --version)
    return ($LASTEXITCODE -eq 0 -and "$($out[0])" -like 'termihub-agent *')
  } catch { return $false }
}
function Test-Installed {
  for ($i = 0; $i -lt 3; $i++) {
    if (Test-Agent $dst) { return $true }
    if (-not (Test-Path -LiteralPath $dst)) { return $false }
    Start-Sleep 1
  }
  return $false
}
function Get-Stale { Get-ChildItem -LiteralPath $dir -Filter '__STALE__*.exe' -File | Sort-Object LastWriteTime -Descending | ForEach-Object { $_.FullName } }
function Move-Aside($path) { Move-Item -LiteralPath $path -Destination (Join-Path $dir ('__STALE__' + [guid]::NewGuid().ToString('N') + '.exe')) }
function Restore-Agent {
  if (-not (Test-Path -LiteralPath $dst) -and (Test-Path -LiteralPath $bak)) { try { Move-Item -LiteralPath $bak -Destination $dst } catch { } }
  if (Test-Installed) { return }
  $copies = @($bak)
  if (-not (Test-Path -LiteralPath $dst)) { $copies += @(Get-Stale) }
  foreach ($copy in $copies) {
    if (-not (Test-Agent $copy)) { continue }
    try {
      if (Test-Path -LiteralPath $dst) { Move-Aside $dst }
      Move-Item -LiteralPath $copy -Destination $dst
      if (Test-Agent $dst) { return }
    } catch { }
  }
}
function Clear-Leftovers {
  $old = @($new, $src, $ps1)
  if (Test-Installed) { $old += @($bak) + @(Get-Stale) }
  foreach ($path in $old) { Remove-Item -Force -LiteralPath $path -ErrorAction SilentlyContinue }
  if ((Test-Installed) -and (Test-Path -LiteralPath $bak)) { try { Move-Aside $bak } catch { } }
}
"#;

/// The steps that replace the agent, in order. Any of them may throw, and the
/// process may die between any two: see the tests, which do both at each one.
pub(super) const INSTALL_STEPS: &[&str] = &[
    // A setup that died earlier may have left the previous agent renamed.
    "Restore-Agent",
    "if (Test-Path -LiteralPath $new) { try { Remove-Item -Force -LiteralPath $new } catch { Move-Aside $new } }",
    "Write-Host '[..] Checking the uploaded agent'",
    "Move-Item -LiteralPath $src -Destination $new",
    "if (-not (Test-Agent $new)) { throw 'The uploaded agent does not start on this host.' }",
    "if (Test-Path -LiteralPath $bak) { Move-Aside $bak }",
    "Write-Host \"[..] Installing the agent to $dst\"",
    "if (Test-Path -LiteralPath $dst) { Move-Item -LiteralPath $dst -Destination $bak }",
    "Move-Item -LiteralPath $new -Destination $dst",
    "if (-not (Test-Installed)) { throw 'The installed agent does not start.' }",
];

const SETUP_HEAD: &str = r#"$ok = $false
$lock = $null
Write-Host '=== termiHub Agent Setup ==='
try {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $lock = Lock-Setup 30
  if (-not $lock) { throw 'The install folder could not be locked: another agent setup may be running.' }
"#;

const SETUP_TAIL: &str = r#"
  $ok = $true
} catch { Write-Host "[error] $_" } finally {
  if ($lock) {
    if (-not $ok) { Restore-Agent }
    Clear-Leftovers
    $lock.Dispose()
  }
}
if ($ok) { Write-Host 'Agent installed. You can close this tab.'; exit 0 }
Write-Host 'Agent setup failed: see the output above.'
if (Test-Agent $dst) { Write-Host 'The previously installed agent is still in place.' }
exit 1
"#;

const RECOVER: &str = r#"if (-not (Test-Path -LiteralPath $dir)) { exit 0 }
$lock = Lock-Setup 10
if (-not $lock) { '__BUSY__'; exit 0 }
try { Restore-Agent; Clear-Leftovers } finally { $lock.Dispose() }
"#;

fn fill(template: &str) -> String {
    template
        .replace("__SUBDIR__", WINDOWS_INSTALL_SUBDIR)
        .replace("__AGENT__", WINDOWS_AGENT_EXE)
        .replace("__BACKUP__", WINDOWS_BACKUP_EXE)
        .replace("__NEW__", WINDOWS_NEW_EXE)
        .replace("__UPLOAD__", WINDOWS_UPLOAD_NAME)
        .replace("__SCRIPT__", WINDOWS_SETUP_SCRIPT_NAME)
        .replace("__LOCK__", WINDOWS_LOCK_NAME)
        .replace("__STALE__", WINDOWS_STALE_PREFIX)
        .replace("__BUSY__", RECOVER_BUSY)
}

/// The setup script made of `steps`.
fn setup_script_of(steps: &[&str]) -> String {
    fill(&format!(
        "{LIBRARY}{SETUP_HEAD}  {}{SETUP_TAIL}",
        steps.join("\n  ")
    ))
}

/// The script the setup uploads as [`WINDOWS_SETUP_SCRIPT_NAME`].
pub(super) fn windows_setup_script() -> String {
    setup_script_of(INSTALL_STEPS)
}

fn recover_script() -> String {
    fill(&format!("{LIBRARY}{RECOVER}"))
}

/// The command that puts the previous agent back after a setup that did not
/// finish, and removes what it left. It does nothing to an agent that starts,
/// and prints [`RECOVER_BUSY`] while a setup is still running. Run over an exec
/// channel it works from every Windows login shell.
pub(super) fn windows_recover_command() -> String {
    powershell_encoded_command(&recover_script())
}

/// The line a Windows setup types into its tab for `shell`: run the uploaded
/// script, then end the shell. The end starts the check on the host
/// (`agent_setup_outcome`, #5992); Win32-OpenSSH reports the PTY's console
/// host, not this status, so a 0 says nothing.
///
/// Every shell runs `powershell.exe`, so one script serves all of them; only
/// the spelling of the profile path and of "then exit" differs. A login shell
/// that is neither `cmd.exe` nor PowerShell is a POSIX one (Git Bash, MSYS2,
/// Cygwin), which keeps `USERPROFILE` as a Windows path.
pub(super) fn windows_setup_lines(shell: WindowsDeployShell) -> Vec<String> {
    let (profile, exit) = match shell {
        WindowsDeployShell::Native(WindowsShell::Cmd) => ("%USERPROFILE%", " & exit"),
        WindowsDeployShell::Native(WindowsShell::PowerShell) => {
            ("$env:USERPROFILE", "; exit $LASTEXITCODE")
        }
        WindowsDeployShell::EncodedPowerShell => ("$USERPROFILE", "; exit $?"),
    };
    vec![format!(
        "{WINDOWS_POWERSHELL_EXE} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass \
         -File \"{profile}\\{WINDOWS_SETUP_SCRIPT_NAME}\"{exit}"
    )]
}

/// What Enter sends to a Windows setup tab's shell. A Windows PTY shell takes
/// CR: PSReadLine reads LF as Ctrl+Enter and leaves the line unfinished (#5992).
pub(super) const WINDOWS_ENTER: &str = "\r";

/// [`windows_setup_lines`] as typed into the tab, each ended with Enter.
pub(super) fn windows_setup_input(shell: WindowsDeployShell) -> Vec<String> {
    windows_setup_lines(shell)
        .into_iter()
        .map(|line| line + WINDOWS_ENTER)
        .collect()
}

/// `message` as a line typed into a Windows tab whose login shell may be
/// `cmd.exe`, PowerShell or Git Bash: `echo '<text>'`.
///
/// A message can quote remote output, so every character that means something
/// to one of these shells becomes a space; what is left cannot run anything.
pub(super) fn windows_echo_input(message: &str) -> String {
    let safe: String = message
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || ".,:_-/ ".contains(c) {
                c
            } else {
                ' '
            }
        })
        .collect();
    format!("echo '{}'{WINDOWS_ENTER}", safe.trim())
}

#[cfg(test)]
#[path = "agent_setup_windows_tests.rs"]
mod tests;
