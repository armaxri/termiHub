use tauri::State;

use crate::embedded_servers::config::{EmbeddedServerConfig, ServerState};
use crate::embedded_servers::server_manager::EmbeddedServerManager;
use crate::utils::errors::TerminalError;

/// Return all saved embedded server configurations.
#[tauri::command]
pub fn list_embedded_servers(
    manager: State<'_, EmbeddedServerManager>,
) -> Result<Vec<EmbeddedServerConfig>, TerminalError> {
    manager.get_configs()
}

/// Add or update an embedded server configuration.
#[tauri::command]
pub fn save_embedded_server(
    config: EmbeddedServerConfig,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    manager.save_config(config)
}

/// Delete an embedded server configuration by ID.
#[tauri::command]
pub fn delete_embedded_server(
    server_id: String,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    manager.delete_config(&server_id)
}

/// Get the current runtime state of all configured servers.
#[tauri::command]
pub fn get_embedded_server_states(
    manager: State<'_, EmbeddedServerManager>,
) -> Result<Vec<ServerState>, TerminalError> {
    manager.get_states()
}

/// Start a server by ID.
#[tauri::command]
pub fn start_embedded_server(
    server_id: String,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    manager.start_server(&server_id)
}

/// Stop a running server by ID.
#[tauri::command]
pub fn stop_embedded_server(
    server_id: String,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    manager.stop_server(&server_id)
}

/// Create a new server configuration and immediately start it.
///
/// If the requested port is in use, up to 10 sequential ports are tried.
/// Returns the ID of the newly created configuration.
#[tauri::command]
pub fn create_and_start_server(
    mut config: EmbeddedServerConfig,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<String, TerminalError> {
    // Generate an ID if none was provided.
    if config.id.is_empty() {
        config.id = format!(
            "srv-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            &uuid::Uuid::new_v4().to_string()[..8]
        );
    }

    // Try the initial port, then up to 9 more.
    let base_port = config.port;
    let mut last_err = String::new();
    for attempt in 0..10u16 {
        config.port = base_port + attempt;
        manager.save_config(config.clone())?;
        match manager.start_server(&config.id) {
            Ok(()) => return Ok(config.id),
            Err(e) => {
                last_err = e.to_string();
                // Remove the config we just saved and try the next port.
                let _ = manager.delete_config(&config.id);
            }
        }
    }

    Err(TerminalError::EmbeddedServerError(format!(
        "Could not start server: {last_err}"
    )))
}
