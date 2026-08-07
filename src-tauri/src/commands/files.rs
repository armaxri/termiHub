use serde::Serialize;
use tauri::{Emitter, Manager, State};
use termihub_core::backends::ssh::{SftpFileBrowser, SftpTransferChannel};
use termihub_core::files::FileBrowser;
use tracing::debug;

use crate::files::sftp::sftp_op_error;
use crate::files::transfer::TransferRegistry;
use crate::files::FileEntry;
use crate::utils::errors::TerminalError;
use crate::utils::vscode;

/// Open a dedicated [`SftpTransferChannel`] off `browser` and (for downloads)
/// stat the remote size. Both are awaited directly on the async core browser —
/// no `spawn_blocking` / `block_in_place` bridging is needed. Returns the
/// dedicated channel plus the known total size (`0` = indeterminate).
pub(crate) async fn open_transfer_channel(
    browser: std::sync::Arc<SftpFileBrowser>,
    remote_path: Option<String>,
) -> Result<(SftpTransferChannel, u64), TerminalError> {
    let dedicated = browser
        .open_dedicated_channel()
        .await
        .map_err(sftp_op_error)?;
    let total = match &remote_path {
        Some(path) => browser.remote_size(path).await,
        None => 0,
    };
    Ok((dedicated, total))
}

/// Cancel an in-flight transfer by id. Unknown / already-finished ids are a
/// harmless no-op (issue #1245).
#[tauri::command]
pub fn sftp_cancel_transfer(transfer_id: String, registry: State<'_, TransferRegistry>) {
    debug!(transfer_id, "SFTP cancel transfer");
    registry.cancel(&transfer_id);
}

// --- Local filesystem commands ---

/// Copy a file or directory on the local filesystem.
#[tauri::command]
pub fn local_copy(
    src_path: String,
    dest_path: String,
    is_directory: bool,
) -> Result<(), TerminalError> {
    crate::files::local::copy_file(&src_path, &dest_path, is_directory)
}

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

/// Start watching a local file for external on-disk changes (#1620).
///
/// `watch_id` is an opaque per-editor-instance key the frontend also matches the
/// resulting `local-file-changed` events against; re-watching the same id
/// replaces the previous watch. Only local editor files are watched — remote
/// (SFTP / session) files never call this.
#[tauri::command]
pub fn watch_local_file(
    watch_id: String,
    path: String,
    manager: State<'_, crate::files::watcher::FileWatchManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), TerminalError> {
    manager.watch(app_handle, watch_id, path)
}

/// Stop watching a local file previously registered with [`watch_local_file`].
/// Unknown ids are a harmless no-op.
#[tauri::command]
pub fn unwatch_local_file(
    watch_id: String,
    manager: State<'_, crate::files::watcher::FileWatchManager>,
) {
    manager.unwatch(&watch_id);
}

/// Start watching a local directory for external on-disk changes (#1626).
///
/// `watch_id` is an opaque per-browser-instance key the frontend also matches
/// the resulting `local-dir-changed` events against; re-watching the same id
/// replaces the previous watch (used to re-target when the browsed directory
/// changes). Only the local file browser watches — remote (SFTP / session)
/// browsers use their own transports and never call this.
#[tauri::command]
pub fn watch_local_dir(
    watch_id: String,
    path: String,
    manager: State<'_, crate::files::watcher::FileWatchManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), TerminalError> {
    manager.watch_dir(app_handle, watch_id, path)
}

/// Stop watching a local directory previously registered with
/// [`watch_local_dir`]. Unknown ids are a harmless no-op.
#[tauri::command]
pub fn unwatch_local_dir(
    watch_id: String,
    manager: State<'_, crate::files::watcher::FileWatchManager>,
) {
    manager.unwatch(&watch_id);
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

/// Download `remote_path` from `browser` to a temp file, open it in VS Code with
/// `--wait`, and re-upload on close, emitting a `vscode-edit-complete` event.
///
/// Drives the download → edit → re-upload flow on the one core
/// [`SftpFileBrowser`] for the session/`ConnectionType` path
/// ([`session_vscode_open_remote`](crate::commands::session::session_vscode_open_remote)),
/// which resolves the browser handle from the session (part of the #2307
/// SFTP-session convergence; the standalone `SftpManager` path was retired in
/// #2314). The initial download is awaited here; the `--wait` + re-upload run in
/// a spawned background task.
pub(crate) async fn open_remote_in_vscode(
    browser: std::sync::Arc<SftpFileBrowser>,
    remote_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), TerminalError> {
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

    // Download the remote file to temp via the async core browser.
    let data = browser
        .read_file(&remote_path)
        .await
        .map_err(sftp_op_error)?;
    tokio::fs::write(&temp_path, &data)
        .await
        .map_err(|e| TerminalError::EditorError(format!("Failed to write temp file: {e}")))?;

    // Wait for VS Code to close, then re-upload. The `--wait` blocks, so it runs
    // on a `spawn_blocking` thread; the re-read + re-upload are awaited on the
    // core browser.
    tauri::async_runtime::spawn(async move {
        let wait_path = temp_path_str.clone();
        let wait_result =
            tokio::task::spawn_blocking(move || vscode::open_in_vscode_wait(&wait_path)).await;

        let event = match wait_result {
            Ok(Ok(())) => match tokio::fs::read(&temp_path).await {
                Ok(edited) => match browser.write_file(&remote_path, &edited).await {
                    Ok(_) => VscodeEditCompleteEvent {
                        remote_path,
                        success: true,
                        error: None,
                    },
                    Err(e) => VscodeEditCompleteEvent {
                        remote_path,
                        success: false,
                        error: Some(format!("Upload failed: {}", e)),
                    },
                },
                Err(e) => VscodeEditCompleteEvent {
                    remote_path,
                    success: false,
                    error: Some(format!("Failed to re-read edited file: {}", e)),
                },
            },
            Ok(Err(e)) => VscodeEditCompleteEvent {
                remote_path,
                success: false,
                error: Some(format!("VS Code error: {}", e)),
            },
            Err(e) => VscodeEditCompleteEvent {
                remote_path,
                success: false,
                error: Some(format!("VS Code wait task failed: {}", e)),
            },
        };

        // Clean up temp file (best-effort)
        let _ = tokio::fs::remove_file(&temp_path).await;

        // Emit event to frontend
        let _ = app_handle.emit("vscode-edit-complete", event);
    });

    Ok(())
}

/// Write the keyboard shortcut cheat sheet HTML to the app cache directory
/// and return the absolute path so the frontend can open it in the system browser.
///
/// Uses native Rust file I/O so no `plugin-fs` permission scope is required.
#[tauri::command]
pub fn write_cheatsheet(html: String, app: tauri::AppHandle) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not resolve app cache dir: {e}"))?;

    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("could not create cache dir: {e}"))?;

    let file_path = cache_dir.join("termihub-shortcuts.html");

    std::fs::write(&file_path, html).map_err(|e| format!("could not write cheatsheet: {e}"))?;

    file_path
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "file path contains non-UTF-8 characters".to_string())
}
