//! Session re-attachment for relaunched SFTP, FTP and remote-to-remote
//! transfers (#3199, #3206, #3876).
//!
//! A rehydrated session transfer persists only a session **reference** (plus
//! the id of the saved connection that session was opened for), paths and
//! progress — never credentials (PROD-0011). Relaunching one gets a connection
//! through the normal session path when it can:
//!
//! - an **SFTP** session yields its SFTP browser, which carries the connection
//!   the session machinery authenticated;
//! - an **FTP** session yields the [`FtpConfig`] its file browser was connected
//!   with — including the password the session machinery sourced from the
//!   credential store when the session connected. It is read from the live
//!   session at resume time, server-side, and is never written to (or read
//!   from) `transfers.json`;
//! - a **remote-to-remote** copy (PROD-0013) re-attaches both its source and its
//!   destination: an SFTP session through the path above, a Docker session by
//!   its persisted container id (#3586).
//!
//! When the session is gone — typically after a restart — the saved connection
//! is used instead: a session the user reopened for it, or the connection
//! itself with its secret re-sourced from the unlocked credential store. The
//! resolution order and the never-prompt rules live in
//! [`super::relaunch_credentials`]; this module supplies the app's side of it
//! ([`AppSources`]). A secret that cannot be resolved unattended keeps the row
//! paused with a reason; any other failure fails the row with a message. The
//! persisted record is kept either way, so **Resume** / **Retry** re-runs this
//! resolution.
//!
//! The executor then starts from the persisted offset: it keeps the checkpoint
//! only while the source still matches the persisted size and mtime (#3572) and,
//! for FTP, the server supports `REST STREAM`.

use std::sync::Arc;

use termihub_core::backends::ssh::unattended::run_unattended;
use termihub_core::backends::ssh::SftpFileBrowser;
#[cfg(feature = "ftp")]
use termihub_core::config::FtpConfig;
use termihub_core::config::SshConfig;

use super::persist::PersistedAgentTarget;
use super::persist_manager::TransferPersistenceManager;
use super::registry::{TransferHandle, TransferRegistry};
use super::relaunch_credentials::{
    resolve_sftp_endpoint, RelaunchBlocked, RelaunchSources, SavedSource,
};
use super::remote_copy::RemoteCopyEndpoint;
use super::{ProgressSink, TransferDirection};
use crate::connection::manager::ConnectionManager;
use crate::credential::{CredentialStore, NullStore};
use crate::session::manager::SessionManager;
use crate::utils::errors::TerminalError;

/// The executor a rehydrated session download/upload relaunches on, resolved
/// from the live session behind its persisted reference.
pub(crate) enum SessionTarget {
    /// An SFTP-backed session (SSH).
    Sftp(Arc<SftpFileBrowser>),
    /// An FTP-backed session: its live connection settings (#3206).
    #[cfg(feature = "ftp")]
    Ftp(FtpConfig),
}

/// Resolve the live session `session_id` to the executor its transfer runs on:
/// SFTP first, then FTP. A session that is neither (or not connected) surfaces
/// the SFTP resolution error.
async fn live_session_target(
    manager: &SessionManager,
    session_id: &str,
) -> Result<SessionTarget, TerminalError> {
    let sftp_err = match manager.sftp_transfer_browser(session_id).await {
        Ok(browser) => return Ok(SessionTarget::Sftp(browser)),
        Err(e) => e,
    };
    #[cfg(feature = "ftp")]
    if let Ok(config) = manager.ftp_transfer_config(session_id).await {
        return Ok(SessionTarget::Ftp(config));
    }
    Err(sftp_err)
}

/// The running app as a [`RelaunchSources`]: live sessions from the
/// [`SessionManager`], saved connections and the credential store from the
/// [`ConnectionManager`] (absent in a run without one — then only live
/// sessions can be used).
pub(crate) struct AppSources<'a> {
    pub manager: &'a SessionManager,
    pub connections: Option<&'a ConnectionManager>,
}

impl RelaunchSources for AppSources<'_> {
    async fn live_target(&self, session_id: &str) -> Result<SessionTarget, TerminalError> {
        live_session_target(self.manager, session_id).await
    }

    async fn sessions_for_saved_connection(&self, connection_id: &str) -> Vec<String> {
        self.manager
            .sessions_for_saved_connection(connection_id)
            .await
    }

    fn saved_connection(&self, connection_id: &str) -> Result<SavedSource, String> {
        let connections = self
            .connections
            .ok_or_else(|| "saved connections are unavailable".to_string())?;
        let (connection, owner) = connections
            .transfer_connection(connection_id)
            .map_err(|e| e.to_string())?;
        Ok(SavedSource {
            connection,
            owner: Some(owner),
        })
    }

    fn credential_store(&self) -> &dyn CredentialStore {
        match self.connections {
            Some(connections) => connections.credential_store(),
            None => &NO_STORE,
        }
    }

    fn key_is_encrypted(&self, key_path: &str) -> bool {
        crate::utils::ssh_key_validate::is_ssh_key_encrypted(key_path).unwrap_or(true)
    }

    fn resolve_jump_hosts(
        &self,
        settings: &mut serde_json::Value,
        connection_id: &str,
    ) -> Result<(), String> {
        match self.connections {
            Some(connections) => connections
                .resolve_jump_host_refs(settings, Some(connection_id))
                .map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    async fn connect_sftp(&self, config: SshConfig) -> Result<Arc<SftpFileBrowser>, String> {
        let browser = SftpFileBrowser::new(config);
        // Connect eagerly inside the never-prompt scope: the browser keeps this
        // connection, so the executor's later operations never connect again
        // (outside the scope) and never prompt.
        run_unattended(browser.connect())
            .await
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(browser))
    }
}

