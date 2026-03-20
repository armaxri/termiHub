use tauri::State;
use tauri_plugin_cli::CliExt;

use crate::utils::errors::TerminalError;
use crate::workspace::config::{WorkspaceDefinition, WorkspaceSummary};
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
