use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh_sftp::client::SftpSession as RusshSftp;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{debug, info};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::errors::FileError;
use termihub_core::files::utils::{chrono_from_epoch, format_permissions};
use termihub_core::files::{FileBackend, FileEntry};

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

/// SFTP session backed by a dedicated SSH connection.
///
/// The canonical implementation is now
/// [`termihub_core::backends::ssh::SftpFileBrowser`](termihub_core::backends::ssh).
/// This struct is kept for the legacy SFTP command API used by the desktop file browser.
pub struct SftpSession {
    _session: SshSession,
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

        Ok(Self {
            _session: session,
            sftp,
        })
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
pub struct SftpManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Open a new SFTP session. Returns the session UUID.
    pub fn open_session(&self, config: &SshConfig) -> Result<String, TerminalError> {
        let session = SftpSession::new(config)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(id.clone(), Arc::new(Mutex::new(session)));
        Ok(id)
    }

    /// Close and drop an SFTP session.
    pub fn close_session(&self, id: &str) {
        info!(session_id = id, "Closing SFTP session");
        let mut sessions = self.sessions.lock().unwrap();
        sessions.remove(id);
    }

    /// Get a session Arc for use outside the manager lock.
    pub fn get_session(&self, id: &str) -> Result<Arc<Mutex<SftpSession>>, TerminalError> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::SftpSessionNotFound(id.to_string()))
    }
}
