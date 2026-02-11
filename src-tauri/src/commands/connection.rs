use serde::Serialize;
use tauri::State;

use crate::connection::config::{ConnectionFolder, SavedConnection};
use crate::connection::manager::ConnectionManager;

/// Response containing all connections and folders.
#[derive(Serialize)]
pub struct ConnectionData {
    pub connections: Vec<SavedConnection>,
    pub folders: Vec<ConnectionFolder>,
}

/// Load all saved connections and folders.
#[tauri::command]
pub fn load_connections_and_folders(
    manager: State<'_, ConnectionManager>,
) -> Result<ConnectionData, String> {
    let store = manager.get_all().map_err(|e| e.to_string())?;
    Ok(ConnectionData {
        connections: store.connections,
        folders: store.folders,
    })
}

/// Save (add or update) a connection.
#[tauri::command]
pub fn save_connection(
    connection: SavedConnection,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager.save_connection(connection).map_err(|e| e.to_string())
}

/// Delete a connection by ID.
#[tauri::command]
pub fn delete_connection(
    id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
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
pub fn delete_folder(
    id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager.delete_folder(&id).map_err(|e| e.to_string())
}

/// Export all connections as a JSON string.
#[tauri::command]
pub fn export_connections(
    manager: State<'_, ConnectionManager>,
) -> Result<String, String> {
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
