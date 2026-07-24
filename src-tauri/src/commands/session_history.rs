use serde_json::Value;
use tauri::State;

use crate::session_history::config::SessionHistoryEntry;
use crate::session_history::manager::SessionHistoryManager;
use crate::utils::errors::TerminalError;

/// List all session-history entries, ordered for display (pinned first, then
/// most-recently-used first).
#[tauri::command]
pub fn get_session_history(
    manager: State<'_, SessionHistoryManager>,
) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
    manager.list()
}

/// Record a session open (deduplicated), trimming to `limit`. Returns the full
/// updated, display-ordered list.
#[tauri::command]
pub fn record_session(
    connection_type: String,
    config: Value,
    title: String,
    limit: u32,
    manager: State<'_, SessionHistoryManager>,
) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
    manager.record(&connection_type, config, title, limit)
}

/// Pin or unpin a history entry.
#[tauri::command]
pub fn set_history_entry_pinned(
    dedup_key: String,
    pinned: bool,
    manager: State<'_, SessionHistoryManager>,
) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
    manager.set_pinned(&dedup_key, pinned)
}

/// Mark a history entry as promoted to a saved connection (kept in history).
#[tauri::command]
pub fn mark_history_entry_promoted(
    dedup_key: String,
    manager: State<'_, SessionHistoryManager>,
) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
    manager.set_promoted(&dedup_key)
}

/// Remove a single history entry.
#[tauri::command]
pub fn remove_history_entry(
    dedup_key: String,
    manager: State<'_, SessionHistoryManager>,
) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
    manager.remove(&dedup_key)
}

/// Clear all session history.
#[tauri::command]
pub fn clear_session_history(
    manager: State<'_, SessionHistoryManager>,
) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
    manager.clear()
}
