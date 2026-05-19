//! SFTP-based file browser implementing [`FileBrowser`].
//!
//! Opens a dedicated SSH session for SFTP operations using russh-sftp.
//! All operations are fully async — no `spawn_blocking` needed.

use std::sync::Arc;

use russh_sftp::client::SftpSession;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

use crate::config::SshConfig;
use crate::errors::FileError;
use crate::files::utils::{chrono_from_epoch, format_permissions};
use crate::files::{FileBrowser, FileEntry};

use super::auth::connect_and_authenticate;
use super::handler::SshSession;

/// State of a connected SFTP session.
struct SftpState {
    _session: SshSession,
    sftp: SftpSession,
}

/// SFTP-backed file browser for SSH connections.
///
/// The SFTP session is opened lazily on first use and reused for
/// subsequent operations. The session is dropped on disconnect.
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
    async fn ensure_connected(
        state: &Mutex<Option<SftpState>>,
        config: &SshConfig,
    ) -> Result<(), FileError> {
        let mut guard = state.lock().await;
        if guard.is_some() {
            return Ok(());
        }

        let (session, _registry) = connect_and_authenticate(config)
            .await
            .map_err(|e| FileError::OperationFailed(format!("SFTP connection failed: {e}")))?;

        let channel = session
            .channel_open_session()
            .await
            .map_err(|e| FileError::OperationFailed(format!("Channel open failed: {e}")))?;

        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            FileError::OperationFailed(format!("SFTP subsystem request failed: {e}"))
        })?;

        let sftp = SftpSession::new(channel.into_stream())
            .await
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
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        let entries = state
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| FileError::OperationFailed(format!("readdir failed: {e}")))?;

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
        Ok(result)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        let mut file = state
            .sftp
            .open(path)
            .await
            .map_err(|e| FileError::OperationFailed(format!("open failed: {e}")))?;

        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .await
            .map_err(|e| FileError::OperationFailed(format!("read failed: {e}")))?;

        Ok(data)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        let mut file = state
            .sftp
            .create(path)
            .await
            .map_err(|e| FileError::OperationFailed(format!("create failed: {e}")))?;

        use tokio::io::AsyncWriteExt;
        file.write_all(data)
            .await
            .map_err(|e| FileError::OperationFailed(format!("write failed: {e}")))?;

        Ok(())
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        let meta = state
            .sftp
            .metadata(path)
            .await
            .map_err(|e| FileError::OperationFailed(format!("stat failed: {e}")))?;

        if meta.is_dir() {
            state
                .sftp
                .remove_dir(path)
                .await
                .map_err(|e| FileError::OperationFailed(format!("rmdir failed: {e}")))?;
        } else {
            state
                .sftp
                .remove_file(path)
                .await
                .map_err(|e| FileError::OperationFailed(format!("unlink failed: {e}")))?;
        }

        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        state
            .sftp
            .rename(from, to)
            .await
            .map_err(|e| FileError::OperationFailed(format!("rename failed: {e}")))?;

        Ok(())
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        state
            .sftp
            .create_dir(path)
            .await
            .map_err(|e| FileError::OperationFailed(format!("mkdir failed: {e}")))?;

        Ok(())
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        let meta = state
            .sftp
            .metadata(path)
            .await
            .map_err(|e| FileError::OperationFailed(format!("stat failed: {e}")))?;

        let name = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        Ok(FileEntry {
            name,
            path: path.to_string(),
            is_directory: meta.is_dir(),
            size: meta.size.unwrap_or(0),
            modified: meta
                .mtime
                .map(|t| chrono_from_epoch(t as u64))
                .unwrap_or_default(),
            permissions: meta.permissions.map(format_permissions),
        })
    }
}
