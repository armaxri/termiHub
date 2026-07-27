use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use russh_sftp::client::error::Error as RusshSftpError;
use russh_sftp::client::SftpSession as RusshSftp;
use russh_sftp::protocol::{OpenFlags, StatusCode};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{debug, info, warn};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::backends::ssh::{sftp, ssh_exec_with_stdin, SshExecOutput};
use termihub_core::errors::FileError;
use termihub_core::files::{FileBackend, FileEntry};

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

/// Lock a mutex, mapping a poisoned lock to a recoverable [`TerminalError`]
/// instead of panicking.
///
/// A prior SFTP op that panicked while holding the lock poisons the `Mutex`;
/// a raw `.lock().unwrap()` would then abort the whole process on every
/// subsequent command. Mapping the error keeps the session recoverable
/// (audit GAP C1, issue #1143). Mirrors the error mapping already used by the
/// [`SftpFileBackend`] impl.
pub fn lock_session<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, TerminalError> {
    mutex
        .lock()
        .map_err(|_| TerminalError::SshError("SFTP session lock poisoned".to_string()))
}

/// Drain every entry from a keyed session map, poison-safe, and drop the values.
///
/// Recovers the guard even if the map mutex is poisoned — draining is cleanup
/// (e.g. on app quit) and must never itself panic, mirroring
/// [`SftpManager::close_session`]'s handling (audit GAP C1, issues #1143/#1244).
/// Returns the number of sessions removed. Values are dropped as the map clears,
/// tearing down each underlying connection.
fn drain_sessions<V>(sessions: &Mutex<HashMap<String, V>>) -> usize {
    let mut guard = sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let count = guard.len();
    guard.clear();
    count
}

/// Marker echoed by the exec-capability probe.
///
/// A working shell/exec channel echoes it back on stdout; an SFTP-only
/// connection (`ForceCommand internal-sftp`) or a relayed connection cannot run
/// the command, so the marker never reaches stdout. Kept in sync with the
/// integration test in `core/tests/ssh_exec_with_stdin.rs`.
const EXEC_PROBE_MARKER: &str = "termihub_exec_probe_ok";

/// Decide, from an exec probe's captured output, whether the connection can run
/// remote commands (i.e. an exec channel is usable).
///
/// Keyed off the marker in stdout (not just a zero exit) so an SFTP-only server
/// that quietly closes the forced-subsystem channel with exit 0 is still
/// reported as not capable.
fn exec_probe_indicates_capability(output: &SshExecOutput) -> bool {
    output.exit_status == 0 && output.stdout.contains(EXEC_PROBE_MARKER)
}

/// Authoritative writability of a specific remote file, as decided by an SFTP
/// write-open probe (see [`SftpSession::check_writable`]).
///
/// Unlike the cheap permission-string hint on [`FileEntry`], this reflects the
/// connecting user's *actual* ability to open the file for writing — it catches
/// the owner-mismatch case (e.g. a `rw-r--r--` file owned by another user).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Writability {
    /// The file could be opened for writing.
    Writable,
    /// The server denied the write-open with `PERMISSION_DENIED`.
    ReadOnly,
    /// The probe could not conclude (any other error) — treat as writable by the
    /// caller (attempt the write) so a false negative never blocks a save.
    Unknown,
}

/// Classify a failed write-open probe into a [`Writability`].
///
/// A `PERMISSION_DENIED` status is the authoritative "read-only" signal; every
/// other error (missing file, transport hiccup, unsupported op, …) is
/// inconclusive and maps to [`Writability::Unknown`] rather than a hard failure.
fn classify_write_open_error(err: &RusshSftpError) -> Writability {
    match err {
        RusshSftpError::Status(status) if status.status_code == StatusCode::PermissionDenied => {
            Writability::ReadOnly
        }
        _ => Writability::Unknown,
    }
}

/// Outcome of a privilege-elevated (`sudo`) remote write (issue #1328).
///
/// Serializes adjacently-tagged so the frontend can `switch` on `kind`:
/// `{ "kind": "success" }`, `{ "kind": "incorrectPassword" }`, or
/// `{ "kind": "other", "message": "…" }`. `IncorrectPassword` is the only
/// re-promptable case; `Other` carries a human-readable reason (sudo missing,
/// not in sudoers, `requiretty`, a write error, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ElevatedWriteResult {
    /// The destination file was rewritten with root privileges.
    Success,
    /// The supplied sudo password was rejected — safe to re-prompt.
    IncorrectPassword,
    /// Any other failure, with a message suitable for display.
    Other(String),
}

/// Fixed shell script executed under `sudo` to rewrite the destination from the
/// uploaded temp file, then delete the temp.
///
/// Uses **positional parameters** — `$1` is the temp path, `$2` the destination
/// — so the actual paths travel as separate `argv` words and are *never*
/// interpolated into this script body. `cat "$1" > "$2"` (not `mv`) preserves
/// the destination's existing owner, mode, and ACLs by rewriting in place.
const ELEVATED_WRITE_SCRIPT: &str = r#"cat "$1" > "$2" && rm -f "$1""#;

/// stderr substrings (lower-cased) that indicate sudo rejected the password and
/// the caller may safely re-prompt.
const SUDO_PASSWORD_MARKERS: &[&str] = &[
    "sorry, try again",
    "incorrect password",
    "no password was provided",
    "password is required",
];

/// Generate a termiHub-owned temp upload path: `/tmp/termihub-<uuid-v4>`.
///
/// The name is entirely tool-generated (a fresh v4 UUID), so no user or remote
/// text ever forms the temp path.
fn elevated_temp_path() -> String {
    format!("/tmp/termihub-{}", uuid::Uuid::new_v4())
}

