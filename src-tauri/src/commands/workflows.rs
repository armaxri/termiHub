use tauri::State;

use crate::utils::errors::TerminalError;
use crate::workflows::config::Workflow;
use crate::workflows::history::WorkflowRun;
use crate::workflows::history_manager::WorkflowRunHistoryManager;
use crate::workflows::manager::WorkflowManager;

/// List all stored workflows.
#[tauri::command]
pub fn list_workflows(manager: State<'_, WorkflowManager>) -> Result<Vec<Workflow>, TerminalError> {
    manager.list_workflows()
}

/// Get a single workflow by ID.
#[tauri::command]
pub fn get_workflow(
    workflow_id: String,
    manager: State<'_, WorkflowManager>,
) -> Result<Workflow, TerminalError> {
    manager.get_workflow(&workflow_id)
}

/// Save (add or update) a workflow. Returns the stored workflow with
/// authoritative timestamps.
#[tauri::command]
pub fn save_workflow(
    workflow_def: Workflow,
    manager: State<'_, WorkflowManager>,
) -> Result<Workflow, TerminalError> {
    manager.save_workflow(workflow_def)
}

/// Delete a workflow by ID.
#[tauri::command]
pub fn delete_workflow(
    workflow_id: String,
    manager: State<'_, WorkflowManager>,
) -> Result<(), TerminalError> {
    manager.delete_workflow(&workflow_id)
}

/// List all recorded workflow runs, most-recent first (PROD-0046).
#[tauri::command]
pub fn list_workflow_runs(
    manager: State<'_, WorkflowRunHistoryManager>,
) -> Result<Vec<WorkflowRun>, TerminalError> {
    manager.list()
}

/// Record a finished workflow run. Returns the updated (capped, newest-first)
/// history list.
#[tauri::command]
pub fn record_workflow_run(
    run: WorkflowRun,
    manager: State<'_, WorkflowRunHistoryManager>,
) -> Result<Vec<WorkflowRun>, TerminalError> {
    manager.record(run)
}

/// Clear the entire workflow run history.
#[tauri::command]
pub fn clear_workflow_run_history(
    manager: State<'_, WorkflowRunHistoryManager>,
) -> Result<Vec<WorkflowRun>, TerminalError> {
    manager.clear()
}
