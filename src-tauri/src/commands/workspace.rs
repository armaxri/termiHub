use tauri::State;

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
