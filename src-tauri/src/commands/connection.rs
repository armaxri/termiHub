use serde::Serialize;
use tauri::State;
use tracing::{debug, info};

use crate::connection::config::{ConnectionFolder, SavedConnection, SavedRemoteAgent};
use crate::connection::manager::{self, ConnectionManager};
use crate::connection::settings::AppSettings;

/// A loaded external connection source for the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalConnectionSource {
    pub file_path: String,
    pub name: String,
    pub folders: Vec<ConnectionFolder>,
    pub connections: Vec<SavedConnection>,
    pub error: Option<String>,
}

/// Response containing all connections, folders, and agents.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionData {
    pub connections: Vec<SavedConnection>,
    pub folders: Vec<ConnectionFolder>,
    pub external_sources: Vec<ExternalConnectionSource>,
    pub agents: Vec<SavedRemoteAgent>,
}

/// Load all saved connections, folders, and external sources.
#[tauri::command]
pub fn load_connections_and_folders(
    manager: State<'_, ConnectionManager>,
) -> Result<ConnectionData, String> {
    info!("Loading connections and folders");
    let store = manager.get_all().map_err(|e| e.to_string())?;
    let external_sources = manager
        .load_external_sources()
        .into_iter()
        .map(|s| ExternalConnectionSource {
            file_path: s.file_path,
            name: s.name,
            folders: s.folders,
            connections: s.connections,
            error: s.error,
        })
        .collect();

    Ok(ConnectionData {
        connections: store.connections,
        folders: store.folders,
        external_sources,
        agents: store.agents,
    })
}

/// Save (add or update) a connection.
#[tauri::command]
pub fn save_connection(
    connection: SavedConnection,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    debug!(id = %connection.id, name = %connection.name, "Saving connection");
    manager
        .save_connection(connection)
        .map_err(|e| e.to_string())
}

/// Delete a connection by ID.
#[tauri::command]
pub fn delete_connection(id: String, manager: State<'_, ConnectionManager>) -> Result<(), String> {
    info!(id, "Deleting connection");
    manager.delete_connection(&id).map_err(|e| e.to_string())
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
) -> Result<(), String> {
    manager::save_external_file(&file_path, &name, folders, connections).map_err(|e| e.to_string())
}

/// Reload external connection files and return them.
#[tauri::command]
pub fn reload_external_connections(
    manager: State<'_, ConnectionManager>,
) -> Result<Vec<ExternalConnectionSource>, String> {
    Ok(manager
        .load_external_sources()
        .into_iter()
        .map(|s| ExternalConnectionSource {
            file_path: s.file_path,
            name: s.name,
            folders: s.folders,
            connections: s.connections,
            error: s.error,
        })
        .collect())
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
