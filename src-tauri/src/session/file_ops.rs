//! Thin file-operations facade over a session's file-browser capability.
//!
//! Extracted from [`SessionManager`](super::manager::SessionManager) (#2076) to
//! keep the manager focused on session lifecycle. Every method here is a pure
//! pass-through: resolve the session's [`FileBrowser`], forward the call, and
//! map errors to [`TerminalError`]. The behavior, error messages, and lock
//! discipline are exactly what lived inline on the manager — the `sessions`
//! lock is held across the browser `await`, as before.

use std::collections::HashMap;

use tokio::sync::Mutex;

use termihub_core::files::{FileBrowser, FileEntry};

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
}