/// POSIX-quote a path so it survives the remote login shell as a single word.
///
/// Wraps [`shlex::try_quote`]; fails only on a NUL byte (not a valid path).
fn shell_quote(path: &str) -> Result<String, TerminalError> {
    shlex::try_quote(path)
        .map(|q| q.into_owned())
        .map_err(|e| TerminalError::SshError(format!("cannot quote path for remote shell: {e}")))
}

/// Build the `sudo -S` command that rewrites `dest_path` from `temp_path`.
///
/// `sudo -S -p ''` reads the password from **stdin** with no prompt echoed. The
/// script body is the fixed [`ELEVATED_WRITE_SCRIPT`] literal (single-quoted, so
/// the remote shell passes it verbatim to `/bin/sh -c`); the temp and
/// destination paths follow as quoted positional arguments (`$1`, `$2`). The
/// destination is untrusted remote text, so it is POSIX-quoted — a path with
/// spaces, quotes, `;`, or `$(…)` cannot break out of the command.
fn build_sudo_write_command(temp_path: &str, dest_path: &str) -> Result<String, TerminalError> {
    let temp_q = shell_quote(temp_path)?;
    let dest_q = shell_quote(dest_path)?;
    // `sh` becomes $0; temp is $1, dest is $2.
    Ok(format!(
        "sudo -S -p '' /bin/sh -c '{ELEVATED_WRITE_SCRIPT}' sh {temp_q} {dest_q}"
    ))
}

/// Build the best-effort cleanup command that removes the temp upload.
///
/// Run as the connecting user (who owns the temp file) on any failure path so
/// the temp never leaks; on success the sudo script already removed it.
fn build_cleanup_command(temp_path: &str) -> Result<String, TerminalError> {
    Ok(format!("rm -f {}", shell_quote(temp_path)?))
}

/// Classify a completed sudo exec into an [`ElevatedWriteResult`].
///
/// A zero exit is success. Otherwise, sudo's wrong-password convention
/// ("Sorry, try again.", "N incorrect password attempts", "no password was
/// provided") maps to [`ElevatedWriteResult::IncorrectPassword`]; everything
/// else (not in sudoers, sudo missing, `requiretty`, write errors) maps to
/// [`ElevatedWriteResult::Other`] with a displayable message.
fn classify_sudo_result(stderr: &str, exit_status: i32) -> ElevatedWriteResult {
    if exit_status == 0 {
        return ElevatedWriteResult::Success;
    }
    let lower = stderr.to_lowercase();
    if SUDO_PASSWORD_MARKERS.iter().any(|m| lower.contains(m)) {
        return ElevatedWriteResult::IncorrectPassword;
    }
    let message = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("sudo failed (exit status {exit_status})"));
    ElevatedWriteResult::Other(message)
}

/// SFTP session backed by a dedicated SSH connection.
///
/// The canonical implementation is now
/// [`termihub_core::backends::ssh::SftpFileBrowser`](termihub_core::backends::ssh).
/// This struct is kept for the legacy SFTP command API used by the desktop file browser.
pub struct SftpSession {
    session: SshSession,
    sftp: RusshSftp,
}

