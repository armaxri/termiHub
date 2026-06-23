use std::sync::Arc;

use tauri::State;

use crate::tunnel::config::{TunnelConfig, TunnelState};
use crate::tunnel::tunnel_manager::TunnelManager;
use crate::utils::errors::TerminalError;

/// Get all saved tunnel configurations.
#[tauri::command]
pub fn get_tunnels(
    manager: State<'_, Arc<TunnelManager>>,
) -> Result<Vec<TunnelConfig>, TerminalError> {
    manager.get_tunnels()
}

/// Save (add or update) a tunnel configuration.
#[tauri::command]
pub fn save_tunnel(
    config: TunnelConfig,
    manager: State<'_, Arc<TunnelManager>>,
) -> Result<(), TerminalError> {
    manager.save_tunnel(config)
}

/// Delete a tunnel configuration by ID.
#[tauri::command]
pub fn delete_tunnel(
    tunnel_id: String,
    manager: State<'_, Arc<TunnelManager>>,
) -> Result<(), TerminalError> {
    manager.delete_tunnel(&tunnel_id)
}

/// Get the current status of all tunnels.
#[tauri::command]
pub fn get_tunnel_statuses(
    manager: State<'_, Arc<TunnelManager>>,
) -> Result<Vec<TunnelState>, TerminalError> {
    manager.get_statuses()
}

/// Start a tunnel by ID.
///
/// `async` + `spawn_blocking`: starting a tunnel performs the SSH handshake,
/// which uses `block_in_place` internally (`utils::ssh_auth`). That is only
/// valid on a Tokio runtime worker — invoking it from a synchronous command
/// (which Tauri runs on the main thread) aborts the process. Mirrors
/// `monitoring_open`. See #828.
#[tauri::command]
pub async fn start_tunnel(
    tunnel_id: String,
    manager: State<'_, Arc<TunnelManager>>,
) -> Result<(), TerminalError> {
    let manager = (*manager).clone();
    tokio::task::spawn_blocking(move || manager.start_tunnel(&tunnel_id))
        .await
        .map_err(|e| TerminalError::TunnelError(format!("Task join error: {e}")))?
}

/// Stop an active tunnel by ID.
#[tauri::command]
pub fn stop_tunnel(
    tunnel_id: String,
    manager: State<'_, Arc<TunnelManager>>,
) -> Result<(), TerminalError> {
    manager.stop_tunnel(&tunnel_id)
}
