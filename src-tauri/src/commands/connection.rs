use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, State};
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
    // The unified main + external view (the same one reflected into the shadow
    // `ConnectionsStore` server-side, #2394), so the command and the projection
    // region cannot drift.
    let view = manager.load_unified_view().map_err(|e| e.to_string())?;

    Ok(ConnectionData {
        connections: view.connections,
        folders: view.folders,
        agents: view.agents,
        external_errors: view
            .external_errors
            .into_iter()
            .map(|(file_path, error)| ExternalFileError { file_path, error })
            .collect(),
    })
}

/// Save (add or update) a connection, routing to the correct file based on
/// `sourceFile`. Returns the connection's **persisted** id (recomputed from
/// folder + name), so the frontend can reconcile its optimistic `conn-<ts>` id.
#[tauri::command]
pub fn save_connection(
    connection: SavedConnection,
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<String, String> {
    debug!(id = %connection.id, name = %connection.name, "Saving connection");
    let persisted_id = manager
        .save_connection_routed(connection)
        .map_err(|e| e.to_string())?;
    // Server-authority fold (#2389/#2394): reflect the persisted tree — main
    // store *and* the external-file overlay — into the shadow `ConnectionsStore`
    // at the source. A save routed to an external file (`sourceFile` set) updates
    // the region via that overlay. Additive; no user-facing change.
    crate::connections_projection::projection::fold_connections_from_manager(&app);
    Ok(persisted_id)
}

/// Delete a connection by ID, optionally from an external file.
#[tauri::command]
pub fn delete_connection(
    id: String,
    source_file: Option<String>,
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    info!(id, ?source_file, "Deleting connection");
    manager
        .delete_connection_routed(&id, source_file.as_deref())
        .map_err(|e| e.to_string())?;
    crate::connections_projection::projection::fold_connections_from_manager(&app);
    Ok(())
}

/// Move a connection between storage files (main <-> external).
#[tauri::command]
pub fn move_connection_to_file(
    connection_id: String,
    current_source: Option<String>,
    target_source: Option<String>,
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<SavedConnection, String> {
    info!(
        connection_id,
        ?current_source,
        ?target_source,
        "Moving connection to file"
    );
    let moved = manager
        .move_connection_to_file(&connection_id, current_source.as_deref(), target_source)
        .map_err(|e| e.to_string())?;
    // The fold reflects both the main store and the external-file overlay
    // (#2394), so a move into/out of the main store *and* an external↔external
    // move (the `sourceFile` changes) are reflected in the region.
    crate::connections_projection::projection::fold_connections_from_manager(&app);
    Ok(moved)
}

/// Save (add or update) a folder.
#[tauri::command]
pub fn save_folder(
    folder: ConnectionFolder,
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager.save_folder(folder).map_err(|e| e.to_string())?;
    // Covers `addFolder` and the `toggleFolder`-persist edge (the frontend
    // persists a folder's `isExpanded` flip via `save_folder`).
    crate::connections_projection::projection::fold_connections_from_manager(&app);
    Ok(())
}

/// Delete a folder by ID.
#[tauri::command]
pub fn delete_folder(
    id: String,
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager.delete_folder(&id).map_err(|e| e.to_string())?;
    crate::connections_projection::projection::fold_connections_from_manager(&app);
    Ok(())
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
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<usize, String> {
    let count = manager.import_json(&json).map_err(|e| e.to_string())?;
    crate::connections_projection::projection::fold_connections_from_manager(&app);
    Ok(count)
}

/// Get the current application settings.
///
/// If `serial_port_scan_prefixes` has never been saved the field is `None` in
/// storage. We expand it to the full built-in default list before returning so
/// the frontend always receives a concrete, editable list.
#[tauri::command]
pub fn get_settings(manager: State<'_, ConnectionManager>) -> Result<AppSettings, String> {
    Ok(manager.get_settings_resolved())
}

/// Update and persist application settings.
#[tauri::command]
pub fn save_settings(
    settings: AppSettings,
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager.save_settings(settings).map_err(|e| e.to_string())?;
    // Server-authority fold (#2386): reflect the persisted `AppSettings`
    // document into the shadow `SettingsStore` at the source. Additive; no
    // user-facing change. (`AppHandle` is Tauri-injected — no JS invoke change.)
    crate::settings_projection::projection::fold_settings_from_manager(&app);
    Ok(())
}

/// Save an external connection file to disk.
#[tauri::command]
pub fn save_external_file(
    file_path: String,
    name: String,
    folders: Vec<ConnectionFolder>,
    connections: Vec<SavedConnection>,
    app: AppHandle,
    credential_store: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    manager::save_external_file(&file_path, &name, folders, connections, &**credential_store)
        .map_err(|e| e.to_string())?;
    // Server-authority fold (#2394): reflect the external-file overlay (as it is
    // now on disk) into the shadow `ConnectionsStore` when the saved file is a
    // currently-enabled external source. The fold resolves the `ConnectionManager`
    // from `app`. Additive; no user-facing change.
    crate::connections_projection::projection::fold_connections_from_manager(&app);
    Ok(())
}

/// Reload external connection files and return flattened connections.
#[tauri::command]
pub fn reload_external_connections(
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<Vec<SavedConnection>, String> {
    let sources = manager.load_external_sources();
    let mut connections = Vec::new();
    for source in sources {
        connections.extend(source.connections);
    }
    // Server-authority fold (#2394): the external overlay just changed on disk /
    // in the enabled set — reflect the unified main + external tree into the
    // shadow `ConnectionsStore` so the region stays in sync with the frontend's
    // `reloadExternalConnections`. Additive; no user-facing change.
    crate::connections_projection::projection::fold_connections_from_manager(&app);
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

/// Reorder remote agents by providing a list of agent IDs in the desired order.
#[tauri::command]
pub fn reorder_remote_agents(
    agent_ids: Vec<String>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    manager
        .reorder_agents(&agent_ids)
        .map_err(|e| e.to_string())
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
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<ImportResult, String> {
    info!(
        "Importing connections (with_credentials={})",
        import_password.is_some()
    );
    let result = manager
        .import_encrypted_json(&json, import_password.as_deref())
        .map_err(|e| e.to_string())?;
    crate::connections_projection::projection::fold_connections_from_manager(&app);
    Ok(result)
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
