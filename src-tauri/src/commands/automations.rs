//! IPC commands for the merged automation store and its run history (#5818).
//!
//! The frontend reads and writes only these since slice 4; the legacy macro
//! and workflow files are frozen.

use tauri::State;

use crate::automations::config::Automation;
use crate::automations::history::AutomationRun;
use crate::automations::history_manager::AutomationRunHistoryManager;
use crate::automations::manager::AutomationManager;
use crate::automations::trust::SaveOrigin;
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
/// authoritative timestamps. A new one that is a copy names its source in `copy_of`:
/// the copy of an imported automation is an imported one (#6019).
#[tauri::command]
pub fn save_automation(
    automation: Automation,
    copy_of: Option<String>,
    manager: State<'_, AutomationManager>,
) -> Result<Automation, TerminalError> {
    match copy_of {
        Some(source) => manager.save_from(automation, SaveOrigin::CopyOf(&source)),
        None => manager.save(automation),
    }
}

/// Save a new automation that came from a file. It asks before it first runs a
/// local program (#6019).
#[tauri::command]
pub fn import_automation(
    automation: Automation,
    manager: State<'_, AutomationManager>,
) -> Result<Automation, TerminalError> {
    manager.save_from(automation, SaveOrigin::Import)
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

/// Clear the automation run history: the runs with the given ids, or every
/// run when `run_ids` is absent. Returns the remaining runs, newest first.
#[tauri::command]
pub fn clear_automation_run_history(
    run_ids: Option<Vec<String>>,
    manager: State<'_, AutomationRunHistoryManager>,
) -> Result<Vec<AutomationRun>, TerminalError> {
    manager.clear_runs(run_ids.as_deref())
}