impl SftpSession {
    /// Open a new SFTP session to the given SSH host.
    pub fn new(config: &SshConfig) -> Result<Self, TerminalError> {
        info!(host = %config.host, port = config.port, "Opening SFTP connection");
        let session = connect_and_authenticate(config)?;

        let sftp = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                sftp::open_sftp_subsystem(&session)
                    .await
                    .map_err(|e| TerminalError::SshError(e.to_string()))
            })
        })?;

        Ok(Self { session, sftp })
    }

    /// Report whether an exec (command) channel can be opened and used on the
    /// retained SSH connection.
    ///
    /// Runs a tiny probe that echoes a known marker back over an exec channel.
    /// A normal SSH+shell connection echoes it (`true`); an SFTP-only or
    /// relayed connection (e.g. `ForceCommand internal-sftp`) cannot run the
    /// command, so the marker never appears (`false`). Lets the file editor
    /// know whether privilege-elevated writes — which need a shell to run
    /// `sudo` — are possible for this connection.
    pub fn has_exec_capability(&self) -> bool {
        let probe = format!("echo {EXEC_PROBE_MARKER}");
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                match ssh_exec_with_stdin(&self.session, &probe, "").await {
                    Ok(output) => exec_probe_indicates_capability(&output),
                    Err(_) => false,
                }
            })
        })
    }

    /// Open a **dedicated** SFTP session on a fresh channel off the same
    /// authenticated SSH connection.
    ///
    /// Used by the cancellable transfer subsystem (#1245): the returned
    /// [`RusshSftp`] owns its own channel, so a chunked copy can run on it
    /// without holding this session's `Mutex` — keeping directory listing /
    /// navigation live on the browsing channel during a transfer.
    pub async fn open_dedicated_sftp(&self) -> Result<RusshSftp, TerminalError> {
        sftp::open_sftp_subsystem(&self.session)
            .await
            .map_err(|e| TerminalError::SshError(e.to_string()))
    }

    /// Best-effort size (in bytes) of a remote file via SFTP `stat`.
    ///
    /// Returns `0` when the size is unavailable — the UI treats `total == 0` as
    /// indeterminate and shows a spinner rather than a percentage.
    pub async fn remote_size(&self, remote_path: &str) -> u64 {
        match self.sftp.metadata(remote_path).await {
            Ok(meta) => meta.size.unwrap_or(0),
            Err(_) => 0,
        }
    }

    /// List directory contents, filtering out `.` and `..`.
    pub fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, TerminalError> {
        debug!(path, "SFTP listing directory");
        let path = path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                sftp::list_dir(&self.sftp, &path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("readdir failed: {e}")))
            })
        })
    }

    /// Download a remote file to a local path. Returns bytes written.
    pub fn read_file(&self, remote_path: &str, local_path: &str) -> Result<u64, TerminalError> {
        let remote_path = remote_path.to_string();
        let local_path = local_path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let mut remote = self
                    .sftp
                    .open(&remote_path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("open remote file: {e}")))?;

                let mut data = Vec::new();
                remote
                    .read_to_end(&mut data)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("read failed: {e}")))?;

                tokio::fs::write(&local_path, &data)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("write local file: {e}")))?;

                Ok::<u64, TerminalError>(data.len() as u64)
            })
        })
    }

    /// Upload a local file to a remote path. Returns bytes written.
    pub fn write_file(&self, local_path: &str, remote_path: &str) -> Result<u64, TerminalError> {
        let local_path = local_path.to_string();
        let remote_path = remote_path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let data = tokio::fs::read(&local_path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("open local file: {e}")))?;

                let mut remote = self
                    .sftp
                    .create(&remote_path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("create remote file: {e}")))?;

                remote
                    .write_all(&data)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("write failed: {e}")))?;

                Ok::<u64, TerminalError>(data.len() as u64)
            })
        })
    }

    /// Create a directory on the remote host.
    pub fn mkdir(&self, path: &str) -> Result<(), TerminalError> {
        let path = path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                self.sftp
                    .create_dir(&path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("mkdir failed: {e}")))
            })
        })
    }

    /// Remove a file on the remote host.
    pub fn remove_file(&self, path: &str) -> Result<(), TerminalError> {
        let path = path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                self.sftp
                    .remove_file(&path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("unlink failed: {e}")))
            })
        })
    }

    /// Remove an empty directory on the remote host.
    pub fn remove_dir(&self, path: &str) -> Result<(), TerminalError> {
        let path = path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                self.sftp
                    .remove_dir(&path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("rmdir failed: {e}")))
            })
        })
    }

    /// Read a remote file's contents as a UTF-8 string.
    pub fn read_file_content(&self, remote_path: &str) -> Result<String, TerminalError> {
        let remote_path = remote_path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let mut remote = self
                    .sftp
                    .open(&remote_path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("open remote file: {e}")))?;

                let mut content = String::new();
                remote
                    .read_to_string(&mut content)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("read failed: {e}")))?;

                Ok::<String, TerminalError>(content)
            })
        })
    }

    /// Write a string to a remote file, creating or overwriting it.
    pub fn write_file_content(
        &self,
        remote_path: &str,
        content: &str,
    ) -> Result<(), TerminalError> {
        self.write_bytes(remote_path, content.as_bytes())
    }

    /// Rename a file or directory on the remote host.
    pub fn rename(&self, old_path: &str, new_path: &str) -> Result<(), TerminalError> {
        let old_path = old_path.to_string();
        let new_path = new_path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                self.sftp
                    .rename(&old_path, &new_path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("rename failed: {e}")))
            })
        })
    }

    /// Get metadata for a single file or directory.
    #[allow(dead_code)]
    pub fn stat(&self, path: &str) -> Result<FileEntry, TerminalError> {
        let path = path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                sftp::stat(&self.sftp, &path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("stat failed: {e}")))
            })
        })
    }

    /// Authoritatively probe whether the connecting user can write `remote_path`.
    ///
    /// Opens the **existing** file for writing with `OpenFlags::WRITE` only — no
    /// `CREATE`, no `TRUNCATE`, no `APPEND` — so the file's contents are never
    /// modified; the handle is immediately shut down. This catches the
    /// owner-mismatch case the cheap permission hint cannot (a `rw-r--r--` file
    /// owned by another user). Never returns a hard error for the ambiguous case:
    /// a `PERMISSION_DENIED` maps to [`Writability::ReadOnly`], any other error
    /// to [`Writability::Unknown`] (logged, not propagated).
    pub fn check_writable(&self, remote_path: &str) -> Result<Writability, TerminalError> {
        let remote_path = remote_path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                match self
                    .sftp
                    .open_with_flags(&remote_path, OpenFlags::WRITE)
                    .await
                {
                    Ok(mut file) => {
                        // Wrote nothing; close the handle so the server releases it.
                        if let Err(e) = file.shutdown().await {
                            warn!(error = %e, "SFTP write probe: closing probe handle failed");
                        }
                        debug!("SFTP write probe: writable");
                        Ok(Writability::Writable)
                    }
                    Err(e) => {
                        let writability = classify_write_open_error(&e);
                        match writability {
                            Writability::ReadOnly => {
                                debug!("SFTP write probe: read-only (permission denied)")
                            }
                            _ => warn!(error = %e, "SFTP write probe: inconclusive, treating as unknown"),
                        }
                        Ok(writability)
                    }
                }
            })
        })
    }

    /// Resolve a remote path to its canonical absolute form via SFTP realpath.
    ///
    /// Passing `"."` yields the session's home directory, avoiding the fragile
    /// `/home/<user>` guess that breaks on non-Linux layouts (audit GAP C2,
    /// issue #1143).
    pub fn realpath(&self, path: &str) -> Result<String, TerminalError> {
        let path = path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                self.sftp
                    .canonicalize(&path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("realpath failed: {e}")))
            })
        })
    }

    /// Read a remote file's contents as raw bytes.
    #[allow(dead_code)]
    pub fn read_bytes(&self, remote_path: &str) -> Result<Vec<u8>, TerminalError> {
        let remote_path = remote_path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let mut remote = self
                    .sftp
                    .open(&remote_path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("open remote file: {e}")))?;

                let mut data = Vec::new();
                remote
                    .read_to_end(&mut data)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("read failed: {e}")))?;

                Ok::<Vec<u8>, TerminalError>(data)
            })
        })
    }

    /// Write raw bytes to a remote file, creating or overwriting it.
    #[allow(dead_code)]
    pub fn write_bytes(&self, remote_path: &str, data: &[u8]) -> Result<(), TerminalError> {
        let data = data.to_vec();
        let remote_path = remote_path.to_string();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let mut remote = self
                    .sftp
                    .create(&remote_path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("create remote file: {e}")))?;

                remote
                    .write_all(&data)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("write failed: {e}")))
            })
        })
    }

    /// Run a command over the retained SSH exec channel, blocking the current
    /// (blocking-pool) thread on the async call. `stdin` is written to the
    /// command's standard input and never logged.
    fn run_exec_blocking(
        &self,
        command: &str,
        stdin: &str,
    ) -> Result<SshExecOutput, TerminalError> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                ssh_exec_with_stdin(&self.session, command, stdin)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("exec channel failed: {e}")))
            })
        })
    }

    /// Best-effort removal of the temp upload as the connecting user; failures
    /// are logged, not propagated (the caller is already returning an outcome).
    fn cleanup_elevated_temp(&self, temp_path: &str) {
        match build_cleanup_command(temp_path) {
            Ok(cmd) => {
                if let Err(e) = self.run_exec_blocking(&cmd, "") {
                    warn!(error = %e, "elevated save: temp cleanup exec failed");
                }
            }
            Err(e) => warn!(error = %e, "elevated save: could not build cleanup command"),
        }
    }

    /// Write `content` to `remote_path` with `sudo`-elevated privileges (#1328).
    ///
    /// Steps: (1) upload `content` to a termiHub-generated `/tmp/termihub-<uuid>`
    /// via SFTP; (2) `sudo -S -p ''` a fixed `/bin/sh` script that does
    /// `cat "$1" > "$2" && rm -f "$1"` — rewriting the destination in place
    /// (preserving owner/mode/ACLs) and removing the temp — with the sudo
    /// password supplied as a single stdin line; (3) classify the result into
    /// [`ElevatedWriteResult`]. On any non-success path the temp file is removed
    /// best-effort so it never leaks.
    ///
    /// The destination path is POSIX-quoted and passed as a positional argument,
    /// so a hostile remote path cannot inject shell commands. The password is
    /// only ever sent on stdin and is **never** logged.
    pub fn write_file_content_elevated(
        &self,
        remote_path: &str,
        content: &str,
        sudo_password: &str,
    ) -> Result<ElevatedWriteResult, TerminalError> {
        let temp_path = elevated_temp_path();
        debug!(
            remote_path,
            temp_path, "SFTP elevated save: uploading temp buffer"
        );

        // 1. Upload the buffer to the temp path via the existing SFTP write.
        if let Err(e) = self.write_bytes(&temp_path, content.as_bytes()) {
            // Nothing durable was created if create/write failed, but attempt a
            // cleanup anyway in case a partial file exists.
            self.cleanup_elevated_temp(&temp_path);
            return Err(e);
        }

        // 2. Run the sudo rewrite. Password is one stdin line — never logged.
        let command = build_sudo_write_command(&temp_path, remote_path)?;
        let stdin = format!("{sudo_password}\n");
        let outcome = match self.run_exec_blocking(&command, &stdin) {
            Ok(output) => classify_sudo_result(&output.stderr, output.exit_status),
            Err(e) => ElevatedWriteResult::Other(e.to_string()),
        };

        // 3. On any failure, best-effort remove the temp (the sudo script only
        //    removes it on its own success).
        if outcome != ElevatedWriteResult::Success {
            self.cleanup_elevated_temp(&temp_path);
        }

        debug!(remote_path, ?outcome, "SFTP elevated save: completed");
        Ok(outcome)
    }
}

