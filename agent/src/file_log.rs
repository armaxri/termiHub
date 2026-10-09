//! Durable, bounded, per-process on-disk logs for the remote agent (audit
//! OBS-003, #4319).
//!
//! The agent's stderr is not a durable record: for `--stdio` the desktop
//! captures and re-logs it, but the `--daemon` / `--listen` /
//! `--registry-daemon` roles — session persistence, reconnect, the cross-desktop
//! registry, remote tunnels and services — have no capture path back to the
//! desktop. So every role also writes a rotating, hard-capped log file in the
//! agent's own config directory (next to `state.json`).
//!
//! # One file per process
//!
//! Several agent processes run at once on one host: a `--stdio` worker per
//! desktop connection, one `--daemon` per persistent session and the
//! `--registry-daemon`. They used to share one `termihub-agent.log`, and each
//! process rotated it on its own byte counter, so rotation in one process sent
//! the others' lines into renamed or deleted archives (audit OBS2-002). Each
//! process now writes its own `termihub-agent-<role>-<pid>.log` (plus its
//! archives), and a [`FamilyBudget`] bounds the whole `logs/` directory across
//! all of them: every open and every rotation prunes the oldest archives, then
//! the oldest files of other processes, until the family fits.
//!
//! # Detached daemons' stderr
//!
//! A detached daemon's stderr cannot inherit the worker's (it is the SSH exec
//! channel), so it goes to a capture file. That file used to sit next to the
//! session socket, grow without bound, duplicate the file sink line for line,
//! and be deleted together with the session's sockets (audit OBS2-007). Now:
//!
//! - detached roles mirror tracing to stderr only when their log file could not
//!   be opened, so stderr catches just pre-tracing and stdlib output;
//! - the capture file lives here, in the log directory, as
//!   `termihub-agent-stderr-<role>….log`, so it outlives the session and counts
//!   against the same family budget;
//! - it is opened in append mode, truncated when it is already over
//!   [`STDERR_CAP_BYTES`], and the daemon re-checks the cap periodically
//!   ([`spawn_stderr_cap_watchdog`]).
//!
//! The writer, the rotation and the `russh` clamp are shared with the desktop
//! ([`termihub_core::diagnostics::file_log`], audit DUP2-006).

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use termihub_core::diagnostics::file_log::{self as shared, FamilyBudget, RotatingLogFile};
use tracing_subscriber::EnvFilter;

/// Stem prefix shared by every agent log file (the log "family").
const LOG_FAMILY: &str = "termihub-agent";

/// Size at which a process's live log file is rotated away.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Generations kept per process: the live file plus `MAX_FILES - 1` archives.
const MAX_FILES: usize = 3;

/// Most bytes all agent log files may use together on the host.
const FAMILY_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Most agent log files kept on the host.
const FAMILY_MAX_FILES: usize = 40;

/// Cap on a detached daemon's stderr capture file.
pub const STDERR_CAP_BYTES: u64 = 1024 * 1024;

/// How often a detached daemon re-checks its stderr capture against the cap.
const STDERR_CAP_INTERVAL: Duration = Duration::from_secs(30);

/// Environment variable overriding the file sink's filter directive (mirrors
/// the desktop's `TERMIHUB_FILE_LOG`). Overrides keep the shared russh clamp.
const FILE_LOG_ENV: &str = "TERMIHUB_AGENT_FILE_LOG";

/// The agent process roles, each with its own log file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRole {
    /// `--stdio`: one worker per desktop connection over SSH exec.
    Stdio,
    /// `--listen`: the TCP listener.
    Listen,
    /// `--daemon <id>`: one detached daemon per persistent session.
    Daemon,
    /// `--registry-daemon`: the host-wide registry.
    Registry,
}

impl AgentRole {
    /// The role's name in log file names.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::Listen => "listen",
            Self::Daemon => "daemon",
            Self::Registry => "registry",
        }
    }

    /// Whether the role runs detached, with its stderr in a capture file.
    pub fn is_detached(self) -> bool {
        matches!(self, Self::Daemon | Self::Registry)
    }
}

/// Build the [`EnvFilter`] for the file sink: [`FILE_LOG_ENV`] (russh-clamped)
/// when set, else INFO with russh at WARN.
pub fn file_env_filter() -> EnvFilter {
    shared::file_env_filter(std::env::var(FILE_LOG_ENV).ok().as_deref())
}

