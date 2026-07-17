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
use crate::utils::errors::TerminalError;

/// Pause an in-flight transfer. Unknown ids are a no-op.
#[tauri::command]
pub fn transfer_pause(transfer_id: String, registry: State<'_, TransferRegistry>) {
    debug!(transfer_id, "transfer pause");
    registry.pause(&transfer_id);
}

/// Resume a paused transfer. Unknown ids are a no-op.
#[tauri::command]
pub fn transfer_resume(transfer_id: String, registry: State<'_, TransferRegistry>) {
    debug!(transfer_id, "transfer resume");
    registry.resume(&transfer_id);
}

/// Cancel an in-flight transfer (queued, active, or paused). Unknown ids are a
/// no-op. Works for both legacy SFTP and rich FTP transfers.
#[tauri::command]
pub fn transfer_cancel(transfer_id: String, registry: State<'_, TransferRegistry>) {
    debug!(transfer_id, "transfer cancel");
    registry.cancel(&transfer_id);
}

/// Manually retry a failed transfer (resets its attempt counter). Unknown ids
/// are a no-op.
#[tauri::command]
pub fn transfer_retry(transfer_id: String, registry: State<'_, TransferRegistry>) {
    debug!(transfer_id, "transfer retry");
    registry.retry(&transfer_id);
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

/// Extract the display file name from a path (falls back to the whole path).
#[cfg(feature = "ftp")]
fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(all(test, feature = "ftp"))]
mod tests {
    use super::file_name_of;

    #[test]
    fn names_a_file_by_its_basename() {
        assert_eq!(file_name_of("/home/testuser/report.csv"), "report.csv");
        assert_eq!(file_name_of("/report.csv"), "report.csv");
        assert_eq!(file_name_of("report.csv"), "report.csv");
    }

    #[test]
    fn falls_back_to_the_whole_path_when_there_is_no_basename() {
        assert_eq!(file_name_of("/"), "/");
        assert_eq!(file_name_of(""), "");
        assert_eq!(file_name_of(".."), "..");
    }

    /// `ftp_upload` and `ftp_download` both name the row from the *remote* path,
    /// so a row's name always agrees with the `path` cell beside it (#1594,
    /// mirroring #1573 for SFTP). An honest local→remote upload has equal local
    /// and remote basenames, so the row is unchanged; only a caller uploading
    /// from a scratch/temp local copy the user never named would differ, and
    /// naming from the remote path keeps that scratch name off the row.
    #[test]
    fn names_an_upload_after_the_remote_destination_not_the_local_source() {
        let temp_local = "/tmp/termihub-paste-1784278708447-report.csv";
        let remote_dest = "/home/testuser/dest/report.csv";

        assert_eq!(file_name_of(remote_dest), "report.csv");
        assert_eq!(
            file_name_of(temp_local),
            "termihub-paste-1784278708447-report.csv",
            "the local scratch basename is what the row must NOT show",
        );
    }
}
