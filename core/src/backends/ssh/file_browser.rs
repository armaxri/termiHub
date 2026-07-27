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
use crate::files::{FileBrowser, FileEntry};

use super::handler::SshSession;
use super::jump_host::{connect_target, GatewayHold};
use super::sftp;

/// State of a connected SFTP session.
struct SftpState {
    _session: SshSession,
    /// Pooled gateway hold for a jump-host connection (`None` when direct); kept
    /// alive so the bastion session carrying this SFTP session stays open (#939).
    _gateway: Option<GatewayHold>,
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

        // Reach the target directly, or through its pooled jump-host gateway when
        // a ProxyJump chain is configured (#939).
        let (session, _registry, gateway) = connect_target(config, None)
            .await
            .map_err(|e| FileError::OperationFailed(format!("SFTP connection failed: {e}")))?;

        let sftp = sftp::open_sftp_subsystem(&session)
            .await
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;

        *guard = Some(SftpState {
            _session: session,
            _gateway: gateway,
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

        sftp::list_dir(&state.sftp, path)
            .await
            .map_err(|e| FileError::OperationFailed(format!("readdir failed: {e}")))
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

        sftp::stat(&state.sftp, path)
            .await
            .map_err(|e| FileError::OperationFailed(format!("stat failed: {e}")))
    }
}