/// Map a `TerminalError` to a `FileError::OperationFailed`.
#[allow(dead_code)]
fn terminal_error_to_file_error(e: TerminalError) -> FileError {
    FileError::OperationFailed(e.to_string())
}

/// Async file backend implementation backed by an SFTP session.
#[allow(dead_code)]
pub struct SftpFileBackend {
    session: Arc<Mutex<SftpSession>>,
}

#[allow(dead_code)]
impl SftpFileBackend {
    pub fn new(session: Arc<Mutex<SftpSession>>) -> Self {
        Self { session }
    }
}

#[async_trait::async_trait]
impl FileBackend for SftpFileBackend {
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.list_dir(&path).map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.read_bytes(&path).map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        let data = data.to_vec();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.write_bytes(&path, &data)
                .map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn delete(&self, path: &str, is_directory: bool) -> Result<(), FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            if is_directory {
                sftp.remove_dir(&path)
            } else {
                sftp.remove_file(&path)
            }
            .map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), FileError> {
        let session = self.session.clone();
        let old_path = old_path.to_string();
        let new_path = new_path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.rename(&old_path, &new_path)
                .map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.stat(&path).map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.mkdir(&path).map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }
}

/// Manages multiple SFTP sessions keyed by UUID.
///
/// `Clone` (the session map is behind an `Arc`) so SFTP commands can move a
/// handle into `spawn_blocking` — the SSH/SFTP calls block, and running them on
/// a blocking-pool thread (rather than the Tauri command thread) is what keeps
/// `block_in_place` valid and avoids starving the async runtime.
#[derive(Clone)]
pub struct SftpManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>>,
}

