use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;
use tracing::{debug, info};

use crate::connection::config::{
    ConnectionFolder, ImportPreview, ImportResult, SavedConnection, SavedRemoteAgent,
};
use crate::connection::manager::{self, ConnectionManager};
use crate::connection::recovery::RecoveryWarning;
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
    let flat = manager.get_all().map_err(|e| e.to_string())?;

    // Flatten external connections into the main connections list
    let external_sources = manager.load_external_sources();
    let mut all_connections = flat.connections;
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
        folders: flat.folders,
        agents: flat.agents,
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

/// Export connections with optional encrypted credentials.
///
/// If `export_password` is provided, credentials from the store are
/// encrypted and included in the export. If `connection_ids` is provided,
/// only those connections are exported.
#[tauri::command]
pub fn export_connections_encrypted(
    export_password: Option<String>,
    connection_ids: Option<Vec<String>>,
    manager: State<'_, ConnectionManager>,
) -> Result<String, String> {
    info!(
        "Exporting connections (encrypted={})",
        export_password.is_some()
    );
    manager
        .export_encrypted_json(export_password.as_deref(), connection_ids.as_deref())
        .map_err(|e| e.to_string())
}

/// Preview the contents of an import file without performing the import.
#[tauri::command]
pub fn preview_import(json: String) -> Result<ImportPreview, String> {
    manager::preview_import_json(&json).map_err(|e| e.to_string())
}

/// Import connections with optional credential decryption.
///
/// If the import file contains an `$encrypted` section and
/// `import_password` is provided, credentials are decrypted and stored.
#[tauri::command]
pub fn import_connections_with_credentials(
    json: String,
    import_password: Option<String>,
    manager: State<'_, ConnectionManager>,
) -> Result<ImportResult, String> {
    info!(
        "Importing connections (with_credentials={})",
        import_password.is_some()
    );
    manager
        .import_encrypted_json(&json, import_password.as_deref())
        .map_err(|e| e.to_string())
}

/// Drain and return any recovery warnings collected during app startup.
///
/// Returns an empty list on subsequent calls (warnings are drained on first call).
#[tauri::command]
pub fn get_recovery_warnings(
    warnings: State<'_, Mutex<Vec<RecoveryWarning>>>,
) -> Vec<RecoveryWarning> {
    warnings
        .lock()
        .map(|mut w| w.drain(..).collect())
        .unwrap_or_default()
}
