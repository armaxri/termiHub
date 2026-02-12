use tauri::State;

use crate::files::FileEntry;
use crate::files::sftp::SftpManager;
use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;

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
