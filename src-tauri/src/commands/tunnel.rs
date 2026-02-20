use tauri::State;

use crate::tunnel::config::{TunnelConfig, TunnelState};
use crate::tunnel::tunnel_manager::TunnelManager;
use crate::utils::errors::TerminalError;

/// Get all saved tunnel configurations.
#[tauri::command]
pub fn get_tunnels(manager: State<'_, TunnelManager>) -> Result<Vec<TunnelConfig>, TerminalError> {
    manager.get_tunnels()
}

/// Save (add or update) a tunnel configuration.
#[tauri::command]
pub fn save_tunnel(
    config: TunnelConfig,
    manager: State<'_, TunnelManager>,
) -> Result<(), TerminalError> {
    manager.save_tunnel(config)
}

/// Delete a tunnel configuration by ID.
#[tauri::command]
pub fn delete_tunnel(
    tunnel_id: String,
    manager: State<'_, TunnelManager>,
) -> Result<(), TerminalError> {
    manager.delete_tunnel(&tunnel_id)
}

/// Get the current status of all tunnels.
#[tauri::command]
pub fn get_tunnel_statuses(
    manager: State<'_, TunnelManager>,
) -> Result<Vec<TunnelState>, TerminalError> {
    manager.get_statuses()
}

/// Start a tunnel by ID.
#[tauri::command]
pub fn start_tunnel(
    tunnel_id: String,
    manager: State<'_, TunnelManager>,
) -> Result<(), TerminalError> {
    manager.start_tunnel(&tunnel_id)
}

/// Stop an active tunnel by ID.
#[tauri::command]
pub fn stop_tunnel(
    tunnel_id: String,
    manager: State<'_, TunnelManager>,
) -> Result<(), TerminalError> {
    manager.stop_tunnel(&tunnel_id)
}
