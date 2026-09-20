//! Generic transfer-queue commands (issue #1336).
//!
//! These control the shared [`TransferRegistry`] queue model and are named
//! generically (`transfer_*`) so SFTP can migrate onto the same queue later.
//! `ftp_download` / `ftp_upload` register FTP transfers; the FTP data plane is
//! feature-gated behind `ftp` (the commands are always present so the IPC
//! surface is stable, but return an error when the feature is off).

use tauri::State;
use tracing::debug;

use crate::files::transfer::{TransferRegistry, TransferSnapshot};
use crate::session::manager::SessionManager;
use crate::utils::errors::TerminalError;
#[cfg(feature = "ftp")]
use crate::utils::fs::file_name_of;

/// Pause an in-flight transfer.
///
/// Returns `true` when the transfer accepted the pause (a live *rich* transfer —
/// FTP *and*, since PROD-0012, SFTP), and `false` when it was a no-op: an
/// unknown/finished id, or a transfer on a non-streaming path that cannot pause
/// (Docker/FTP-listing/agent byte-based copies). The frontend uses this to give
/// honest feedback instead of a blanket success toast (#1336; audit
/// FEC-004 / UX-016).
#[tauri::command]
pub fn transfer_pause(transfer_id: String, registry: State<'_, TransferRegistry>) -> bool {
    debug!(transfer_id, "transfer pause");
    registry.pause(&transfer_id)
}

/// Resume a paused transfer. Returns `true` when the transfer accepted the
/// resume, `false` on a no-op (see [`transfer_pause`]).
#[tauri::command]
pub fn transfer_resume(transfer_id: String, registry: State<'_, TransferRegistry>) -> bool {
    debug!(transfer_id, "transfer resume");
    registry.resume(&transfer_id)
}

/// Cancel an in-flight transfer (queued, active, or paused). Works for both
/// legacy SFTP and rich FTP transfers. Returns `true` when a live transfer was
/// cancelled, `false` for an unknown/already-finished id.
#[tauri::command]
pub fn transfer_cancel(transfer_id: String, registry: State<'_, TransferRegistry>) -> bool {
    debug!(transfer_id, "transfer cancel");
    registry.cancel(&transfer_id)
}

/// Manually retry a failed transfer (resets its attempt counter). Returns
/// `true` when the transfer accepted the retry, `false` on a no-op (see
/// [`transfer_pause`]).
#[tauri::command]
pub fn transfer_retry(transfer_id: String, registry: State<'_, TransferRegistry>) -> bool {
    debug!(transfer_id, "transfer retry");
    registry.retry(&transfer_id)
}

/// Copy a file directly from one SFTP-backed session to another, streaming the
/// bytes **through the desktop with no local staging file** (product feature
/// PROD-0013).
///
/// Enqueues ONE rich transfer that reads from `src_session`'s dedicated SFTP
/// channel and writes to `dst_session`'s channel via the shared chunked-copy
/// primitive — so a remote→remote paste surfaces as a single Transfer Queue row
/// instead of the download-to-temp + upload round-trip (two rows + a local disk
/// copy) it replaces. Rides the same executor as `session_download` /
/// `session_upload`, so pause/resume, auto-retry and byte-verified offset resume
/// all work; progress is measured on the write side and cancel removes the
/// partial destination.
///
/// Both endpoints must be SFTP-backed: each browser is resolved (and validated)
/// up front, so an unsupported / unreachable endpoint errors here rather than
/// silently on the queue. The row is registered under `dst_session` (where the
/// file lands); its name/path come from the destination remote path
/// (#1531/#1573). A server-side host-to-host copy (SCP/rsync) is a deferred
/// alternative — streaming through the desktop reaches everywhere both hosts are
/// reachable from the desktop.
#[tauri::command]
pub async fn session_copy_remote(
    src_session: String,
    src_path: String,
    dst_session: String,
    dst_path: String,
    manager: State<'_, SessionManager>,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    use crate::files::transfer::{self, TransferDirection};

    debug!(
        src_session,
        src_path, dst_session, dst_path, "Session SFTP remote-to-remote copy"
    );
    // Resolve (and validate) both SFTP browsers up front so an unsupported /
    // unreachable endpoint errors here rather than silently on the queue.
    let src_browser = manager.sftp_transfer_browser(&src_session).await?;
    let dst_browser = manager.sftp_transfer_browser(&dst_session).await?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    // Named/pathed for the *destination* (where the file lands), mirroring the
    // upload half of the retired temp-file dance (#1573).
    let file_name = crate::utils::fs::file_name_of(&dst_path);
    let handle = registry.enqueue(
        &transfer_id,
        &dst_session,
        TransferDirection::Upload,
        &file_name,
        &dst_path,
        0,
    );
    let registry = (*registry).clone();
    let sink = transfer::app_progress_sink(app_handle);
    tauri::async_runtime::spawn(async move {
        transfer::sftp::run_sftp_remote_copy(
            src_browser,
            dst_browser,
            src_path,
            dst_path,
            handle,
            registry,
            sink,
            transfer::sftp::DEFAULT_RESUME_MODE,
        )
        .await;
    });
    Ok(transfer_id)
}

