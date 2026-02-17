use tauri::State;

use crate::terminal::backend::ConnectionConfig;
use crate::terminal::manager::TerminalManager;
use crate::terminal::serial;
use crate::utils::errors::TerminalError;
use crate::utils::shell_detect;

/// Create a new terminal session.
#[tauri::command]
pub fn create_terminal(
    config: ConnectionConfig,
    app_handle: tauri::AppHandle,
    manager: State<'_, TerminalManager>,
) -> Result<String, TerminalError> {
    manager.create_session(config, app_handle)
}

/// Send input data to a terminal session.
#[tauri::command]
pub fn send_input(
    session_id: String,
    data: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.send_input(&session_id, data.as_bytes())
}

/// Resize a terminal session.
#[tauri::command]
pub fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.resize(&session_id, cols, rows)
}

/// Close a terminal session.
#[tauri::command]
pub fn close_terminal(
    session_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.close_session(&session_id)
}

/// List available shells on this platform.
#[tauri::command]
pub fn list_available_shells() -> Vec<String> {
    shell_detect::detect_available_shells()
}

/// List available serial ports.
#[tauri::command]
pub fn list_serial_ports() -> Vec<String> {
    serial::list_serial_ports()
}

/// Check if a local X server is available for X11 forwarding.
#[tauri::command]
pub fn check_x11_available() -> bool {
    crate::utils::x11_detect::is_x_server_likely_running()
}

/// Check whether the SSH agent is running, stopped, or not installed.
#[tauri::command]
pub fn check_ssh_agent_status() -> String {
    crate::utils::ssh_auth::check_ssh_agent_status()
}
