use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use tracing::{debug, info};

use crate::connection::config::{ConnectionFolder, SavedConnection, SavedRemoteAgent};
use crate::connection::manager::{self, ConnectionManager};
use crate::connection::settings::AppSettings;
use crate::credential::CredentialManager;

/// Response containing all connections (unified), folders, and agents.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionData {
    pub connections: Vec<SavedConnection>,
    pub folders: Vec<ConnectionFolder>,
    pub agents: Vec<SavedRemoteAgent>,
    /// Errors from loading external files (file_path -> error message).
    pub external_errors: Vec<ExternalFileError>,
}

/// An error encountered when loading an external connection file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFileError {
    pub file_path: String,
    pub error: String,
}

/// Load all saved connections, folders, and agents (unified view).
#[tauri::command]
pub fn load_connections_and_folders(
    manager: State<'_, ConnectionManager>,
) -> Result<ConnectionData, String> {
    info!("Loading connections and folders");
    let store = manager.get_all().map_err(|e| e.to_string())?;

    // Flatten external connections into the main connections list
    let external_sources = manager.load_external_sources();
    let mut all_connections = store.connections;
    let mut external_errors = Vec::new();

    for source in external_sources {
        if let Some(err) = source.error {
            external_errors.push(ExternalFileError {
                file_path: source.file_path,
                error: err,
            });
        }
        all_connections.extend(source.connections);
    }

    Ok(ConnectionData {
        connections: all_connections,
        folders: store.folders,
        agents: store.agents,
        external_errors,
    })
}

/// Save (add or update) a connection, routing to the correct file based on `sourceFile`.
#[tauri::command]
pub fn save_connection(
    connection: SavedConnection,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    debug!(id = %connection.id, name = %connection.name, "Saving connection");
    manager
        .save_connection_routed(connection)
        .map_err(|e| e.to_string())
}

/// Delete a connection by ID, optionally from an external file.
#[tauri::command]
pub fn delete_connection(
    id: String,
    source_file: Option<String>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    info!(id, ?source_file, "Deleting connection");
    manager
        .delete_connection_routed(&id, source_file.as_deref())
        .map_err(|e| e.to_string())
}

/// Move a connection between storage files (main <-> external).
#[tauri::command]
pub fn move_connection_to_file(
    connection_id: String,
    current_source: Option<String>,
    target_source: Option<String>,
    manager: State<'_, ConnectionManager>,
) -> Result<SavedConnection, String> {
    info!(
        connection_id,
        ?current_source,
        ?target_source,
        "Moving connection to file"
    );
    manager
        .move_connection_to_file(&connection_id, current_source.as_deref(), target_source)
        .map_err(|e| e.to_string())
}

/// Save (add or update) a folder.
#[tauri::command]
pub fn save_folder(
    folder: ConnectionFolder,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager.save_folder(folder).map_err(|e| e.to_string())
}

/// Delete a folder by ID.
#[tauri::command]
pub fn delete_folder(id: String, manager: State<'_, ConnectionManager>) -> Result<(), String> {
    manager.delete_folder(&id).map_err(|e| e.to_string())
}

/// Export all connections as a JSON string.
#[tauri::command]
pub fn export_connections(manager: State<'_, ConnectionManager>) -> Result<String, String> {
    manager.export_json().map_err(|e| e.to_string())
}

/// Import connections from a JSON string. Returns the number imported.
#[tauri::command]
pub fn import_connections(
    json: String,
    manager: State<'_, ConnectionManager>,
) -> Result<usize, String> {
    manager.import_json(&json).map_err(|e| e.to_string())
}

/// Get the current application settings.
#[tauri::command]
pub fn get_settings(manager: State<'_, ConnectionManager>) -> Result<AppSettings, String> {
    Ok(manager.get_settings())
}

/// Update and persist application settings.
#[tauri::command]
pub fn save_settings(
    settings: AppSettings,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager.save_settings(settings).map_err(|e| e.to_string())
}

/// Save an external connection file to disk.
#[tauri::command]
pub fn save_external_file(
    file_path: String,
    name: String,
    folders: Vec<ConnectionFolder>,
    connections: Vec<SavedConnection>,
    credential_store: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    manager::save_external_file(&file_path, &name, folders, connections, &**credential_store)
        .map_err(|e| e.to_string())
}

/// Reload external connection files and return flattened connections.
#[tauri::command]
pub fn reload_external_connections(
    manager: State<'_, ConnectionManager>,
) -> Result<Vec<SavedConnection>, String> {
    let sources = manager.load_external_sources();
    let mut connections = Vec::new();
    for source in sources {
        connections.extend(source.connections);
    }
    Ok(connections)
}

/// Save (add or update) a remote agent definition.
#[tauri::command]
pub fn save_remote_agent(
    agent: SavedRemoteAgent,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager.save_agent(agent).map_err(|e| e.to_string())
}

/// Delete a remote agent definition by ID.
#[tauri::command]
pub fn delete_remote_agent(
    id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager.delete_agent(&id).map_err(|e| e.to_string())
}
