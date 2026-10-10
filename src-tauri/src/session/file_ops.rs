//! Thin file-operations facade over a session's file-browser capability.
//!
//! Extracted from [`SessionManager`](super::manager::SessionManager) (#2076) to
//! keep the manager focused on session lifecycle. Every method here is a pure
//! pass-through: resolve the session's [`FileBrowser`], forward the call, and
//! map errors to [`TerminalError`]. The behavior and error messages are
//! exactly what lived inline on the manager.
//!
//! **Lock discipline (#4393).** The `sessions` lock is held only to *look the
//! session up*: [`FileOps::resolve`] takes an owned [`BrowserHandle`] — the
//! session's [`IoHandle`] (a shared connection plus a read guard on its I/O
//! gate), or a graphical session's side channel — and releases the lock before
//! the browser call is awaited. One slow or hung SFTP / FTP / `docker exec` /
//! agent round-trip therefore no longer freezes input, resize, create, list or
//! close in every other tab.
//!
//! Closing a session while one of its file operations is in flight is safe:
//! close removes the entry under the map lock (so no new handle can be taken)
//! and its disconnect waits behind the in-flight handle's gate guard, so the
//! connection is never torn down under the call — the operation finishes (or
//! fails, once close has interrupted the backend's I/O) and the deferred
//! disconnect then runs.

use std::sync::Arc;

use tokio::sync::Mutex;

use termihub_core::backends::ssh::{SftpAdvancedOps, SftpFileBrowser};
use termihub_core::files::{FileAttributeOps, FileBrowser, FileEntry};

use crate::files::sftp::{sftp_op_error, ElevatedWriteResult, Writability};
use crate::utils::errors::TerminalError;

use termihub_core::session::registry::Sessions;

use super::graphical_browse::{SharedFileBrowser, SideChannelBrowsers};
use super::manager::session_io::IoHandle;
use super::manager::{SessionEntry, SessionMap};

/// Borrowing facade exposing a session's file-browser operations.
///
/// Holds only a borrow of the manager's `sessions` map, so it carries no state
/// of its own; the manager constructs one on demand via
/// [`SessionManager::file_ops`](super::manager::SessionManager). Each method
/// mirrors the corresponding [`FileBrowser`] operation.
pub(super) struct FileOps<'a, M: SessionMap = Sessions<SessionEntry>> {
    sessions: &'a Mutex<M>,
    /// Graphical sessions' side channels open for browsing (#4193), consulted
    /// for an id that is not a session.
    side_channels: Option<&'a SideChannelBrowsers>,
}

impl<'a, M: SessionMap> FileOps<'a, M> {
    /// Wrap the manager's `sessions` map.
    pub(super) fn new(sessions: &'a Mutex<M>) -> Self {
        Self {
            sessions,
            side_channels: None,
        }
    }

    /// Also resolve graphical session ids through their open side channels.
    pub(super) fn with_side_channels(mut self, side_channels: &'a SideChannelBrowsers) -> Self {
        self.side_channels = Some(side_channels);
        self
    }

