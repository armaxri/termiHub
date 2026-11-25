//! How a Windows agent setup went (#5992).
//!
//! A Windows setup types its install commands into the setup tab's shell. The
//! exit code of that shell does not say how it went: Win32-OpenSSH runs a PTY
//! shell under a console host and reports that host's status, so `exit 1`
//! arrives as `0`. The code `0` is therefore never read as success.
//!
//! Instead, once the shell has ended, the setup looks at the host over an exec
//! channel of its own (no PTY, [`windows_check_command`]): is the file at the
//! install path the very binary that was uploaded (SHA-256), and does it run?
//! Comparing the bytes, not the version, also catches an older agent of the
//! same version that a failed update left in place.
//!
//! [`windows_setup_outcome`] combines both into one of three outcomes. What
//! could not be checked is [`SetupOutcome::Unknown`], never installed and, on
//! its own, never failed.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, EventId, Listener, Runtime};
use termihub_core::backends::ssh::handler::SshSession;
use tracing::warn;

use crate::terminal::agent_install::{
    is_termihub_agent_version_output, powershell_encoded_command, powershell_single_quote,
    WINDOWS_AGENT_EXE, WINDOWS_INSTALL_SUBDIR,
};
use crate::terminal::agent_setup_windows::{windows_recover_command, RECOVER_BUSY};
use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::run_remote_command_with_timeout;

/// How long the setup waits for the tab's shell to end after it typed the
/// install commands. An install is a rename plus a `--version` run; a shell
/// still open after this hangs or was left at a prompt.
pub(super) const SHELL_END_CEILING: Duration = Duration::from_secs(300);

/// How long the wait goes on for a session that is gone already: the session is
/// dropped right before its end is announced.
const END_ANNOUNCED_WITHIN: Duration = Duration::from_secs(1);

/// Deadline of the check: starting PowerShell and the first run of a fresh
/// executable (virus scanner) are slow on a loaded Windows host.
pub(super) const CHECK_TIMEOUT: Duration = Duration::from_secs(60);

/// The word that starts every line the check prints, so a login banner or
/// profile output around them is never taken for a result.
const CHECK_TAG: &str = "termihub-check";

/// How a Windows agent setup went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SetupOutcome {
    /// The uploaded agent is installed and runs.
    Installed,
    /// The setup definitely did not install a working agent: why.
    Failed(String),
    /// Nothing proves either: why.
    Unknown(String),
}

impl SetupOutcome {
    /// The `agent-setup-progress` step and message reporting this outcome.
    pub(super) fn progress(&self) -> (&'static str, &str) {
        match self {
            Self::Installed => ("installed", "Agent installed"),
            Self::Failed(reason) => ("failed", reason),
            Self::Unknown(reason) => ("unknown", reason),
        }
    }
}

/// How the setup tab's shell ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ShellEnd {
    /// The server reported that the shell exited, with this code. Only the
    /// *end* is reliable on Windows, not a code of 0.
    Exited(i32),
    /// The session ended without one: a lost link, or the tab was closed.
    NoStatus,
    /// The shell was still open when the wait ran out.
    StillOpen,
}

/// What the check found on the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HostCheck {
    /// The uploaded binary is at the install path and reports a version.
    Installed,
    /// There is no file at the install path.
    Absent,
    /// The file there is another agent, which runs: the previous one.
    PreviousRuns,
    /// The file there is neither the uploaded binary nor a running agent.
    OtherBinary,
    /// The uploaded binary is there but does not run as an agent.
    DoesNotRun,
    /// The check ran but its answer says nothing usable.
    Unreadable,
    /// A setup is still running on the host.
    Busy,
}

