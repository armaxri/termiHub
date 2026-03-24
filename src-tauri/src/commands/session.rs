//! Type-agnostic session commands using the unified [`ConnectionType`] trait.
//!
//! Replaces the old `terminal.rs` commands with a single `create_connection`
//! entry point and uniform I/O commands. File browsing and monitoring are
//! accessed through the session's connection capabilities.

use serde_json::Value;
use tauri::State;
use tracing::{debug, info};

use termihub_core::connection::ConnectionTypeInfo;
use termihub_core::files::FileEntry;

use crate::session::manager::SessionManager;
use crate::utils::errors::TerminalError;
use crate::utils::shell_detect;

/// Create a new connection session.
///
/// For local connections, pass `type_id` (e.g., "local", "ssh", "serial")
/// and `settings` (JSON matching the type's settings schema). For remote
/// (agent-mediated) connections, also pass `agent_id`.
#[tauri::command]
pub async fn create_connection(
    type_id: String,
    settings: Value,
    agent_id: Option<String>,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<String, TerminalError> {
    info!(type_id, agent_id = ?agent_id, "Creating connection");
    manager
        .create_connection(&type_id, settings, agent_id.as_deref(), app_handle)
        .await
}

/// Get the list of available connection types with their schemas.
#[tauri::command]
pub fn get_connection_types(manager: State<'_, SessionManager>) -> Vec<ConnectionTypeInfo> {
    manager.available_types()
}

/// Send input data to a session.
#[tauri::command]
pub async fn send_input(
    session_id: String,
    data: String,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    debug!(session_id, "Sending input");
    manager.send_input(&session_id, data.as_bytes()).await
}

/// Resize a session's terminal.
#[tauri::command]
pub async fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    debug!(session_id, cols, rows, "Resizing terminal");
    manager.resize(&session_id, cols, rows).await
}

/// Close a session.
#[tauri::command]
pub async fn close_terminal(
    session_id: String,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    info!(session_id, "Closing session");
    manager.close_session(&session_id).await
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
    termihub_core::session::serial::list_serial_ports()
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

/// Check if Podman is available on the local system.
#[tauri::command]
pub fn check_podman_available() -> bool {
    crate::utils::docker_detect::is_podman_available()
}

/// List locally available Podman images.
#[tauri::command]
pub fn list_podman_images() -> Vec<String> {
    crate::utils::docker_detect::list_podman_images()
}

/// Validate an SSH key file path and return a user-facing hint.
#[tauri::command]
pub async fn validate_ssh_key(path: String) -> crate::utils::ssh_key_validate::SshKeyValidation {
    tauri::async_runtime::spawn_blocking(move || {
        crate::utils::ssh_key_validate::validate_ssh_key(&path)
    })
    .await
    .unwrap_or_else(|_| crate::utils::ssh_key_validate::SshKeyValidation {
        status: crate::utils::ssh_key_validate::ValidationStatus::Error,
        message: "Validation task failed.".to_string(),
        key_type: String::new(),
    })
}

// --- Session-based file browsing commands ---

/// List directory contents via a session's file browser capability.
#[tauri::command]
pub async fn session_list_files(
    session_id: String,
    path: String,
    manager: State<'_, SessionManager>,
) -> Result<Vec<FileEntry>, TerminalError> {
    debug!(session_id, path, "Session file list");
    manager.list_files(&session_id, &path).await
}

/// Read a file via a session's file browser capability.
#[tauri::command]
pub async fn session_read_file(
    session_id: String,
    path: String,
    manager: State<'_, SessionManager>,
) -> Result<Vec<u8>, TerminalError> {
    debug!(session_id, path, "Session file read");
    manager.read_file(&session_id, &path).await
}

/// Write a file via a session's file browser capability.
#[tauri::command]
pub async fn session_write_file(
    session_id: String,
    path: String,
    data: Vec<u8>,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    debug!(session_id, path, "Session file write");
    manager.write_file(&session_id, &path, &data).await
}

/// Delete a file via a session's file browser capability.
#[tauri::command]
pub async fn session_delete_file(
    session_id: String,
    path: String,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    debug!(session_id, path, "Session file delete");
    manager.delete_file(&session_id, &path).await
}

/// Rename a file via a session's file browser capability.
#[tauri::command]
pub async fn session_rename_file(
    session_id: String,
    old_path: String,
    new_path: String,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    debug!(session_id, old_path, new_path, "Session file rename");
    manager.rename_file(&session_id, &old_path, &new_path).await
}

/// Create a directory via a session's file browser capability.
#[tauri::command]
pub async fn session_mkdir(
    session_id: String,
    path: String,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    debug!(session_id, path, "Session mkdir");
    manager.mkdir_file(&session_id, &path).await
}