impl Default for SftpManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Open a new SFTP session. Returns the session UUID.
    pub fn open_session(&self, config: &SshConfig) -> Result<String, TerminalError> {
        let session = SftpSession::new(config)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut sessions = lock_session(&self.sessions)?;
        sessions.insert(id.clone(), Arc::new(Mutex::new(session)));
        Ok(id)
    }

    /// Close and drop an SFTP session.
    pub fn close_session(&self, id: &str) {
        info!(session_id = id, "Closing SFTP session");
        // Recover the guard even if the map mutex is poisoned — removing a
        // session is cleanup and must not itself panic (audit GAP C1, #1143).
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.remove(id);
    }

    /// Close and drop every open SFTP session, tearing down each SSH+SFTP
    /// connection.
    ///
    /// Called on app quit so no session is left dangling on the server until it
    /// times out. Poison-safe: a prior panic that poisoned the sessions mutex
    /// does not abort teardown (mirrors [`Self::close_session`], issue #1244).
    pub fn close_all(&self) {
        let count = drain_sessions(&self.sessions);
        info!(session_count = count, "Closing all SFTP sessions");
    }

    /// Get a session Arc for use outside the manager lock.
    pub fn get_session(&self, id: &str) -> Result<Arc<Mutex<SftpSession>>, TerminalError> {
        let sessions = lock_session(&self.sessions)?;
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::SftpSessionNotFound(id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn probe_output(stdout: &str, exit_status: i32) -> SshExecOutput {
        SshExecOutput {
            stdout: stdout.to_string(),
            exit_status,
            ..Default::default()
        }
    }

    /// A shell connection echoes the probe marker with exit 0 → capable.
    #[test]
    fn exec_probe_true_when_marker_echoed_and_exit_zero() {
        let output = probe_output(&format!("{EXEC_PROBE_MARKER}\n"), 0);
        assert!(exec_probe_indicates_capability(&output));
    }

    /// An SFTP-only channel yields no marker (e.g. binary SFTP bytes, even at
    /// exit 0) → not capable.
    #[test]
    fn exec_probe_false_when_marker_absent() {
        let output = probe_output("\u{0}\u{0}sftp-subsystem-bytes", 0);
        assert!(!exec_probe_indicates_capability(&output));
    }

    /// A non-zero exit means the probe did not run cleanly → not capable.
    #[test]
    fn exec_probe_false_on_nonzero_exit() {
        let output = probe_output(&format!("{EXEC_PROBE_MARKER}\n"), 1);
        assert!(!exec_probe_indicates_capability(&output));
    }

    /// Build a synthetic SFTP status error for the given status code.
    fn status_error(code: StatusCode) -> RusshSftpError {
        RusshSftpError::Status(russh_sftp::protocol::Status {
            id: 0,
            status_code: code,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }

    /// A `PERMISSION_DENIED` write-open is the authoritative read-only signal.
    #[test]
    fn classify_permission_denied_is_read_only() {
        let err = status_error(StatusCode::PermissionDenied);
        assert_eq!(classify_write_open_error(&err), Writability::ReadOnly);
    }

    /// Any other status (e.g. missing file) is inconclusive → Unknown.
    #[test]
    fn classify_other_status_is_unknown() {
        let err = status_error(StatusCode::NoSuchFile);
        assert_eq!(classify_write_open_error(&err), Writability::Unknown);
        let err = status_error(StatusCode::Failure);
        assert_eq!(classify_write_open_error(&err), Writability::Unknown);
    }

    /// Non-status errors (transport/protocol) are also inconclusive → Unknown.
    #[test]
    fn classify_non_status_error_is_unknown() {
        let err = RusshSftpError::Timeout;
        assert_eq!(classify_write_open_error(&err), Writability::Unknown);
    }

    /// `Writability` serializes as camelCase strings for the frontend.
    #[test]
    fn writability_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(Writability::ReadOnly).unwrap(),
            serde_json::json!("readOnly")
        );
        assert_eq!(
            serde_json::to_value(Writability::Writable).unwrap(),
            serde_json::json!("writable")
        );
        assert_eq!(
            serde_json::to_value(Writability::Unknown).unwrap(),
            serde_json::json!("unknown")
        );
    }

    // --- Elevated (sudo) save: command composition + classification (#1328) ---

    /// The termiHub-generated temp path has the expected `/tmp/termihub-<uuid>`
    /// shape (a v4 UUID suffix), so no user text ever forms the temp name.
    #[test]
    fn elevated_temp_path_has_expected_shape() {
        let path = elevated_temp_path();
        let suffix = path
            .strip_prefix("/tmp/termihub-")
            .expect("temp path must be under /tmp with the termihub- prefix");
        // The suffix must parse as a UUID (36 chars, hyphenated hex).
        uuid::Uuid::parse_str(suffix).expect("temp suffix must be a valid UUID");
        // Two calls must differ (fresh UUID each time).
        assert_ne!(path, elevated_temp_path());
    }

    /// The sudo command embeds the fixed script literal and passes both paths as
    /// positional argv (`$1` = temp, `$2` = dest) — never interpolated into the
    /// script body — with `sudo -S -p ''` reading the password from stdin.
    #[test]
    fn build_sudo_write_command_uses_fixed_script_and_argv() {
        let cmd = build_sudo_write_command("/tmp/termihub-abc", "/etc/hosts")
            .expect("clean paths must quote successfully");
        assert!(
            cmd.starts_with("sudo -S -p '' /bin/sh -c 'cat \"$1\" > \"$2\" && rm -f \"$1\"' sh "),
            "command must lead with sudo + the fixed single-quoted script literal, got: {cmd}"
        );
        // The paths follow the script as separate argv words.
        assert!(cmd.ends_with(" /tmp/termihub-abc /etc/hosts"), "got: {cmd}");
        // `mv` must never be used — `cat >` preserves owner/mode/ACLs.
        assert!(!cmd.contains("mv "), "must use `cat >`, not `mv`");
    }

    /// A malicious destination path (spaces, quotes, shell metacharacters,
    /// command substitution, backticks) is quoted so it can never break out of
    /// the command. Proven by round-tripping: re-parsing the built command as
    /// shell words must yield the hostile path back as exactly ONE argument
    /// (the final one), so it lands as `$2` data — never as executable tokens.
    #[test]
    fn build_sudo_write_command_neutralizes_injection_in_dest() {
        for evil in [
            "/etc/foo'; rm -rf / #",
            "/x/$(reboot)",
            "/a/`reboot`",
            "/b/with space and \"quote\"",
            "/c/; shutdown -h now",
        ] {
            let temp = "/tmp/termihub-xyz";
            let cmd = build_sudo_write_command(temp, evil)
                .expect("even a hostile path must quote successfully");
            // The script body is always the untouched fixed literal.
            assert!(
                cmd.contains("/bin/sh -c 'cat \"$1\" > \"$2\" && rm -f \"$1\"'"),
                "script literal must be intact, got: {cmd}"
            );
            // Re-tokenize the whole command as a shell would.
            let words = shlex::split(&cmd)
                .unwrap_or_else(|| panic!("built command must be valid shell words: {cmd}"));
            // The hostile path survives as the single final argument ($2), and
            // the temp path as the one before it ($1) — no breakout occurred.
            assert_eq!(
                words.last().map(String::as_str),
                Some(evil),
                "hostile dest must round-trip as one argument: {cmd}"
            );
            assert_eq!(
                words.get(words.len() - 2).map(String::as_str),
                Some(temp),
                "temp path must be the preceding argument: {cmd}"
            );
        }
    }

    /// The failure-cleanup command removes exactly the temp file, quoted.
    #[test]
    fn build_cleanup_command_removes_quoted_temp() {
        let cmd = build_cleanup_command("/tmp/termihub-abc").expect("clean path quotes");
        assert_eq!(cmd, "rm -f /tmp/termihub-abc");
        // A temp name is termiHub-generated so it never contains metachars, but
        // the builder still quotes defensively.
        let cmd = build_cleanup_command("/tmp/te mp").expect("quotes");
        assert_eq!(cmd, "rm -f '/tmp/te mp'");
    }

    /// A zero exit status is an unconditional success.
    #[test]
    fn classify_success_on_zero_exit() {
        assert_eq!(classify_sudo_result("", 0), ElevatedWriteResult::Success);
        // Even stray stderr noise with exit 0 is success.
        assert_eq!(
            classify_sudo_result("some warning\n", 0),
            ElevatedWriteResult::Success
        );
    }

    /// sudo's wrong-password convention ("Sorry, try again." /
    /// "N incorrect password attempts") maps to the re-promptable variant.
    #[test]
    fn classify_incorrect_password_from_sudo_stderr() {
        for stderr in [
            "Sorry, try again.\n",
            "[sudo] password for alice: \nSorry, try again.\nsudo: 1 incorrect password attempt\n",
            "sudo: 3 incorrect password attempts\n",
            "sudo: no password was provided\n",
            "sudo: a password is required\n",
        ] {
            assert_eq!(
                classify_sudo_result(stderr, 1),
                ElevatedWriteResult::IncorrectPassword,
                "stderr should classify as IncorrectPassword: {stderr:?}"
            );
        }
    }

    /// sudo-not-permitted, missing sudo, requiretty, and write errors all map to
    /// `Other` carrying a message (never mistaken for a wrong password).
    #[test]
    fn classify_other_for_non_password_failures() {
        let cases = [
            "alice is not in the sudoers file.  This incident will be reported.\n",
            "sudo: command not found\n",
            "sudo: sorry, you must have a tty to run sudo\n",
            "/bin/sh: 1: cannot create /etc/hosts: Permission denied\n",
        ];
        for stderr in cases {
            match classify_sudo_result(stderr, 1) {
                ElevatedWriteResult::Other(msg) => {
                    assert!(
                        !msg.is_empty(),
                        "Other message must be populated: {stderr:?}"
                    );
                }
                other => panic!("expected Other for {stderr:?}, got {other:?}"),
            }
        }
    }

    /// A non-zero exit with empty stderr still classifies as `Other` with a
    /// non-empty fallback message (so the UI never shows a blank error).
    #[test]
    fn classify_other_with_fallback_when_stderr_empty() {
        match classify_sudo_result("   \n", 127) {
            ElevatedWriteResult::Other(msg) => assert!(msg.contains("127")),
            other => panic!("expected Other, got {other:?}"),
        }
    }

    /// `ElevatedWriteResult` serializes to an adjacently-tagged JSON shape the
    /// frontend can switch on: `{kind}` for unit variants, `{kind, message}`
    /// for `Other`.
    #[test]
    fn elevated_write_result_serializes_for_frontend() {
        assert_eq!(
            serde_json::to_value(ElevatedWriteResult::Success).unwrap(),
            serde_json::json!({ "kind": "success" })
        );
        assert_eq!(
            serde_json::to_value(ElevatedWriteResult::IncorrectPassword).unwrap(),
            serde_json::json!({ "kind": "incorrectPassword" })
        );
        assert_eq!(
            serde_json::to_value(ElevatedWriteResult::Other("boom".to_string())).unwrap(),
            serde_json::json!({ "kind": "other", "message": "boom" })
        );
    }

    // ── Docker-backed elevated-save integration tests ────────────────────
    //
    // Exercise the real `SftpSession::write_file_content_elevated` path
    // end-to-end over a live SSH connection (temp SFTP upload → `sudo -S`
    // rewrite → typed classification → temp cleanup), covering the three
    // outcomes the #1328 unit tests can only stub: correct password, wrong
    // password, and no-sudo. They self-skip when the container is not up,
    // mirroring the "Agent Deploy SFTP" test in `utils::remote_exec` and the
    // `require_docker!` convention in `core/tests/common`. Bring the fixtures
    // up with:
    //   docker compose -f tests/docker/docker-compose.yml up -d ssh-sudo ssh-nosudo
    //
    // Ports are read from `TERMIHUB_TEST_SSH_SUDO_PORT` (default 2212) and
    // `TERMIHUB_TEST_SSH_NOSUDO_PORT` (default 2213) so a sharded / parallel
    // run can point at a separate container instance. A second, plain SSH
    // session (as `testuser`) reads the world-readable root-owned target back
    // to verify contents/owner/mode and to confirm no `/tmp/termihub-*` temp
    // leaked — never the elevated write path itself.
    use crate::utils::remote_exec::run_remote_command;

    /// Root-owned file the fixtures ship (see `tests/docker/ssh-sudo`).
    const ELEVATED_TARGET: &str = "/etc/termihub-elevated-target.txt";
    /// Default host ports of the elevated-save fixtures (`tests/docker`).
    const DEFAULT_SSH_SUDO_PORT: u16 = 2212;
    const DEFAULT_SSH_NOSUDO_PORT: u16 = 2213;

    fn env_port(var: &str, default: u16) -> u16 {
        std::env::var(var)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    }

    /// Returns `true` if a TCP connection to the SSH server succeeds quickly.
    fn ssh_port_reachable(port: u16) -> bool {
        use std::net::TcpStream;
        use std::time::Duration;
        format!("127.0.0.1:{port}")
            .parse()
            .ok()
            .and_then(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok())
            .is_some()
    }

    /// Password-auth config for a fixture container on `127.0.0.1:port`.
    fn testuser_config(port: u16, password: &str) -> SshConfig {
        SshConfig {
            host: "127.0.0.1".to_string(),
            port,
            username: "testuser".to_string(),
            auth_method: "password".to_string(),
            password: Some(password.to_string()),
            ..Default::default()
        }
    }

    /// Count of leftover `/tmp/termihub-*` temp files as seen by `testuser`.
    fn temp_leftover_count(verify: &SshSession) -> Result<usize, TerminalError> {
        // `2>/dev/null` swallows the "No such file" when the glob matches
        // nothing; `printf %s` avoids `wc`'s leading whitespace.
        let out = run_remote_command(
            verify,
            "ls -1d /tmp/termihub-* 2>/dev/null | grep -c . || true",
        )?;
        Ok(out.trim().parse().unwrap_or(0))
    }

    /// Correct password → `Success`: the root-owned file is rewritten, its
    /// owner/mode are preserved, and no temp upload leaks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn elevated_save_success_rewrites_root_file_over_real_ssh() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !ssh_port_reachable(port) {
            eprintln!(
                "SKIPPED: ssh-sudo container not reachable on port {port} \
                 (start with: docker compose -f tests/docker/docker-compose.yml up -d ssh-sudo)"
            );
            return;
        }

        let result = tokio::task::spawn_blocking(move || {
            let config = testuser_config(port, "testpass");
            let verify = connect_and_authenticate(&config)?;

            let stat_cmd = format!("stat -c '%U %G %a' {ELEVATED_TARGET}");
            let stat_before = run_remote_command(&verify, &stat_cmd)?;

            let session = SftpSession::new(&config)?;
            let new_content = format!("elevated-rewrite-{}\n", uuid::Uuid::new_v4());
            let outcome =
                session.write_file_content_elevated(ELEVATED_TARGET, &new_content, "testpass")?;

            let after = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;
            let stat_after = run_remote_command(&verify, &stat_cmd)?;
            let leftover = temp_leftover_count(&verify)?;

            Ok::<_, TerminalError>((
                outcome,
                new_content,
                after,
                stat_before,
                stat_after,
                leftover,
            ))
        })
        .await
        .expect("spawn_blocking join");

        let (outcome, new_content, after, stat_before, stat_after, leftover) =
            result.expect("elevated save (success) should complete");

        assert_eq!(outcome, ElevatedWriteResult::Success, "expected Success");
        assert_eq!(
            after,
            new_content.trim(),
            "root-owned file should hold the newly written content"
        );
        assert_eq!(
            stat_before, stat_after,
            "owner/group/mode must be unchanged by the elevated rewrite"
        );
        assert_eq!(
            stat_after, "root root 644",
            "target must remain root-owned, mode 644"
        );
        assert_eq!(leftover, 0, "no /tmp/termihub-* temp should remain");
    }

    /// Wrong password → `IncorrectPassword`: the file is untouched and the temp
    /// upload is cleaned up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn elevated_save_wrong_password_leaves_file_untouched() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !ssh_port_reachable(port) {
            eprintln!(
                "SKIPPED: ssh-sudo container not reachable on port {port} \
                 (start with: docker compose -f tests/docker/docker-compose.yml up -d ssh-sudo)"
            );
            return;
        }

        let result = tokio::task::spawn_blocking(move || {
            let config = testuser_config(port, "testpass");
            let verify = connect_and_authenticate(&config)?;

            let before = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;

            let session = SftpSession::new(&config)?;
            let new_content = format!("should-not-land-{}\n", uuid::Uuid::new_v4());
            let outcome = session.write_file_content_elevated(
                ELEVATED_TARGET,
                &new_content,
                "definitely-the-wrong-password",
            )?;

            let after = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;
            let leftover = temp_leftover_count(&verify)?;

            Ok::<_, TerminalError>((outcome, before, after, leftover))
        })
        .await
        .expect("spawn_blocking join");

        let (outcome, before, after, leftover) =
            result.expect("elevated save (wrong password) should complete");

        assert_eq!(
            outcome,
            ElevatedWriteResult::IncorrectPassword,
            "a rejected sudo password must classify as IncorrectPassword"
        );
        assert_eq!(
            after, before,
            "file must be unchanged on a rejected password"
        );
        assert_eq!(leftover, 0, "temp upload must be cleaned up on failure");
    }

    /// No sudo installed → `Other`: the file is untouched and the temp upload is
    /// cleaned up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn elevated_save_without_sudo_returns_other() {
        let port = env_port("TERMIHUB_TEST_SSH_NOSUDO_PORT", DEFAULT_SSH_NOSUDO_PORT);
        if !ssh_port_reachable(port) {
            eprintln!(
                "SKIPPED: ssh-nosudo container not reachable on port {port} \
                 (start with: docker compose -f tests/docker/docker-compose.yml up -d ssh-nosudo)"
            );
            return;
        }

        let result = tokio::task::spawn_blocking(move || {
            let config = testuser_config(port, "testpass");
            let verify = connect_and_authenticate(&config)?;

            let before = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;

            let session = SftpSession::new(&config)?;
            let new_content = format!("should-not-land-{}\n", uuid::Uuid::new_v4());
            let outcome =
                session.write_file_content_elevated(ELEVATED_TARGET, &new_content, "testpass")?;

            let after = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;
            let leftover = temp_leftover_count(&verify)?;

            Ok::<_, TerminalError>((outcome, before, after, leftover))
        })
        .await
        .expect("spawn_blocking join");

        let (outcome, before, after, leftover) =
            result.expect("elevated save (no sudo) should complete");

        match outcome {
            ElevatedWriteResult::Other(msg) => {
                assert!(!msg.is_empty(), "Other must carry a displayable message")
            }
            other => panic!("expected Other when sudo is unavailable, got {other:?}"),
        }
        assert_eq!(
            after, before,
            "file must be unchanged when sudo is unavailable"
        );
        assert_eq!(leftover, 0, "temp upload must be cleaned up on failure");
    }

    /// The lock helper must map a poisoned mutex to a recoverable
    /// `TerminalError` instead of panicking (audit GAP C1, #1143).
    #[test]
    fn lock_session_maps_poisoned_mutex_to_error() {
        let mutex = Arc::new(Mutex::new(0i32));

        // Poison the mutex by panicking while holding the lock.
        let poisoner = Arc::clone(&mutex);
        let handle = thread::spawn(move || {
            let _guard = poisoner.lock().expect("first lock should succeed");
            panic!("intentional panic to poison the mutex");
        });
        assert!(handle.join().is_err(), "poisoning thread should panic");

        // A raw `.lock().unwrap()` would panic here; the helper must not.
        let result = lock_session(&mutex);
        assert!(
            matches!(result, Err(TerminalError::SshError(_))),
            "poisoned lock should return a recoverable SshError, got {result:?}"
        );
    }

    /// On a healthy mutex the helper returns a usable guard.
    #[test]
    fn lock_session_returns_guard_when_healthy() {
        let mutex = Mutex::new(41i32);
        let mut guard = lock_session(&mutex).expect("healthy lock should succeed");
        *guard += 1;
        assert_eq!(*guard, 42);
    }

    /// `close_all`'s drain must empty the map even when the map mutex is
    /// poisoned by a prior panic — teardown on quit must never itself abort
    /// (mirrors `close_session`'s poison handling, issue #1244). Uses a
    /// `String`-valued map so no real SSH/SFTP session is required.
    #[test]
    fn drain_sessions_empties_map_despite_poisoned_mutex() {
        let sessions: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut guard = sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.insert("session-a".to_string(), "a".to_string());
            guard.insert("session-b".to_string(), "b".to_string());
        }

        // Poison the sessions mutex by panicking while holding the lock.
        let poisoner = Arc::clone(&sessions);
        let handle = thread::spawn(move || {
            let _guard = poisoner.lock().expect("first lock should succeed");
            panic!("intentional panic to poison the sessions mutex");
        });
        assert!(handle.join().is_err(), "poisoning thread should panic");

        // A raw `.lock().unwrap()` inside the drain would panic here.
        let drained = drain_sessions(&sessions);
        assert_eq!(drained, 2, "drain should report the two removed sessions");

        let guard = sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(
            guard.is_empty(),
            "drain should empty the sessions map, still had {} entries",
            guard.len()
        );
    }
}