/// Resolve the directory the agent logs are written to.
///
/// A `logs/` subdirectory of the agent's config directory, so the files sit
/// next to `state.json`. Derived from
/// [`crate::state::persistence::AgentState::config_dir`], it honors
/// `XDG_CONFIG_HOME` exactly as `state.json` does — so an integration test (or a
/// portable setup) that redirects the agent's state redirects its logs too.
pub fn log_dir() -> PathBuf {
    log_dir_in(crate::state::persistence::AgentState::config_dir())
}

/// The log directory given an agent config directory (`<config>/logs`).
fn log_dir_in(config_dir: PathBuf) -> PathBuf {
    config_dir.join("logs")
}

/// This process's log stem for `role`: `termihub-agent-<role>-<pid>`.
fn process_stem(role: AgentRole) -> String {
    shared::per_process_stem(LOG_FAMILY, role.as_str(), std::process::id())
}

/// Full path of this process's live log file for `role`, for reporting.
pub fn log_file_path(role: AgentRole) -> PathBuf {
    shared::generation_path(&log_dir(), &process_stem(role), 0)
}

fn family_budget() -> FamilyBudget {
    FamilyBudget {
        prefix: LOG_FAMILY.to_string(),
        max_total_bytes: FAMILY_MAX_BYTES,
        max_files: FAMILY_MAX_FILES,
    }
}

/// Open this process's own log file for `role` in `dir`, bounded per process
/// and, across all agent processes, by the family budget.
fn open_in(dir: &Path, role: AgentRole) -> io::Result<RotatingLogFile> {
    Ok(
        RotatingLogFile::new(dir, &process_stem(role), MAX_FILE_BYTES, MAX_FILES)?
            .with_family_budget(family_budget()),
    )
}

/// Open this process's own log file for `role` at the agent's conventional
/// location ([`log_dir`]).
pub fn open(role: AgentRole) -> io::Result<RotatingLogFile> {
    open_in(&log_dir(), role)
}

/// Name of the stderr capture file for a session daemon.
fn daemon_stderr_name(session_id: &str) -> String {
    format!("{LOG_FAMILY}-stderr-daemon-{session_id}.log")
}

/// Name of the registry daemon's stderr capture file.
fn registry_stderr_name() -> String {
    format!("{LOG_FAMILY}-stderr-registry.log")
}

fn open_stderr_capture_in(dir: &Path, name: &str) -> Option<File> {
    shared::open_capped(&dir.join(name), STDERR_CAP_BYTES).ok()
}

/// Open the stderr capture file for the session daemon `session_id` (see the
/// module docs). `None` when it cannot be opened; the launcher then discards
/// the daemon's stderr.
pub fn open_daemon_stderr(session_id: &str) -> Option<File> {
    open_stderr_capture_in(&log_dir(), &daemon_stderr_name(session_id))
}

/// Open the registry daemon's stderr capture file (see [`open_daemon_stderr`]).
pub fn open_registry_stderr() -> Option<File> {
    open_stderr_capture_in(&log_dir(), &registry_stderr_name())
}

/// A handle to this process's own stderr, as a [`File`].
fn own_stderr() -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::fd::AsFd;
        Ok(File::from(io::stderr().as_fd().try_clone_to_owned()?))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsHandle;
        Ok(File::from(io::stderr().as_handle().try_clone_to_owned()?))
    }
}

/// Keep a detached daemon's stderr capture under [`STDERR_CAP_BYTES`] for its
/// whole lifetime: a background thread truncates it whenever it outgrows the
/// cap. A no-op when stderr is not a regular file (null, a pipe, a terminal).
pub fn spawn_stderr_cap_watchdog() {
    let Ok(stderr) = own_stderr() else {
        return;
    };
    if !stderr.metadata().is_ok_and(|m| m.is_file()) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("stderr-cap".into())
        .spawn(move || loop {
            std::thread::sleep(STDERR_CAP_INTERVAL);
            let _ = shared::enforce_cap(&stderr, STDERR_CAP_BYTES);
        });
}

#[cfg(test)]
#[path = "file_log_tests.rs"]
mod tests;