    /// Resolve a session's file browser into an owned [`BrowserHandle`],
    /// holding the `sessions` lock only for the lookup (#4393).
    ///
    /// Preserves the manager's exact errors: [`TerminalError::SessionNotFound`]
    /// when the id is neither a session nor a graphical session with an open
    /// side channel (or the session is being closed), and
    /// [`TerminalError::RemoteError`] when the session exposes no file-browser
    /// capability.
    async fn resolve(&self, session_id: &str) -> Result<BrowserHandle, TerminalError> {
        let sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get(session_id) {
            if entry.connection.file_browser().is_none() {
                return Err(no_file_browser());
            }
            // `None` once close holds the session's I/O gate.
            return entry
                .io
                .handle(&entry.connection)
                .map(BrowserHandle::Session)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()));
        }
        let carrier = self
            .side_channels
            .and_then(|side| side.get(session_id))
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        Ok(BrowserHandle::SideChannel(carrier.file_browser()))
    }

    /// List directory contents via the session's file browser.
    pub(super) async fn list_dir(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<FileEntry>, TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
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
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
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
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
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
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        browser
            .write_file(path, data)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Delete a file via the session's file browser.
    pub(super) async fn delete(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
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
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        browser
            .rename(from, to)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Create a directory via the session's file browser.
    pub(super) async fn mkdir(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        browser
            .mkdir(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Change the permission bits (chmod) of a file via the session's file
    /// browser. `mode` is the low 12 bits of a Unix mode (e.g. `0o755`).
    pub(super) async fn set_permissions(
        &self,
        session_id: &str,
        path: &str,
        mode: u32,
    ) -> Result<(), TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        browser
            .set_permissions(path, mode)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Change the owner/group (chown) of a file via the session's file browser.
    /// A `None` id leaves that side unchanged.
    pub(super) async fn set_owner(
        &self,
        session_id: &str,
        path: &str,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> Result<(), TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        browser
            .set_owner(path, uid, gid)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Create a symlink at `link_path` pointing at `target` via the session's file
    /// browser.
    pub(super) async fn create_symlink(
        &self,
        session_id: &str,
        target: &str,
        link_path: &str,
    ) -> Result<(), TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        browser
            .create_symlink(target, link_path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Which attribute operations (chmod / chown / symlink) the session's file
    /// browser performs (#4353) — the capability the file-browser UI gates its
    /// permission, owner and symlink actions on.
    pub(super) async fn attribute_ops(
        &self,
        session_id: &str,
    ) -> Result<FileAttributeOps, TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        Ok(browser.attribute_ops())
    }

    /// Copy `src` → `dest` within the session's backend (same-backend copy).
    pub(super) async fn copy(
        &self,
        session_id: &str,
        src: &str,
        dest: &str,
    ) -> Result<(), TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        browser
            .copy(src, dest)
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
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
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

    /// Resolve the [`FtpConfig`](termihub_core::config::FtpConfig) backing an FTP
    /// session's file browser, cloned so a background transfer can run on its own
    /// connection without holding the sessions lock — the FTP analogue of
    /// [`sftp_browser`](Self::sftp_browser) (PROD-010).
    ///
    /// The settings are read from the live session server-side (never persisted,
    /// never sent to the frontend), so launching a queued FTP transfer reuses the
    /// same credentials the session already holds. Fails with
    /// [`TerminalError::RemoteError`] when the session has no file browser or its
    /// browser is not FTP-backed, matching the "not supported" shape of
    /// [`sftp_browser`](Self::sftp_browser).
    #[cfg(feature = "ftp")]
    pub(super) async fn ftp_transfer_config(
        &self,
        session_id: &str,
    ) -> Result<termihub_core::config::FtpConfig, TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        termihub_core::backends::ftp::ftp_config_of(browser).ok_or_else(|| {
            TerminalError::RemoteError(
                "Session file browser is not FTP-backed; queued transfer unavailable".to_string(),
            )
        })
    }

    /// Resolve the streaming [`DockerTransferTarget`] behind a Docker session's
    /// file browser, cloned so a background transfer runs its own `docker exec`
    /// without holding the sessions lock — the Docker analogue of
    /// [`sftp_browser`](Self::sftp_browser) (PARITY-004, #3567).
    ///
    /// Fails with [`TerminalError::RemoteError`] when the session has no file
    /// browser or its browser is not Docker-backed.
    ///
    /// [`DockerTransferTarget`]: termihub_core::backends::docker::DockerTransferTarget
    pub(super) async fn docker_transfer_target(
        &self,
        session_id: &str,
    ) -> Result<termihub_core::backends::docker::DockerTransferTarget, TerminalError> {
        let handle = self.resolve(session_id).await?;
        let browser = handle.browser()?;
        termihub_core::backends::docker::docker_transfer_target_of(browser).ok_or_else(|| {
            TerminalError::RemoteError(
                "Session file browser is not Docker-backed; queued transfer unavailable"
                    .to_string(),
            )
        })
    }

    /// Resolve the agent proxy behind an agent-hosted session so a background
    /// transfer moves the file in offset-addressed slices over
    /// `connection.files.read_range` / `write_range` (#3587) — the agent
    /// analogue of [`docker_transfer_target`](Self::docker_transfer_target).
    ///
    /// The proxy is cloned out of the sessions lock, then the agent is asked
    /// (a zero-length read, no I/O) whether this session's backend serves
    /// slices: a backend without ranged access, or a session started by an
    /// older session daemon, refuses it here, so such a session stays on the
    /// byte-based path instead of failing on the queue.
    pub(super) async fn ranged_transfer_target(
        &self,
        session_id: &str,
    ) -> Result<std::sync::Arc<crate::session::remote_proxy::RemoteFileBrowserProxy>, TerminalError>
    {
        use crate::session::remote_proxy::RemoteFileBrowserProxy;
        let proxy = {
            let handle = self.resolve(session_id).await?;
            let browser = handle.browser()?;
            browser
                .as_any()
                .and_then(|any| any.downcast_ref::<RemoteFileBrowserProxy>())
                .filter(|proxy| proxy.ranged().is_some())
                .cloned()
                .ok_or_else(|| {
                    TerminalError::RemoteError(
                        "Session does not serve ranged file slices; queued transfer unavailable"
                            .to_string(),
                    )
                })?
        };
        proxy
            .probe_ranges()
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))?;
        Ok(std::sync::Arc::new(proxy))
    }

    /// Every live agent-hosted session whose file browser serves ranged
    /// slices, with its identity (#4114) — the candidates a relaunched
    /// agent-hosted transfer picks its session from after a restart. The
    /// proxies are cloned out of the sessions lock and not probed here.
    pub(super) async fn agent_ranged_sessions(
        &self,
    ) -> Vec<(
        crate::files::transfer::relaunch_agent::AgentSessionIdentity,
        std::sync::Arc<crate::session::remote_proxy::RemoteFileBrowserProxy>,
    )> {
        use crate::session::remote_proxy::RemoteFileBrowserProxy;
        let sessions = self.sessions.lock().await;
        sessions
            .values()
            .filter_map(|entry| entry.connection.file_browser())
            .filter_map(|browser| {
                browser
                    .as_any()
                    .and_then(|any| any.downcast_ref::<RemoteFileBrowserProxy>())
            })
            .filter(|proxy| proxy.ranged().is_some())
            .map(|proxy| {
                (
                    proxy.agent_session_identity(),
                    std::sync::Arc::new(proxy.clone()),
                )
            })
            .collect()
    }

    /// Find a live Docker session streaming into exactly `container_id` and
    /// return its transfer target (#3585).
    ///
    /// A relaunched transfer's original session id does not survive an app
    /// restart; once the user reconnects the container's session (new id), this
    /// lets the relaunch reuse it. Matching is by the full container id, never
    /// by name, so a same-name recreated container is never picked up.
    pub(super) async fn docker_transfer_target_for_container(
        &self,
        container_id: &str,
    ) -> Option<termihub_core::backends::docker::DockerTransferTarget> {
        let sessions = self.sessions.lock().await;
        let target = sessions
            .values()
            .filter_map(|entry| entry.connection.file_browser())
            .filter_map(termihub_core::backends::docker::docker_transfer_target_of)
            .find(|target| !container_id.is_empty() && target.container_id() == container_id);
        target
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

/// The "no file browser" error, shared by every resolution path.
fn no_file_browser() -> TerminalError {
    TerminalError::RemoteError("No file browser capability".to_string())
}

/// An owned file-browser source, resolved under the `sessions` lock and used
/// after it is released (#4393).
///
/// A session's browser is borrowed from its connection, so the handle keeps
/// that connection alive — and close's disconnect waiting — for as long as the
/// call runs. A graphical session's side channel (#4193) is already an owned,
/// shared browser.
enum BrowserHandle {
    /// A session's I/O handle: a shared connection plus its I/O gate guard.
    Session(IoHandle),
    /// A graphical session's side channel opened for browsing.
    SideChannel(SharedFileBrowser),
}

impl BrowserHandle {
    /// The file browser this handle holds.
    fn browser(&self) -> Result<&dyn FileBrowser, TerminalError> {
        match self {
            Self::Session(handle) => handle.connection.file_browser().ok_or_else(no_file_browser),
            Self::SideChannel(browser) => Ok(browser.as_ref()),
        }
    }
}
