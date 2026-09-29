//! Session re-attachment for relaunched SFTP, FTP and remote-to-remote
//! transfers (#3199, #3206).
//!
//! A rehydrated session transfer persists only a session **reference**, paths
//! and progress — never credentials (PROD-0011). Relaunching one re-attaches the
//! live session behind that reference through the normal session path:
//!
//! - an **SFTP** session yields its SFTP browser, which carries the connection
//!   the session machinery authenticated;
//! - an **FTP** session yields the [`FtpConfig`] its file browser was connected
//!   with — including the password the session machinery sourced from the
//!   credential store when the session connected. It is read from the live
//!   session at resume time, server-side, and is never written to (or read
//!   from) `transfers.json`;
//! - a **remote-to-remote** copy (PROD-0013) re-attaches both its source and its
//!   destination SFTP sessions.
//!
//! A session that is not connected fails the row with a message; the persisted
//! record is kept, so a **Retry** after reconnecting re-runs this resolution.
//! The executor then starts from the persisted offset: it keeps the checkpoint
//! only while the source still matches the persisted size and mtime (#3572) and,
//! for FTP, the server supports `REST STREAM`.

use std::sync::Arc;

use termihub_core::backends::ssh::SftpFileBrowser;
#[cfg(feature = "ftp")]
use termihub_core::config::FtpConfig;

use super::registry::{TransferHandle, TransferRegistry};
use super::{ProgressSink, TransferDirection};
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
pub(crate) async fn resolve_session_target(
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

/// Re-attach both SFTP sessions of a remote-to-remote copy (#3206): the source
/// first, then the destination. The error names which end is unavailable.
pub(crate) async fn resolve_remote_copy(
    manager: &SessionManager,
    src_session_id: &str,
    dst_session_id: &str,
) -> Result<(Arc<SftpFileBrowser>, Arc<SftpFileBrowser>), String> {
    let src = manager
        .sftp_transfer_browser(src_session_id)
        .await
        .map_err(|e| format!("Cannot resume: source session unavailable ({e})"))?;
    let dst = manager
        .sftp_transfer_browser(dst_session_id)
        .await
        .map_err(|e| format!("Cannot resume: destination session unavailable ({e})"))?;
    Ok((src, dst))
}
