//! IPC commands for the merged automation store and its run history (#5818).
//!
//! The frontend switches to these in slice 4; until then the macro and
//! workflow commands keep serving the UI.

use tauri::State;

use crate::automations::config::Automation;
use crate::automations::history::AutomationRun;
use crate::automations::history_manager::AutomationRunHistoryManager;
use crate::automations::manager::AutomationManager;
use crate::utils::errors::TerminalError;

/// List all stored automations.
#[tauri::command]
pub fn list_automations(
    manager: State<'_, AutomationManager>,
) -> Result<Vec<Automation>, TerminalError> {
    manager.list()
}

/// Get one automation by id.
#[tauri::command]
pub fn get_automation(
    automation_id: String,
    manager: State<'_, AutomationManager>,
) -> Result<Automation, TerminalError> {
    manager.get(&automation_id)
}

/// Save (add or update) an automation. Returns the stored automation with
/// authoritative timestamps.
#[tauri::command]
pub fn save_automation(
    automation: Automation,
    manager: State<'_, AutomationManager>,
) -> Result<Automation, TerminalError> {
    manager.save(automation)
}

/// Delete an automation by id.
#[tauri::command]
pub fn delete_automation(
    automation_id: String,
    manager: State<'_, AutomationManager>,
) -> Result<(), TerminalError> {
    manager.delete(&automation_id)
}

/// List all recorded automation runs, newest first.
#[tauri::command]
pub fn list_automation_runs(
    manager: State<'_, AutomationRunHistoryManager>,
) -> Result<Vec<AutomationRun>, TerminalError> {
    manager.list()
}

/// Record a finished run on one terminal. Returns the updated (capped,
/// newest-first) list.
#[tauri::command]
pub fn record_automation_run(
    run: AutomationRun,
    manager: State<'_, AutomationRunHistoryManager>,
) -> Result<Vec<AutomationRun>, TerminalError> {
    manager.record(run)
}

/// Clear the entire automation run history.
#[tauri::command]
pub fn clear_automation_run_history(
    manager: State<'_, AutomationRunHistoryManager>,
) -> Result<Vec<AutomationRun>, TerminalError> {
    manager.clear()
}
