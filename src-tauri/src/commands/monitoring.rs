use tauri::State;
use termihub_core::backends::ssh::parse_ssh_settings;
use tracing::{debug, info};

use crate::monitoring::{MonitoringManager, SystemStats};
use crate::utils::errors::TerminalError;

/// Open a new monitoring session. Returns the session ID.
///
/// Accepts raw JSON settings and parses them with `parse_ssh_settings`
/// so that array-encoded `env` fields are handled correctly.
///
/// Uses `spawn_blocking` so the SSH handshake (which can take ~75 s on a
/// dead host waiting for TCP SYN timeout) does not occupy a tokio worker
/// thread and starve the async runtime.
#[tauri::command]
pub async fn monitoring_open(
    config: serde_json::Value,
    manager: State<'_, MonitoringManager>,
) -> Result<String, TerminalError> {
    let config = parse_ssh_settings(&config);
    info!(host = %config.host, port = config.port, "Opening monitoring session");
    let manager = (*manager).clone();
    tokio::task::spawn_blocking(move || manager.open_session(&config))
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
}

/// Close a monitoring session.
#[tauri::command]
pub fn monitoring_close(session_id: String, manager: State<'_, MonitoringManager>) {
    info!(session_id, "Closing monitoring session");
    manager.close_session(&session_id);
}

/// Fetch system stats from a monitoring session.
///
/// Uses `spawn_blocking` so the blocking SSH exec does not occupy a tokio
/// worker thread.  Multiple concurrent calls (e.g. when the remote is dead
/// and reads take up to 15 s) therefore cannot starve the async runtime and
/// delay unrelated events such as `terminal-exit`.
#[tauri::command]
pub async fn monitoring_fetch_stats(
    session_id: String,
    manager: State<'_, MonitoringManager>,
) -> Result<SystemStats, TerminalError> {
    debug!(session_id, "Fetching monitoring stats");
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        let mut session = session.lock().unwrap();
        session.fetch_stats()
    })
    .await
    .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
}