/// Lower-case hex SHA-256 of `bytes`.
pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The PowerShell script of [`windows_check_command`]. It prints
/// `termihub-check` lines only: `absent`, or `sha256 <hex>` followed by
/// `version <exit code> <first output line>` / `version-error`; `error` when
/// the file could not be looked at.
///
/// The file is opened with full sharing (a running agent holds its image) and
/// hashed through .NET: `Get-FileHash` is missing when Windows PowerShell
/// inherits PowerShell 7's module path.
fn check_script() -> String {
    let path = powershell_single_quote(&format!(r"{WINDOWS_INSTALL_SUBDIR}\{WINDOWS_AGENT_EXE}"));
    format!(
        "$ErrorActionPreference = 'Stop'; \
         try {{ \
         $p = Join-Path -Path $env:LOCALAPPDATA -ChildPath {path}; \
         if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {{ '{CHECK_TAG} absent'; exit 0 }}; \
         $f = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite, Delete'); \
         try {{ $h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create()\
         .ComputeHash($f)).Replace('-', '') }} finally {{ $f.Dispose() }}; \
         '{CHECK_TAG} sha256 ' + $h \
         }} catch {{ '{CHECK_TAG} error'; exit 0 }}; \
         try {{ $v = @(& $p --version); '{CHECK_TAG} version ' + $LASTEXITCODE + ' ' + $v[0] }} \
         catch {{ '{CHECK_TAG} version-error' }}"
    )
}

/// The command that checks the installed agent. Run over an exec channel it
/// works from every Windows login shell (`cmd.exe`, PowerShell, Git Bash, …):
/// the script travels as one base64 word ([`powershell_encoded_command`]).
pub(super) fn windows_check_command() -> String {
    powershell_encoded_command(&check_script())
}

/// Read the output of [`windows_check_command`]. Anything but one complete,
/// consistent answer is [`HostCheck::Unreadable`].
pub(super) fn parse_check(output: &str, uploaded_sha256: &str) -> HostCheck {
    let lines: Vec<&str> = output
        .lines()
        .filter_map(|line| line.trim().strip_prefix(CHECK_TAG)?.strip_prefix(' '))
        .collect();
    let (sha, version) = match lines[..] {
        ["absent"] => return HostCheck::Absent,
        [sha, version] => (sha.strip_prefix("sha256 ").unwrap_or_default(), version),
        _ => return HostCheck::Unreadable,
    };
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return HostCheck::Unreadable;
    }
    let uploaded = sha.eq_ignore_ascii_case(uploaded_sha256);
    let runs = if version == "version-error" {
        false
    } else {
        let parsed = version.strip_prefix("version ").and_then(|rest| {
            let (code, text) = rest.split_once(' ').unwrap_or((rest, ""));
            Some((code.parse::<i64>().ok()?, text))
        });
        match parsed {
            Some((code, text)) => code == 0 && is_termihub_agent_version_output(text),
            None => return HostCheck::Unreadable,
        }
    };
    match (uploaded, runs) {
        (true, true) => HostCheck::Installed,
        (true, false) => HostCheck::DoesNotRun,
        (false, true) => HostCheck::PreviousRuns,
        (false, false) => HostCheck::OtherBinary,
    }
}

/// Put the previous agent back if the setup did not get to it (#5996), then
/// check the host. A recovery that cannot run changes nothing, so the check
/// still tells what is there; only a frozen server skips it.
pub(super) fn recover_and_check_host(
    session: &SshSession,
    uploaded_sha256: &str,
    timeout: Duration,
) -> Result<HostCheck, TerminalError> {
    match run_remote_command_with_timeout(session, &windows_recover_command(), timeout) {
        Ok(output) if output.lines().any(|line| line.trim() == RECOVER_BUSY) => {
            return Ok(HostCheck::Busy);
        }
        Ok(_) => {}
        Err(e) if e.is_timeout() => return Err(e),
        Err(e) => warn!("Agent setup: the host could not be cleaned up: {e}"),
    }
    check_host(session, uploaded_sha256, timeout)
}

/// Run the check over `session`, the setup's own SSH connection.
pub(super) fn check_host(
    session: &SshSession,
    uploaded_sha256: &str,
    timeout: Duration,
) -> Result<HostCheck, TerminalError> {
    let output = run_remote_command_with_timeout(session, &windows_check_command(), timeout)?;
    Ok(parse_check(&output, uploaded_sha256))
}

