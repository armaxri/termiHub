//! Thin file-operations facade over a session's file-browser capability.
//!
//! Extracted from [`SessionManager`](super::manager::SessionManager) (#2076) to
//! keep the manager focused on session lifecycle. Every method here is a pure
//! pass-through: resolve the session's [`FileBrowser`], forward the call, and
//! map errors to [`TerminalError`]. The behavior, error messages, and lock
//! discipline are exactly what lived inline on the manager — the `sessions`
//! lock is held across the browser `await`, as before.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use termihub_core::backends::ssh::{SftpAdvancedOps, SftpFileBrowser};
use termihub_core::files::{FileBrowser, FileEntry};

use crate::files::sftp::{sftp_op_error, ElevatedWriteResult, Writability};
use crate::utils::errors::TerminalError;

use super::manager::SessionEntry;

/// Borrowing facade exposing a session's file-browser operations.
///
/// Holds only a borrow of the manager's `sessions` map, so it carries no state
/// of its own; the manager constructs one on demand via
/// [`SessionManager::file_ops`](super::manager::SessionManager). Each method
/// mirrors the corresponding [`FileBrowser`] operation.
pub(super) struct FileOps<'a> {
    sessions: &'a Mutex<HashMap<String, SessionEntry>>,
}

impl<'a> FileOps<'a> {
    /// Wrap the manager's `sessions` map.
    pub(super) fn new(sessions: &'a Mutex<HashMap<String, SessionEntry>>) -> Self {
        Self { sessions }
    }

    /// Resolve a session's file browser, preserving the manager's exact errors:
    /// [`TerminalError::SessionNotFound`] when the session is unknown and
    /// [`TerminalError::RemoteError`] when it exposes no file-browser capability.
    fn browser<'g>(
        sessions: &'g HashMap<String, SessionEntry>,
        session_id: &str,
    ) -> Result<&'g dyn FileBrowser, TerminalError> {
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        entry
            .connection
            .file_browser()
            .ok_or_else(|| TerminalError::RemoteError("No file browser capability".to_string()))
    }

    /// List directory contents via the session's file browser.
    pub(super) async fn list_dir(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<FileEntry>, TerminalError> {
        let sessions = self.sessions.lock().await;
        let browser = Self::browser(&sessions, session_id)?;
        browser
            .list_dir(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Read a file via the session's file browser.
    pub(super) async fn read_file(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<u8>, TerminalError> {
        let sessions = self.sessions.lock().await;
        let browser = Self::browser(&sessions, session_id)?;
        browser
            .read_file(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Get metadata for a single file via the session's file browser.
    pub(super) async fn stat(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<FileEntry, TerminalError> {
        let sessions = self.sessions.lock().await;
        let browser = Self::browser(&sessions, session_id)?;
        browser
            .stat(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Write a file via the session's file browser.
    pub(super) async fn write_file(
        &self,
        session_id: &str,
        path: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let browser = Self::browser(&sessions, session_id)?;
        browser
            .write_file(path, data)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Delete a file via the session's file browser.
    pub(super) async fn delete(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let browser = Self::browser(&sessions, session_id)?;
        browser
            .delete(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Rename a file via the session's file browser.
    pub(super) async fn rename(
        &self,
        session_id: &str,
        from: &str,
        to: &str,
    ) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let browser = Self::browser(&sessions, session_id)?;
        browser
            .rename(from, to)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Create a directory via the session's file browser.
    pub(super) async fn mkdir(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let browser = Self::browser(&sessions, session_id)?;
        browser
            .mkdir(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Resolve an **owned** [`Arc<SftpFileBrowser>`] for a session, so a caller
    /// can drop the sessions lock before driving a (potentially slow) SFTP
    /// operation or move the handle into a background transfer task.
    ///
    /// The session's file browser is stored borrowed inside the connection under
    /// the sessions lock; the base [`FileBrowser`] capability exposes none of the
    /// SFTP advanced ops or transfer handles. This downcasts the browser to the
    /// concrete [`SftpFileBrowser`] via [`FileBrowser::as_any`] and clones it —
    /// the clone shares the same underlying SFTP connection (its `state` lives
    /// behind an `Arc`), mirroring how the desktop `SftpManager` hands out
    /// `Arc<SftpFileBrowser>` (#2312). The lock is released as soon as this
    /// returns.
    ///
    /// Fails with [`TerminalError::RemoteError`] when the session has no file
    /// browser or its browser is not SFTP-backed (e.g. a local/docker/FTP
    /// session), preserving the "not supported" shape of the surrounding facade.
    pub(super) async fn sftp_browser(
        &self,
        session_id: &str,
    ) -> Result<Arc<SftpFileBrowser>, TerminalError> {
        let sessions = self.sessions.lock().await;
        let browser = Self::browser(&sessions, session_id)?;
        let sftp = browser
            .as_any()
            .and_then(|any| any.downcast_ref::<SftpFileBrowser>())
            .ok_or_else(|| {
                TerminalError::RemoteError(
                    "Session file browser does not support SFTP advanced operations".to_string(),
                )
            })?;
        Ok(Arc::new(sftp.clone()))
    }

    /// Resolve a remote path to its canonical absolute form via SFTP realpath.
    ///
    /// Session-path mirror of the standalone `sftp_realpath` command; errors are
    /// mapped with [`sftp_op_error`] so the messages match the standalone path.
    pub(super) async fn realpath(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<String, TerminalError> {
        let sftp = self.sftp_browser(session_id).await?;
        sftp.realpath(path).await.map_err(sftp_op_error)
    }

    /// Authoritatively probe whether a remote file is writable by the connecting
    /// user, via the non-destructive SFTP write-open probe.
    ///
    /// Session-path mirror of the standalone `sftp_check_writable` command.
    pub(super) async fn check_writable(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> Result<Writability, TerminalError> {
        let sftp = self.sftp_browser(session_id).await?;
        sftp.check_writable(remote_path)
            .await
            .map_err(sftp_op_error)
    }

    /// Write `content` to `remote_path` with `sudo`-elevated privileges.
    ///
    /// Session-path mirror of the standalone `sftp_write_file_content_elevated`
    /// command; returns a typed [`ElevatedWriteResult`] rather than erroring on an
    /// authorization failure so the caller can re-prompt.
    pub(super) async fn write_file_elevated(
        &self,
        session_id: &str,
        remote_path: &str,
        content: &str,
        sudo_password: &str,
    ) -> Result<ElevatedWriteResult, TerminalError> {
        let sftp = self.sftp_browser(session_id).await?;
        sftp.write_file_content_elevated(remote_path, content, sudo_password)
            .await
            .map_err(sftp_op_error)
    }

    /// Report whether the session's SFTP connection can open an exec channel
    /// (i.e. run remote commands such as `sudo`).
    ///
    /// Session-path mirror of the standalone `sftp_has_exec_capability` command:
    /// a dropped / SFTP-only connection maps to `false` rather than erroring.
    pub(super) async fn has_exec_capability(
        &self,
        session_id: &str,
    ) -> Result<bool, TerminalError> {
        let sftp = self.sftp_browser(session_id).await?;
        Ok(sftp.has_exec_capability().await.unwrap_or(false))
    }
}
