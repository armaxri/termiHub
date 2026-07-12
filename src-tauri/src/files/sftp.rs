use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use russh_sftp::client::SftpSession as RusshSftp;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{debug, info};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::backends::ssh::{ssh_exec_with_stdin, SshExecOutput};
use termihub_core::errors::FileError;
use termihub_core::files::utils::{chrono_from_epoch, format_permissions};
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
                let channel = session
                    .channel_open_session()
                    .await
                    .map_err(|e| TerminalError::SshError(format!("SFTP channel open: {e}")))?;
                channel
                    .request_subsystem(true, "sftp")
                    .await
                    .map_err(|e| TerminalError::SshError(format!("SFTP subsystem request: {e}")))?;
                RusshSftp::new(channel.into_stream())
                    .await
                    .map_err(|e| TerminalError::SshError(format!("SFTP init: {e}")))
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
        let channel = self
            .session
            .channel_open_session()
            .await
            .map_err(|e| TerminalError::SshError(format!("transfer channel open: {e}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| TerminalError::SshError(format!("transfer subsystem request: {e}")))?;
        RusshSftp::new(channel.into_stream())
            .await
            .map_err(|e| TerminalError::SshError(format!("transfer SFTP init: {e}")))
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
                let entries = self
                    .sftp
                    .read_dir(&path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("readdir failed: {e}")))?;

                let mut result = Vec::new();
                for entry in entries {
                    let name = entry.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let meta = entry.metadata();
                    let full_path = format!("{}/{}", path.trim_end_matches('/'), name);
                    result.push(FileEntry {
                        name,
                        path: full_path,
                        is_directory: meta.is_dir(),
                        size: meta.size.unwrap_or(0),
                        modified: meta
                            .mtime
                            .map(|t| chrono_from_epoch(t as u64))
                            .unwrap_or_default(),
                        permissions: meta.permissions.map(format_permissions),
                    });
                }
                Ok::<Vec<FileEntry>, TerminalError>(result)
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
                let meta = self
                    .sftp
                    .metadata(&path)
                    .await
                    .map_err(|e| TerminalError::SshError(format!("stat failed: {e}")))?;

                let name = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                Ok::<FileEntry, TerminalError>(FileEntry {
                    name,
                    path,
                    is_directory: meta.is_dir(),
                    size: meta.size.unwrap_or(0),
                    modified: meta
                        .mtime
                        .map(|t| chrono_from_epoch(t as u64))
                        .unwrap_or_default(),
                    permissions: meta.permissions.map(format_permissions),
                })
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
