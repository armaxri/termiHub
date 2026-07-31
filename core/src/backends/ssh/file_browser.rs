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
use super::sftp_ops::{self, ElevatedWriteResult, Writability};

/// State of a connected SFTP session.
struct SftpState {
    /// The SSH session carrying this SFTP channel. Kept alive for the session
    /// lifetime, and used as the exec channel for the privilege-elevated write
    /// path exposed via [`SftpAdvancedOps`].
    session: SshSession,
    /// Pooled gateway hold for a jump-host connection (`None` when direct); kept
    /// alive so the bastion session carrying this SFTP session stays open (#939).
    _gateway: Option<GatewayHold>,
    sftp: SftpSession,
}

/// SFTP-backed file browser for SSH connections.
///
/// The SFTP session is opened lazily on first use and reused for
/// subsequent operations. The session is dropped on disconnect.
///
/// This is the single SFTP implementation shared by the core
/// [`ConnectionType::file_browser()`](crate::connection::ConnectionType::file_browser)
/// path and the desktop file-browser/transfer command layer, whose `SftpSession`
/// wraps one of these (#2104). It reaches jump-host targets through their pooled
/// gateway via [`connect_target`] (#939).
pub struct SftpFileBrowser {
    config: SshConfig,
    state: Arc<Mutex<Option<SftpState>>>,
}

impl SftpFileBrowser {
    pub fn new(config: SshConfig) -> Self {
        Self {
            config,
            state: Arc::new(Mutex::new(None)),
        }
    }

    /// Eagerly open the SFTP session, surfacing any connection/auth failure now
    /// rather than on the first operation.
    ///
    /// The browser otherwise connects lazily; callers that need an "open fails
    /// loudly" contract (e.g. the desktop `sftp_open` command, which returns a
    /// session id only once the connection succeeds) call this right after
    /// [`new`](Self::new).
    pub async fn connect(&self) -> Result<(), FileError> {
        Self::ensure_connected(&self.state, &self.config).await
    }