/// Record on a registered transfer the saved connection its session
/// `session_id` was opened for (#3876), so a relaunch after the session is
/// gone can re-source its secret. The id only; a no-op for an ad-hoc session.
pub(crate) fn record_saved_connection(
    persist: &TransferPersistenceManager,
    manager: &SessionManager,
    transfer_id: &str,
    session_id: &str,
) {
    if let Some(connection_id) = manager.saved_connection_of(session_id) {
        persist.record_saved_connection(transfer_id, &connection_id);
    }
}

/// The store a run without a connection manager reads: it holds nothing.
static NO_STORE: NullStore = NullStore;

/// Resolve the executor a relaunched session download/upload runs on (see the
/// module docs and [`super::relaunch_credentials`]).
pub(crate) async fn resolve_session_target(
    sources: &AppSources<'_>,
    session_id: &str,
    saved_connection_id: Option<&str>,
) -> Result<SessionTarget, RelaunchBlocked> {
    super::relaunch_credentials::resolve_session_target(sources, session_id, saved_connection_id)
        .await
}

/// Run a relaunched session download/upload on `target` from `offset`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_session_target(
    target: SessionTarget,
    direction: TransferDirection,
    remote_path: String,
    local_path: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    offset: u64,
) {
    match target {
        SessionTarget::Sftp(browser) => {
            super::sftp::run_sftp_transfer(
                browser,
                direction,
                remote_path,
                local_path,
                handle,
                registry,
                sink,
                super::sftp::DEFAULT_RESUME_MODE,
                offset,
            )
            .await;
        }
        #[cfg(feature = "ftp")]
        SessionTarget::Ftp(config) => {
            use termihub_core::backends::ftp::FtpDirection;
            let direction = match direction {
                TransferDirection::Download => FtpDirection::Download,
                TransferDirection::Upload => FtpDirection::Upload,
            };
            super::ftp::run_ftp_transfer(
                config,
                direction,
                remote_path,
                local_path,
                handle,
                registry,
                sink,
                offset,
            )
            .await;
        }
    }
}

/// One end of a relaunched remote-to-remote copy: its session, the saved
/// connection that session was opened for, and — for a Docker end (#3586) —
/// the container it streamed through, or — for an agent-hosted end (#4115) —
/// the identity of its agent session.
pub(crate) struct CopyEnd<'a> {
    pub session_id: &'a str,
    pub saved_connection_id: Option<&'a str>,
    pub container_id: Option<&'a str>,
    pub agent: Option<&'a PersistedAgentTarget>,
}

/// Resolve one end of a remote-to-remote copy: a Docker end by its persisted
/// container id (see [`super::relaunch_docker`]), an agent-hosted end by its
/// persisted session identity (see [`super::relaunch_agent`]; none live yet
/// keeps the row paused), any other end as an SFTP session (#3206, #3876).
async fn resolve_copy_end(
    sources: &AppSources<'_>,
    end: CopyEnd<'_>,
) -> Result<RemoteCopyEndpoint, RelaunchBlocked> {
    if let Some(container_id) = end.container_id {
        return super::relaunch_docker::resolve_docker_target(
            sources.manager,
            end.session_id,
            container_id,
        )
        .await
        .map(RemoteCopyEndpoint::Docker)
        .map_err(RelaunchBlocked::Failed);
    }
    if let Some(agent) = end.agent {
        return super::relaunch_agent::resolve_live_agent_target(sources.manager, agent)
            .await
            .map(|proxy| RemoteCopyEndpoint::Ranged(proxy));
    }
    resolve_sftp_endpoint(sources, end.session_id, end.saved_connection_id)
        .await
        .map(RemoteCopyEndpoint::Sftp)
}

/// Resolve both ends of a remote-to-remote copy (#3206, #3876, #3586): the
/// source first, then the destination. A failure names which end is
/// unavailable; a missing secret on either end keeps the row paused.
pub(crate) async fn resolve_remote_copy(
    sources: &AppSources<'_>,
    src: CopyEnd<'_>,
    dst: CopyEnd<'_>,
) -> Result<(RemoteCopyEndpoint, RemoteCopyEndpoint), RelaunchBlocked> {
    let end = |which: &str, blocked: RelaunchBlocked| match blocked {
        RelaunchBlocked::Failed(message) => {
            RelaunchBlocked::Failed(format!("{message} (the {which} of the copy)"))
        }
        needs => needs,
    };
    let src = resolve_copy_end(sources, src)
        .await
        .map_err(|e| end("source", e))?;
    let dst = resolve_copy_end(sources, dst)
        .await
        .map_err(|e| end("destination", e))?;
    Ok((src, dst))
}
