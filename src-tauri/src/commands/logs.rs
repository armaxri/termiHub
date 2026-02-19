use tauri::State;

use crate::utils::log_capture::{LogEntry, SharedLogBuffer};

/// Return the most recent log entries from the ring buffer.
#[tauri::command]
pub fn get_logs(count: usize, buffer: State<'_, SharedLogBuffer>) -> Vec<LogEntry> {
    let buf = buffer.lock().unwrap();
    buf.get_recent(count)
}

/// Clear all buffered log entries.
#[tauri::command]
pub fn clear_logs(buffer: State<'_, SharedLogBuffer>) {
    let mut buf = buffer.lock().unwrap();
    buf.clear();
}
