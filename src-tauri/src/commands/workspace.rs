use std::collections::HashMap;

use tauri::State;
use tauri_plugin_cli::CliExt;

use crate::connection::manager::ConnectionManager;
use crate::utils::errors::TerminalError;
use crate::workspace::config::{WorkspaceDefinition, WorkspaceImportPreview, WorkspaceSummary};
use crate::workspace::manager::WorkspaceManager;

/// Get all workspace summaries for sidebar display.
#[tauri::command]
pub fn get_workspaces(
    manager: State<'_, WorkspaceManager>,
) -> Result<Vec<WorkspaceSummary>, TerminalError> {
    manager.get_workspaces()
}

/// Load a full workspace definition by ID.
#[tauri::command]
pub fn load_workspace(
    workspace_id: String,
    manager: State<'_, WorkspaceManager>,
) -> Result<WorkspaceDefinition, TerminalError> {
    manager.load_workspace(&workspace_id)
}

/// Save (add or update) a workspace definition.
#[tauri::command]
pub fn save_workspace(
    definition: WorkspaceDefinition,
    manager: State<'_, WorkspaceManager>,
) -> Result<(), TerminalError> {
    manager.save_workspace(definition)
}

/// Delete a workspace by ID.
#[tauri::command]
pub fn delete_workspace(
    workspace_id: String,
    manager: State<'_, WorkspaceManager>,
) -> Result<(), TerminalError> {
    manager.delete_workspace(&workspace_id)
}

/// Duplicate a workspace by ID, returning the new workspace's ID.
#[tauri::command]
pub fn duplicate_workspace(
    workspace_id: String,
    manager: State<'_, WorkspaceManager>,
) -> Result<String, TerminalError> {
    manager.duplicate_workspace(&workspace_id)
}

/// Check CLI arguments for a workspace to launch.
/// Returns the workspace name if `--workspace` or `--workspace-file` was provided.
#[tauri::command]
pub fn get_cli_workspace(
    app_handle: tauri::AppHandle,
    manager: State<'_, WorkspaceManager>,
) -> Result<Option<String>, TerminalError> {
    let matches = match app_handle.cli().matches() {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };

    // Check --workspace flag
    if let Some(arg) = matches.args.get("workspace") {
        if let serde_json::Value::String(name) = &arg.value {
            if !name.is_empty() {
                return Ok(Some(name.clone()));
            }
        }
    }

    // Check --workspace-file flag: read file, save workspace, return name
    if let Some(arg) = matches.args.get("workspace-file") {
        if let serde_json::Value::String(path) = &arg.value {
            if !path.is_empty() {
                let content = std::fs::read_to_string(path).map_err(|e| {
                    TerminalError::WorkspaceError(format!(
                        "Cannot read workspace file '{path}': {e}"
                    ))
                })?;
                let definition: WorkspaceDefinition =
                    serde_json::from_str(&content).map_err(|e| {
                        TerminalError::WorkspaceError(format!(
                            "Invalid workspace file '{path}': {e}"
                        ))
                    })?;
                let name = definition.name.clone();
                manager.save_workspace(definition)?;
                return Ok(Some(name));
            }
        }
    }

    Ok(None)
}

/// Build a connection ID → name mapping from the connection manager.
fn build_id_to_name_map(
    connection_manager: &ConnectionManager,
) -> Result<HashMap<String, String>, TerminalError> {
    let flat = connection_manager
        .get_all()
        .map_err(|e| TerminalError::WorkspaceError(format!("Cannot read connections: {e}")))?;
    Ok(flat
        .connections
        .iter()
        .map(|c| (c.id.clone(), c.name.clone()))
        .collect())
}

/// Build a connection name → ID mapping from the connection manager.
fn build_name_to_id_map(
    connection_manager: &ConnectionManager,
) -> Result<HashMap<String, String>, TerminalError> {
    let flat = connection_manager
        .get_all()
        .map_err(|e| TerminalError::WorkspaceError(format!("Cannot read connections: {e}")))?;
    Ok(flat
        .connections
        .iter()
        .map(|c| (c.name.clone(), c.id.clone()))
        .collect())
}

/// Export all workspaces as portable JSON (connection IDs replaced with names).
#[tauri::command]
pub fn export_workspaces(
    workspace_manager: State<'_, WorkspaceManager>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<String, TerminalError> {
    let id_to_name = build_id_to_name_map(&connection_manager)?;
    workspace_manager.export_json(&id_to_name)
}

/// Import workspaces from portable JSON (connection names resolved to IDs).
/// Returns the number of workspaces imported.
#[tauri::command]
pub fn import_workspaces(
    json: String,
    workspace_manager: State<'_, WorkspaceManager>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<usize, TerminalError> {
    let name_to_id = build_name_to_id_map(&connection_manager)?;
    workspace_manager.import_json(&json, &name_to_id)
}

/// Preview a workspace import file without importing.
#[tauri::command]
pub fn preview_import_workspaces(json: String) -> Result<WorkspaceImportPreview, TerminalError> {
    WorkspaceManager::preview_import_json(&json)
}
