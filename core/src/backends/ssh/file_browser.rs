//! SFTP-based file browser implementing [`FileBrowser`].
//!
//! Opens a dedicated SSH session in blocking mode for SFTP operations.
//! Blocking calls are offloaded to `tokio::task::spawn_blocking` to
//! avoid blocking the async executor.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use crate::config::SshConfig;
use crate::errors::FileError;
use crate::files::utils::{chrono_from_epoch, format_permissions};
use crate::files::{FileBrowser, FileEntry};

use super::auth::connect_and_authenticate;

/// State of a connected SFTP session.
struct SftpState {
    _session: ssh2::Session,
    sftp: ssh2::Sftp,
}

/// SFTP-backed file browser for SSH connections.
///
/// The SFTP session is opened lazily on first use and reused for
/// subsequent operations. Uses a separate SSH session in blocking mode.
pub(crate) struct SftpFileBrowser {
    config: SshConfig,
    state: Arc<Mutex<Option<SftpState>>>,
}

impl SftpFileBrowser {
    pub(crate) fn new(config: SshConfig) -> Self {
        Self {
            config,
            state: Arc::new(Mutex::new(None)),
        }
    }

    /// Ensure the SFTP session is connected, opening it if needed.
    fn ensure_connected(
        state: &Mutex<Option<SftpState>>,
        config: &SshConfig,
    ) -> Result<(), FileError> {
        let mut guard = state
            .lock()
            .map_err(|e| FileError::OperationFailed(format!("Failed to lock SFTP state: {e}")))?;

        if guard.is_some() {
            return Ok(());
        }

        let session = connect_and_authenticate(config)
            .map_err(|e| FileError::OperationFailed(format!("SFTP connection failed: {e}")))?;
        session.set_blocking(true);

        let sftp = session
            .sftp()
            .map_err(|e| FileError::OperationFailed(format!("SFTP init failed: {e}")))?;

        *guard = Some(SftpState {
            _session: session,
            sftp,
        });

        Ok(())
    }
}

#[async_trait::async_trait]
impl FileBrowser for SftpFileBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let state = self.state.clone();
        let config = self.config.clone();
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            Self::ensure_connected(&state, &config)?;
            let guard = state
                .lock()
                .map_err(|e| FileError::OperationFailed(format!("Lock failed: {e}")))?;
            let sftp_state = guard
                .as_ref()
                .ok_or(FileError::OperationFailed("SFTP not connected".to_string()))?;

            let dir = std::path::Path::new(&path);
            let entries = sftp_state
                .sftp
                .readdir(dir)
                .map_err(|e| FileError::OperationFailed(format!("readdir failed: {e}")))?;

            let mut result = Vec::new();
            for (pathbuf, stat) in entries {
                let name = pathbuf
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                if name == "." || name == ".." {
                    continue;
                }

                result.push(FileEntry {
                    name,
                    path: pathbuf.to_string_lossy().to_string(),
                    is_directory: stat.is_dir(),
                    size: stat.size.unwrap_or(0),
                    modified: stat.mtime.map(chrono_from_epoch).unwrap_or_default(),
                    permissions: stat.perm.map(format_permissions),
                });
            }
            Ok(result)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let state = self.state.clone();
        let config = self.config.clone();
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            Self::ensure_connected(&state, &config)?;
            let guard = state
                .lock()
                .map_err(|e| FileError::OperationFailed(format!("Lock failed: {e}")))?;
            let sftp_state = guard
                .as_ref()
                .ok_or(FileError::OperationFailed("SFTP not connected".to_string()))?;

            let remote = std::path::Path::new(&path);
            let mut remote_file = sftp_state
                .sftp
                .open(remote)
                .map_err(|e| FileError::OperationFailed(format!("open failed: {e}")))?;

            let mut data = Vec::new();
            remote_file
                .read_to_end(&mut data)
                .map_err(|e| FileError::OperationFailed(format!("read failed: {e}")))?;

            Ok(data)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let state = self.state.clone();
        let config = self.config.clone();
        let path = path.to_string();
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || {
            Self::ensure_connected(&state, &config)?;
            let guard = state
                .lock()
                .map_err(|e| FileError::OperationFailed(format!("Lock failed: {e}")))?;
            let sftp_state = guard
                .as_ref()
                .ok_or(FileError::OperationFailed("SFTP not connected".to_string()))?;

            let remote = std::path::Path::new(&path);
            let mut remote_file = sftp_state
                .sftp
                .create(remote)
                .map_err(|e| FileError::OperationFailed(format!("create failed: {e}")))?;

            remote_file
                .write_all(&data)
                .map_err(|e| FileError::OperationFailed(format!("write failed: {e}")))?;

            Ok(())
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        let state = self.state.clone();
        let config = self.config.clone();
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            Self::ensure_connected(&state, &config)?;
            let guard = state
                .lock()
                .map_err(|e| FileError::OperationFailed(format!("Lock failed: {e}")))?;
            let sftp_state = guard
                .as_ref()
                .ok_or(FileError::OperationFailed("SFTP not connected".to_string()))?;

            let p = std::path::Path::new(&path);
            // Try stat to determine if it's a directory.
            let stat = sftp_state
                .sftp
                .stat(p)
                .map_err(|e| FileError::OperationFailed(format!("stat failed: {e}")))?;

            if stat.is_dir() {
                sftp_state
                    .sftp
                    .rmdir(p)
                    .map_err(|e| FileError::OperationFailed(format!("rmdir failed: {e}")))?;
            } else {
                sftp_state
                    .sftp
                    .unlink(p)
                    .map_err(|e| FileError::OperationFailed(format!("unlink failed: {e}")))?;
            }
            Ok(())
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        let state = self.state.clone();
        let config = self.config.clone();
        let from = from.to_string();
        let to = to.to_string();
        tokio::task::spawn_blocking(move || {
            Self::ensure_connected(&state, &config)?;
            let guard = state
                .lock()
                .map_err(|e| FileError::OperationFailed(format!("Lock failed: {e}")))?;
            let sftp_state = guard
                .as_ref()
                .ok_or(FileError::OperationFailed("SFTP not connected".to_string()))?;

            let old = std::path::Path::new(&from);
            let new = std::path::Path::new(&to);
            sftp_state
                .sftp
                .rename(old, new, None)
                .map_err(|e| FileError::OperationFailed(format!("rename failed: {e}")))?;
            Ok(())
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let state = self.state.clone();
        let config = self.config.clone();
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            Self::ensure_connected(&state, &config)?;
            let guard = state
                .lock()
                .map_err(|e| FileError::OperationFailed(format!("Lock failed: {e}")))?;
            let sftp_state = guard
                .as_ref()
                .ok_or(FileError::OperationFailed("SFTP not connected".to_string()))?;

            let p = std::path::Path::new(&path);
            let file_stat = sftp_state
                .sftp
                .stat(p)
                .map_err(|e| FileError::OperationFailed(format!("stat failed: {e}")))?;

            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            Ok(FileEntry {
                name,
                path,
                is_directory: file_stat.is_dir(),
                size: file_stat.size.unwrap_or(0),
                modified: file_stat.mtime.map(chrono_from_epoch).unwrap_or_default(),
                permissions: file_stat.perm.map(format_permissions),
            })
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }
}
