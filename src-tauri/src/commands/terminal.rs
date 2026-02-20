use std::sync::Arc;

use tauri::State;
use tracing::{debug, info};

use crate::terminal::agent_manager::AgentConnectionManager;
use crate::terminal::backend::ConnectionConfig;
use crate::terminal::manager::TerminalManager;
use crate::terminal::serial;
use crate::utils::errors::TerminalError;
use crate::utils::shell_detect;
use crate::utils::ssh_key_validate::SshKeyValidation;

/// Create a new terminal session.
///
/// Async because session creation (SSH, Docker, serial) involves blocking
/// I/O that must not run on the main thread (which would freeze the WebView).
#[tauri::command]
pub async fn create_terminal(
    config: ConnectionConfig,
    app_handle: tauri::AppHandle,
    manager: State<'_, TerminalManager>,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<String, TerminalError> {
    info!("Creating terminal session");
    let agent_mgr = if matches!(config, ConnectionConfig::RemoteSession(_)) {
        Some(agent_manager.inner().clone())
    } else {
        None
    };
    let tm = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || tm.create_session(config, app_handle, agent_mgr))
        .await
        .unwrap_or_else(|e| {
            Err(TerminalError::SpawnFailed(format!(
                "Task join error: {}",
                e
            )))
        })
}

/// Send input data to a terminal session.
#[tauri::command]
pub fn send_input(
    session_id: String,
    data: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    debug!(session_id, "Sending input to terminal");
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
    debug!(session_id, cols, rows, "Resizing terminal");
    manager.resize(&session_id, cols, rows)
}

/// Close a terminal session.
#[tauri::command]
pub fn close_terminal(
    session_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    info!(session_id, "Closing terminal session");
    manager.close_session(&session_id)
}

/// List available shells on this platform.
#[tauri::command]
pub fn list_available_shells() -> Vec<String> {
    shell_detect::detect_available_shells()
}

/// Detect the user's default shell on this platform.
#[tauri::command]
pub fn get_default_shell() -> Option<String> {
    shell_detect::detect_default_shell()
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

/// Check if Docker is available on the local system.
#[tauri::command]
pub fn check_docker_available() -> bool {
    crate::utils::docker_detect::is_docker_available()
}

/// List locally available Docker images.
#[tauri::command]
pub fn list_docker_images() -> Vec<String> {
    crate::utils::docker_detect::list_docker_images()
}

/// Validate an SSH key file path and return a user-facing hint.
#[tauri::command]
pub async fn validate_ssh_key(path: String) -> SshKeyValidation {
    tauri::async_runtime::spawn_blocking(move || {
        crate::utils::ssh_key_validate::validate_ssh_key(&path)
    })
    .await
    .unwrap_or_else(|_| SshKeyValidation {
        status: crate::utils::ssh_key_validate::ValidationStatus::Error,
        message: "Validation task failed.".to_string(),
        key_type: String::new(),
    })
}