/// List the rich (queued) transfers, optionally filtered by session.
#[tauri::command]
pub fn transfer_list(
    session_id: Option<String>,
    registry: State<'_, TransferRegistry>,
) -> Vec<TransferSnapshot> {
    registry.list(session_id.as_deref())
}

/// Parse the frontend FTP settings JSON into an expanded [`FtpConfig`].
#[cfg(feature = "ftp")]
fn parse_ftp_config(
    config: serde_json::Value,
) -> Result<termihub_core::config::FtpConfig, TerminalError> {
    let parsed: termihub_core::config::FtpConfig = serde_json::from_value(config)
        .map_err(|e| TerminalError::ConnectionFailed(format!("invalid FTP settings: {e}")))?;
    Ok(parsed.expand())
}

/// Register an FTP download (remote → local) as a queued transfer, returning
/// its `transfer_id`. Progress is reported via `transfer-progress` events.
#[tauri::command]
pub async fn ftp_download(
    session_id: String,
    config: serde_json::Value,
    remote_path: String,
    local_path: String,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    #[cfg(feature = "ftp")]
    {
        use crate::files::transfer::{self, TransferDirection};
        use termihub_core::backends::ftp::FtpDirection;

        debug!(session_id, remote_path, local_path, "FTP download");
        let config = parse_ftp_config(config)?;
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let file_name = file_name_of(&remote_path);
        let handle = registry.enqueue(
            &transfer_id,
            &session_id,
            TransferDirection::Download,
            &file_name,
            &remote_path,
            0,
        );
        let registry = (*registry).clone();
        let sink = transfer::app_progress_sink(app_handle);
        tauri::async_runtime::spawn(async move {
            transfer::ftp::run_ftp_transfer(
                config,
                FtpDirection::Download,
                remote_path,
                local_path,
                handle,
                registry,
                sink,
            )
            .await;
        });
        Ok(transfer_id)
    }
    #[cfg(not(feature = "ftp"))]
    {
        let _ = (
            session_id,
            config,
            remote_path,
            local_path,
            registry,
            app_handle,
        );
        Err(TerminalError::ConnectionFailed(
            "FTP support is not built into this binary".to_string(),
        ))
    }
}

/// Register an FTP upload (local → remote) as a queued transfer, returning its
/// `transfer_id`. Mirrors [`ftp_download`].
#[tauri::command]
pub async fn ftp_upload(
    session_id: String,
    config: serde_json::Value,
    local_path: String,
    remote_path: String,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    #[cfg(feature = "ftp")]
    {
        use crate::files::transfer::{self, TransferDirection};
        use termihub_core::backends::ftp::FtpDirection;

        debug!(session_id, local_path, remote_path, "FTP upload");
        let config = parse_ftp_config(config)?;
        let transfer_id = uuid::Uuid::new_v4().to_string();
        // Named for the *remote* path, not the local one, so the name always
        // agrees with the `path` this row displays (#1594, mirroring the SFTP
        // fix in #1573). Every honest local→remote upload builds `remote_path`
        // as `<dir>/<basename of local>`, so this is byte-for-byte unchanged
        // for them; it only differs for a future caller that uploads from a
        // scratch/temp path the user never named (as SFTP→SFTP paste does).
        let file_name = file_name_of(&remote_path);
        let handle = registry.enqueue(
            &transfer_id,
            &session_id,
            TransferDirection::Upload,
            &file_name,
            &remote_path,
            0,
        );
        let registry = (*registry).clone();
        let sink = transfer::app_progress_sink(app_handle);
        tauri::async_runtime::spawn(async move {
            transfer::ftp::run_ftp_transfer(
                config,
                FtpDirection::Upload,
                remote_path,
                local_path,
                handle,
                registry,
                sink,
            )
            .await;
        });
        Ok(transfer_id)
    }
    #[cfg(not(feature = "ftp"))]
    {
        let _ = (
            session_id,
            config,
            local_path,
            remote_path,
            registry,
            app_handle,
        );
        Err(TerminalError::ConnectionFailed(
            "FTP support is not built into this binary".to_string(),
        ))
    }
}
