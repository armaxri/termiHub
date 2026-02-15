use serde::Serialize;
use tauri::{Emitter, State};

use crate::files::sftp::SftpManager;
use crate::files::FileEntry;
use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::vscode;

/// Open a new SFTP session. Returns the session ID.
#[tauri::command]
pub fn sftp_open(
    config: SshConfig,
    manager: State<'_, SftpManager>,
) -> Result<String, TerminalError> {
    manager.open_session(&config)
}

/// Close an SFTP session.
#[tauri::command]
pub fn sftp_close(session_id: String, manager: State<'_, SftpManager>) {
    manager.close_session(&session_id);
}

/// List directory contents via SFTP.
#[tauri::command]
pub fn sftp_list_dir(
    session_id: String,
    path: String,
    manager: State<'_, SftpManager>,
) -> Result<Vec<FileEntry>, TerminalError> {
    let session = manager.get_session(&session_id)?;
    let session = session.lock().unwrap();
    session.list_dir(&path)
}

/// Download a remote file to a local path. Returns bytes transferred.
#[tauri::command]
pub fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    manager: State<'_, SftpManager>,
) -> Result<u64, TerminalError> {
    let session = manager.get_session(&session_id)?;
    let session = session.lock().unwrap();
    session.read_file(&remote_path, &local_path)
}

/// Upload a local file to a remote path. Returns bytes transferred.
#[tauri::command]
pub fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    manager: State<'_, SftpManager>,
) -> Result<u64, TerminalError> {
    let session = manager.get_session(&session_id)?;
    let session = session.lock().unwrap();
    session.write_file(&local_path, &remote_path)
}

/// Create a directory on the remote host.
#[tauri::command]
pub fn sftp_mkdir(
    session_id: String,
    path: String,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let session = manager.get_session(&session_id)?;
    let session = session.lock().unwrap();
    session.mkdir(&path)
}

/// Delete a file or empty directory on the remote host.
#[tauri::command]
pub fn sftp_delete(
    session_id: String,
    path: String,
    is_directory: bool,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let session = manager.get_session(&session_id)?;
    let session = session.lock().unwrap();
    if is_directory {
        session.remove_dir(&path)
    } else {
        session.remove_file(&path)
    }
}

/// Rename a file or directory on the remote host.
#[tauri::command]
pub fn sftp_rename(
    session_id: String,
    old_path: String,
    new_path: String,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let session = manager.get_session(&session_id)?;
    let session = session.lock().unwrap();
    session.rename(&old_path, &new_path)
}

// --- Local filesystem commands ---

/// Return the current user's home directory path.
#[tauri::command]
pub fn get_home_dir() -> Result<String, TerminalError> {
    crate::files::local::home_dir()
}

/// List directory contents on the local filesystem.
#[tauri::command]
pub fn local_list_dir(path: String) -> Result<Vec<FileEntry>, TerminalError> {
    crate::files::local::list_dir(&path)
}

/// Create a directory on the local filesystem.
#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), TerminalError> {
    crate::files::local::mkdir(&path)
}

/// Delete a file or directory on the local filesystem.
#[tauri::command]
pub fn local_delete(path: String, is_directory: bool) -> Result<(), TerminalError> {
    crate::files::local::delete(&path, is_directory)
}

/// Rename a file or directory on the local filesystem.
#[tauri::command]
pub fn local_rename(old_path: String, new_path: String) -> Result<(), TerminalError> {
    crate::files::local::rename(&old_path, &new_path)
}

/// Read a local file's contents as a UTF-8 string.
#[tauri::command]
pub fn local_read_file(path: String) -> Result<String, TerminalError> {
    crate::files::local::read_file_content(&path)
}

/// Write a string to a local file.
#[tauri::command]
pub fn local_write_file(path: String, content: String) -> Result<(), TerminalError> {
    crate::files::local::write_file_content(&path, &content)
}

/// Read a remote file's contents as a UTF-8 string via SFTP.
#[tauri::command]
pub fn sftp_read_file_content(
    session_id: String,
    remote_path: String,
    manager: State<'_, SftpManager>,
) -> Result<String, TerminalError> {
    let session = manager.get_session(&session_id)?;
    let session = session.lock().unwrap();
    session.read_file_content(&remote_path)
}

/// Write a string to a remote file via SFTP.
#[tauri::command]
pub fn sftp_write_file_content(
    session_id: String,
    remote_path: String,
    content: String,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let session = manager.get_session(&session_id)?;
    let session = session.lock().unwrap();
    session.write_file_content(&remote_path, &content)
}

// --- VS Code integration ---

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VscodeEditCompleteEvent {
    remote_path: String,
    success: bool,
    error: Option<String>,
}

/// Check if VS Code CLI (`code`) is available on PATH.
#[tauri::command]
pub fn vscode_available() -> bool {
    vscode::is_vscode_available()
}

/// Open a local file in VS Code (fire-and-forget).
#[tauri::command]
pub fn vscode_open_local(path: String) -> Result<(), TerminalError> {
    vscode::open_in_vscode(&path).map_err(|e| TerminalError::EditorError(e.to_string()))
}

/// Open a remote file in VS Code: download, open with --wait, re-upload on close.
#[tauri::command]
pub fn vscode_open_remote(
    session_id: String,
    remote_path: String,
    manager: State<'_, SftpManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), TerminalError> {
    // Get a clone of the session Arc before spawning the background thread
    let session_arc = manager.get_session(&session_id)?;

    // Extract the filename from the remote path
    let filename = std::path::Path::new(&remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "untitled".to_string());

    // Create a temp directory for editing
    let temp_dir = std::env::temp_dir().join("termihub-edit");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| TerminalError::EditorError(format!("Failed to create temp dir: {}", e)))?;

    let temp_path = temp_dir.join(format!("{}-{}", uuid::Uuid::new_v4(), filename));
    let temp_path_str = temp_path.to_string_lossy().to_string();

    // Download the remote file to temp
    {
        let session = session_arc.lock().unwrap();
        session.read_file(&remote_path, &temp_path_str)?;
    }

    // Spawn a background thread to wait for VS Code to close
    let remote_path_clone = remote_path.clone();
    std::thread::spawn(move || {
        let result = vscode::open_in_vscode_wait(&temp_path_str);

        let event = match result {
            Ok(()) => {
                // Re-upload the edited file
                let upload_result = {
                    let session = session_arc.lock().unwrap();
                    session.write_file(&temp_path_str, &remote_path_clone)
                };
                match upload_result {
                    Ok(_) => VscodeEditCompleteEvent {
                        remote_path: remote_path_clone,
                        success: true,
                        error: None,
                    },
                    Err(e) => VscodeEditCompleteEvent {
                        remote_path: remote_path_clone,
                        success: false,
                        error: Some(format!("Upload failed: {}", e)),
                    },
                }
            }
            Err(e) => VscodeEditCompleteEvent {
                remote_path: remote_path_clone,
                success: false,
                error: Some(format!("VS Code error: {}", e)),
            },
        };

        // Clean up temp file (best-effort)
        let _ = std::fs::remove_file(&temp_path);

        // Emit event to frontend
        let _ = app_handle.emit("vscode-edit-complete", event);
    });

    Ok(())
}
