use tauri::State;
use termihub_core::backends::ssh::parse_ssh_settings;
use tracing::{debug, info};

use crate::monitoring::{MonitoringManager, SystemStats};
use crate::utils::errors::TerminalError;

/// Open a new monitoring session. Returns the session ID.
///
/// Accepts raw JSON settings and parses them with `parse_ssh_settings`
/// so that array-encoded `env` fields are handled correctly.
#[tauri::command]
pub fn monitoring_open(
    config: serde_json::Value,
    manager: State<'_, MonitoringManager>,
) -> Result<String, TerminalError> {
    let config = parse_ssh_settings(&config);
    info!(host = %config.host, port = config.port, "Opening monitoring session");
    manager.open_session(&config)
}

/// Close a monitoring session.
#[tauri::command]
pub fn monitoring_close(session_id: String, manager: State<'_, MonitoringManager>) {
    info!(session_id, "Closing monitoring session");
    manager.close_session(&session_id);
}

/// Fetch system stats from a monitoring session.
#[tauri::command]
pub fn monitoring_fetch_stats(
    session_id: String,
    manager: State<'_, MonitoringManager>,
) -> Result<SystemStats, TerminalError> {
    debug!(session_id, "Fetching monitoring stats");
    let session = manager.get_session(&session_id)?;
    let mut session = session.lock().unwrap();
    session.fetch_stats()
}
