use tauri::State;

use crate::macros::config::Macro;
use crate::macros::history::MacroRun;
use crate::macros::history_manager::MacroRunHistoryManager;
use crate::macros::manager::MacroManager;
use crate::utils::errors::TerminalError;

/// List all stored macros.
#[tauri::command]
pub fn list_macros(manager: State<'_, MacroManager>) -> Result<Vec<Macro>, TerminalError> {
    manager.list_macros()
}

/// Get a single macro by ID.
#[tauri::command]
pub fn get_macro(
    macro_id: String,
    manager: State<'_, MacroManager>,
) -> Result<Macro, TerminalError> {
    manager.get_macro(&macro_id)
}

/// Save (add or update) a macro. Returns the stored macro with authoritative timestamps.
#[tauri::command]
pub fn save_macro(
    macro_def: Macro,
    manager: State<'_, MacroManager>,
) -> Result<Macro, TerminalError> {
    manager.save_macro(macro_def)
}

/// Delete a macro by ID.
#[tauri::command]
pub fn delete_macro(
    macro_id: String,
    manager: State<'_, MacroManager>,
) -> Result<(), TerminalError> {
    manager.delete_macro(&macro_id)
}

/// List all recorded macro playbacks, most-recent first (#3543).
#[tauri::command]
pub fn list_macro_runs(
    manager: State<'_, MacroRunHistoryManager>,
) -> Result<Vec<MacroRun>, TerminalError> {
    manager.list()
}

/// Record a finished macro playback. Returns the updated (capped,
/// newest-first) history list.
#[tauri::command]
pub fn record_macro_run(
    run: MacroRun,
    manager: State<'_, MacroRunHistoryManager>,
) -> Result<Vec<MacroRun>, TerminalError> {
    manager.record(run)
}

/// Clear the entire macro run history.
#[tauri::command]
pub fn clear_macro_run_history(
    manager: State<'_, MacroRunHistoryManager>,
) -> Result<Vec<MacroRun>, TerminalError> {
    manager.clear()
}