    /// Report whether an exec (command) channel can be opened and used on the
    /// SSH connection backing this SFTP session.
    ///
    /// Runs the shared [`probe_exec_capability`](super::exec::probe_exec_capability)
    /// marker probe over an exec channel: a normal SSH+shell connection echoes it
    /// (`true`); an SFTP-only / relayed connection (e.g. `ForceCommand
    /// internal-sftp`) cannot run the command (`false`). Lets the file editor know
    /// whether privilege-elevated writes — which need a shell to run `sudo` — are
    /// possible. Pushed into core so the desktop `SftpSession` no longer forks it
    /// (#2104, issue-body item 1).
    pub async fn has_exec_capability(&self) -> Result<bool, FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;
        Ok(super::exec::probe_exec_capability(&state.session).await)
    }

    /// Open a **dedicated** SFTP channel on a fresh channel off the same
    /// authenticated SSH connection.
    ///
    /// Used by the cancellable transfer subsystem (#1245): the returned session
    /// owns its own channel, so a chunked copy can run on it without holding this
    /// browser's lock — keeping directory listing / navigation live on the
    /// browsing channel during a transfer. Pushed into core so the desktop
    /// `SftpSession` no longer forks it (#2104, issue-body item 1).
    pub async fn open_dedicated_channel(&self) -> Result<SftpSession, FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;
        sftp::open_sftp_subsystem(&state.session)
            .await
            .map_err(|e| FileError::OperationFailed(e.to_string()))
    }

    /// Best-effort size (in bytes) of a remote file via SFTP `stat`.
    ///
    /// Returns `0` when the size is unavailable — the transfer UI treats
    /// `total == 0` as indeterminate and shows a spinner rather than a
    /// percentage. Never errors, mirroring the previous desktop behavior.
    pub async fn remote_size(&self, path: &str) -> u64 {
        if Self::ensure_connected(&self.state, &self.config).await.is_err() {
            return 0;
        }
        let guard = self.state.lock().await;
        let Some(state) = guard.as_ref() else {
            return 0;
        };
        match state.sftp.metadata(path).await {
            Ok(meta) => meta.size.unwrap_or(0),
            Err(_) => 0,
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
            session,
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

/// Advanced SFTP capabilities that complement [`FileBrowser`].
///
/// [`FileBrowser`] covers the portable file operations every backend shares
/// (list/read/write/delete/rename/stat/mkdir). This companion trait exposes the
/// three SSH-specific SFTP capabilities that historically lived only on the
/// desktop `SftpSession` (#2075/#2104): the authoritative writability probe, the
/// privilege-elevated (`sudo`) write, and `realpath`/canonicalize. Both the core
/// [`SftpFileBrowser`] and the desktop `SftpSession` delegate to the single
/// implementation in [`sftp_ops`], so the security-sensitive logic can never
/// drift between them.
///
/// It is deliberately a *separate* trait rather than methods on [`FileBrowser`]:
/// backends without an SSH exec channel (local, docker, FTP) cannot offer these,
/// and folding them into the shared trait is part of the wider
/// `FileBrowser`/`FileBackend` reconciliation tracked on #2104.
#[async_trait::async_trait]
pub trait SftpAdvancedOps: Send {
    /// Authoritatively probe whether the connecting user can write `remote_path`.
    ///
    /// Opens the **existing** file for writing (`OpenFlags::WRITE` only — no
    /// `CREATE`/`TRUNCATE`/`APPEND`) so its contents are never modified. This
    /// catches the owner-mismatch case the cheap permission hint cannot. The
    /// probe itself never hard-errors (a `PERMISSION_DENIED` maps to
    /// [`Writability::ReadOnly`], any other error to [`Writability::Unknown`]);
    /// the [`Result`] only surfaces a failure to open the SFTP session.
    async fn check_writable(&self, remote_path: &str) -> Result<Writability, FileError>;

    /// Resolve a remote path to its canonical absolute form via SFTP realpath.
    ///
    /// Passing `"."` yields the session's home directory, avoiding the fragile
    /// `/home/<user>` guess that breaks on non-Linux layouts (audit GAP C2,
    /// #1143).
    async fn realpath(&self, path: &str) -> Result<String, FileError>;

    /// Write `content` to `remote_path` with `sudo`-elevated privileges (#1328).
    ///
    /// SFTP-uploads the buffer to a termiHub-generated `/tmp/termihub-<uuid>`,
    /// then `sudo -S -p ''` runs a fixed `/bin/sh` script that rewrites the
    /// destination in place (preserving owner/mode/ACLs), classified into an
    /// [`ElevatedWriteResult`]. The destination path is POSIX-quoted and passed
    /// as a positional argument, so a hostile remote path cannot inject shell
    /// commands; the password is only ever sent on stdin and is **never** logged.
    async fn write_file_content_elevated(
        &self,
        remote_path: &str,
        content: &str,
        sudo_password: &str,
    ) -> Result<ElevatedWriteResult, FileError>;
}

#[async_trait::async_trait]
impl SftpAdvancedOps for SftpFileBrowser {
    async fn check_writable(&self, remote_path: &str) -> Result<Writability, FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        Ok(sftp_ops::check_writable(&state.sftp, remote_path).await)
    }

    async fn realpath(&self, path: &str) -> Result<String, FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        sftp_ops::realpath(&state.sftp, path).await
    }

    async fn write_file_content_elevated(
        &self,
        remote_path: &str,
        content: &str,
        sudo_password: &str,
    ) -> Result<ElevatedWriteResult, FileError> {
        Self::ensure_connected(&self.state, &self.config).await?;
        let guard = self.state.lock().await;
        let state = guard
            .as_ref()
            .ok_or_else(|| FileError::OperationFailed("SFTP not connected".to_string()))?;

        sftp_ops::write_file_content_elevated(
            &state.session,
            &state.sftp,
            remote_path,
            content,
            sudo_password,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The companion trait must stay object-safe and `Send` so it can be held
    // behind a `Box<dyn SftpAdvancedOps>` and driven across `.await` points,
    // mirroring `FileBrowser`.
    fn _assert_object_safe(_: &dyn SftpAdvancedOps) {}
    fn _assert_send<T: Send>() {}

    /// `SftpAdvancedOps` is object-safe and `Send`.
    #[test]
    fn sftp_advanced_ops_is_send() {
        _assert_send::<Box<dyn SftpAdvancedOps>>();
    }

    /// The core `SftpFileBrowser` implements the companion trait, so the elevated
    /// write / writability / realpath capabilities are reachable through the core
    /// path — not only the desktop `SftpSession` (#2104). This is a compile-time
    /// assertion; the delegated logic itself is unit-tested in
    /// [`super::sftp_ops`] and exercised end-to-end by the SFTP integration
    /// suite (`core/tests/sftp_stress.rs`).
    #[test]
    fn sftp_file_browser_implements_advanced_ops() {
        fn _assert_impl<T: SftpAdvancedOps>() {}
        _assert_impl::<SftpFileBrowser>();
    }
}