/// The outcome of a setup whose shell ended as `end` and whose host `check`
/// found this.
///
/// What the host holds decides. A missing or different binary only proves a
/// failure once the shell has really ended: after a lost link or with the
/// shell still open, the install may still be running. Without a usable check,
/// a small non-zero code (the setup lines end with `exit 1`) still means
/// failed; `0` and the large codes Windows reports for a killed console mean
/// nothing.
pub(super) fn windows_setup_outcome(
    end: ShellEnd,
    check: &Result<HostCheck, TerminalError>,
) -> SetupOutcome {
    let ended = matches!(end, ShellEnd::Exited(_));
    let not_installed = |reason: &str| {
        if ended {
            SetupOutcome::Failed(reason.to_string())
        } else {
            SetupOutcome::Unknown(format!("{reason} The setup may not have finished."))
        }
    };
    let unchecked = |why: String| match end {
        ShellEnd::Exited(code @ 1..=255) => {
            SetupOutcome::Failed(format!("The setup commands ended with code {code}."))
        }
        _ => SetupOutcome::Unknown(why),
    };
    match check {
        Ok(HostCheck::Installed) => SetupOutcome::Installed,
        Ok(HostCheck::DoesNotRun) => SetupOutcome::Failed(
            "The agent was copied to the host but does not start there.".to_string(),
        ),
        Ok(HostCheck::Absent) => not_installed("There is no agent at the install path."),
        Ok(HostCheck::PreviousRuns) => not_installed(
            "The new agent was not installed. The previous agent is still in place and starts.",
        ),
        Ok(HostCheck::OtherBinary) => not_installed(
            "The new agent was not installed, and the file at the install path does not start \
             as an agent.",
        ),
        Ok(HostCheck::Busy) => {
            unchecked("An agent setup is still running on the host.".to_string())
        }
        Ok(HostCheck::Unreadable) => {
            unchecked("The installed agent could not be checked.".to_string())
        }
        Err(e) if e.is_timeout() => {
            unchecked("Checking the installed agent timed out.".to_string())
        }
        Err(_) => unchecked("The host could not be reached to check the agent.".to_string()),
    }
}

/// Watches for the end of one session, from before anything is typed into it.
pub(super) struct SessionEndWatch<R: Runtime> {
    app: AppHandle<R>,
    listener: EventId,
    ended: Receiver<Option<i32>>,
}

impl<R: Runtime> SessionEndWatch<R> {
    /// Start watching `session_id`'s `terminal-exit`.
    pub(super) fn start(app: &AppHandle<R>, session_id: &str) -> Self {
        let (tx, ended) = std::sync::mpsc::channel();
        let wanted = session_id.to_string();
        let listener = app.listen_any("terminal-exit", move |event| {
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                return;
            };
            if payload["session_id"].as_str() == Some(&wanted) {
                let code = payload["exit_code"]
                    .as_i64()
                    .and_then(|c| i32::try_from(c).ok());
                let _ = tx.send(code);
            }
        });
        Self {
            app: app.clone(),
            listener,
            ended,
        }
    }

    /// Wait until the session ended, at most `ceiling`. `is_open` says whether
    /// it still exists: one that ended before the watch began sent no event.
    pub(super) fn wait(&self, ceiling: Duration, is_open: impl FnOnce() -> bool) -> ShellEnd {
        let open = is_open();
        let limit = if open {
            ceiling
        } else {
            END_ANNOUNCED_WITHIN.min(ceiling)
        };
        match self.ended.recv_timeout(limit) {
            Ok(Some(code)) => ShellEnd::Exited(code),
            Err(RecvTimeoutError::Timeout) if open => ShellEnd::StillOpen,
            Ok(None) | Err(_) => ShellEnd::NoStatus,
        }
    }
}

impl<R: Runtime> Drop for SessionEndWatch<R> {
    fn drop(&mut self) {
        self.app.unlisten(self.listener);
    }
}

#[cfg(test)]
#[path = "agent_setup_outcome_tests.rs"]
mod tests;
