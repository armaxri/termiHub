use serde::Serialize;
use tauri::{Emitter, Manager, State};
use termihub_core::backends::ssh::{
    parse_ssh_settings, SftpAdvancedOps, SftpFileBrowser, SftpTransferChannel,
};
use termihub_core::files::FileBrowser;
use tracing::{debug, info};

use crate::connection::manager::ConnectionManager;
use crate::files::sftp::{sftp_op_error, ElevatedWriteResult, SftpManager, Writability};
use crate::files::transfer::{self, TransferContext, TransferDirection, TransferRegistry};
use crate::files::FileEntry;
use crate::utils::errors::TerminalError;
use crate::utils::fs::file_name_of;
use crate::utils::vscode;

/// Open a new SFTP session. Returns the session ID.
///
/// Accepts raw JSON settings (same shape the frontend stores) and parses
/// them with `parse_ssh_settings` so that array-encoded `env` fields
/// (from the `keyValueList` schema type) are handled correctly.
#[tauri::command]
pub async fn sftp_open(
    mut config: serde_json::Value,
    manager: State<'_, SftpManager>,
    conn_manager: State<'_, ConnectionManager>,
) -> Result<String, TerminalError> {
    // Expand saved-connection jump-host references to inline hops before core
    // parses the chain (it only connects with inline hops) — #940.
    conn_manager
        .resolve_jump_host_refs(&mut config, None)
        .map_err(|e| TerminalError::ConnectionFailed(e.to_string()))?;
    let config = parse_ssh_settings(&config);
    info!(host = %config.host, port = config.port, "Opening SFTP session");
    // The core SFTP browser is fully async (russh), so the connect is awaited
    // directly on the command thread — no `spawn_blocking` / `block_in_place`
    // bridging is needed, exactly as the `ConnectionType` file-browser path does.
    manager.open_session(&config).await
}

/// Close an SFTP session.
#[tauri::command]
pub fn sftp_close(session_id: String, manager: State<'_, SftpManager>) {
    info!(session_id, "Closing SFTP session");
    manager.close_session(&session_id);
}

/// List directory contents via SFTP.
#[tauri::command]
pub async fn sftp_list_dir(
    session_id: String,
    path: String,
    manager: State<'_, SftpManager>,
) -> Result<Vec<FileEntry>, TerminalError> {
    debug!(session_id, path, "SFTP list directory");
    let browser = manager.get_session(&session_id)?;
    browser.list_dir(&path).await.map_err(sftp_op_error)
}

/// Get metadata (size, mtime, permissions) for a single remote file via SFTP.
///
/// Backs the editor's remote external-change detection (#1627): the frontend
/// re-stats the open file on an interval and compares `modified`/`size` to spot
/// an out-of-band change. A stat is a single metadata round-trip — far cheaper
/// than re-reading the file — so this is the lightweight poll primitive.
#[tauri::command]
pub async fn sftp_stat(
    session_id: String,
    path: String,
    manager: State<'_, SftpManager>,
) -> Result<FileEntry, TerminalError> {
    debug!(session_id, path, "SFTP stat");
    let browser = manager.get_session(&session_id)?;
    browser.stat(&path).await.map_err(sftp_op_error)
}

/// Resolve a remote path to its canonical absolute form via SFTP realpath.
///
/// Passing `"."` yields the session's home directory so the file browser can
/// land there without guessing `/home/<user>` (audit GAP C2, issue #1143).
#[tauri::command]
pub async fn sftp_realpath(
    session_id: String,
    path: String,
    manager: State<'_, SftpManager>,
) -> Result<String, TerminalError> {
    debug!(session_id, path, "SFTP realpath");
    let browser = manager.get_session(&session_id)?;
    browser.realpath(&path).await.map_err(sftp_op_error)
}

/// Authoritatively check whether a remote file is writable by the connecting
/// user, via a non-destructive SFTP write-open probe (issue #1324).
///
/// Returns [`Writability::Writable`] / [`Writability::ReadOnly`] /
/// [`Writability::Unknown`]; the probe never modifies the file and never errors
/// out for the ambiguous case (that maps to `Unknown`). This catches the
/// owner-mismatch case the cheap `FileEntry.writable` hint cannot.
#[tauri::command]
pub async fn sftp_check_writable(
    session_id: String,
    remote_path: String,
    manager: State<'_, SftpManager>,
) -> Result<Writability, TerminalError> {
    debug!(session_id, "SFTP check writable");
    let browser = manager.get_session(&session_id)?;
    browser
        .check_writable(&remote_path)
        .await
        .map_err(sftp_op_error)
}

/// Open a dedicated [`SftpTransferChannel`] off `browser` and (for downloads)
/// stat the remote size. Both are awaited directly on the async core browser —
/// no `spawn_blocking` / `block_in_place` bridging is needed. Returns the
/// dedicated channel plus the known total size (`0` = indeterminate).
async fn open_transfer_channel(
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

/// Start a download (remote → local). Registers a `transfer_id`, runs a chunked
/// copy on a dedicated SFTP channel in the background, and returns the id
/// immediately (issue #1245).
///
/// Progress and completion are reported via `transfer-progress` events; the
/// copy does not hold the session mutex, so listing / navigating the same
/// session stays live during the transfer.
#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    manager: State<'_, SftpManager>,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    debug!(session_id, remote_path, local_path, "SFTP download");
    let browser = manager.get_session(&session_id)?;
    let (dedicated, total) = open_transfer_channel(browser, Some(remote_path.clone())).await?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let file_name = file_name_of(&remote_path);
    let token = registry.register(
        &transfer_id,
        &session_id,
        TransferDirection::Download,
        &file_name,
        &remote_path,
        total,
    );
    let ctx = TransferContext {
        transfer_id: transfer_id.clone(),
        session_id,
        direction: TransferDirection::Download,
        file_name,
        path: remote_path.clone(),
        total,
    };
    let registry = (*registry).clone();
    let sink = transfer::app_progress_sink(app_handle);
    tauri::async_runtime::spawn(async move {
        transfer::run_download(
            dedicated,
            remote_path,
            local_path,
            ctx,
            token,
            registry,
            sink,
        )
        .await;
    });
    Ok(transfer_id)
}

/// Start an upload (local → remote). Registers a `transfer_id`, runs a chunked
/// copy on a dedicated SFTP channel in the background, and returns the id
/// immediately (issue #1245). Mirrors [`sftp_download`].
#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    manager: State<'_, SftpManager>,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    debug!(session_id, local_path, remote_path, "SFTP upload");
    let browser = manager.get_session(&session_id)?;
    let (dedicated, _total) = open_transfer_channel(browser, None).await?;

    // Local files are cheap to stat, so we can report a real total for uploads.
    let total = tokio::fs::metadata(&local_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let file_name = file_name_of(&remote_path);
    let token = registry.register(
        &transfer_id,
        &session_id,
        TransferDirection::Upload,
        &file_name,
        &remote_path,
        total,
    );
    let ctx = TransferContext {
        transfer_id: transfer_id.clone(),
        session_id,
        direction: TransferDirection::Upload,
        // Named for the *remote* path, not the local one, so the name always
        // agrees with the `path` this row displays (#1573). Every honest
        // upload caller builds `remote_path` as `<dir>/<basename of local>`,
        // so this is unchanged for them — but an SFTP→SFTP paste uploads from
        // a local temp copy (`/tmp/termihub-paste-<ts>-<name>`), and the
        // destination name is the one the user actually knows the file by.
        file_name,
        path: remote_path.clone(),
        total,
    };
    let registry = (*registry).clone();
    let sink = transfer::app_progress_sink(app_handle);
    tauri::async_runtime::spawn(async move {
        transfer::run_upload(
            dedicated,
            local_path,
            remote_path,
            ctx,
            token,
            registry,
            sink,
        )
        .await;
    });
    Ok(transfer_id)
}

/// Cancel an in-flight transfer by id. Unknown / already-finished ids are a
/// harmless no-op (issue #1245).
#[tauri::command]
pub fn sftp_cancel_transfer(transfer_id: String, registry: State<'_, TransferRegistry>) {
    debug!(transfer_id, "SFTP cancel transfer");
    registry.cancel(&transfer_id);
}

/// Create a directory on the remote host.
#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    path: String,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let browser = manager.get_session(&session_id)?;
    browser.mkdir(&path).await.map_err(sftp_op_error)
}

/// Delete a file or empty directory on the remote host.
///
/// `is_directory` is retained for the frontend IPC shape; the core browser's
/// `delete` self-detects a directory via `stat` and picks `rmdir`/`unlink`
/// accordingly, so the flag is advisory only.
#[tauri::command]
pub async fn sftp_delete(
    session_id: String,
    path: String,
    is_directory: bool,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let _ = is_directory;
    let browser = manager.get_session(&session_id)?;
    browser.delete(&path).await.map_err(sftp_op_error)
}

/// Rename a file or directory on the remote host.
#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    old_path: String,
    new_path: String,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let browser = manager.get_session(&session_id)?;
    browser
        .rename(&old_path, &new_path)
        .await
        .map_err(sftp_op_error)
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

/// Read a remote file's contents as a UTF-8 string via SFTP.
#[tauri::command]
pub async fn sftp_read_file_content(
    session_id: String,
    remote_path: String,
    manager: State<'_, SftpManager>,
) -> Result<String, TerminalError> {
    let browser = manager.get_session(&session_id)?;
    let data = browser
        .read_file(&remote_path)
        .await
        .map_err(sftp_op_error)?;
    String::from_utf8(data)
        .map_err(|e| TerminalError::SftpError(format!("read failed: invalid UTF-8: {e}")))
}

/// Write a string to a remote file via SFTP.
#[tauri::command]
pub async fn sftp_write_file_content(
    session_id: String,
    remote_path: String,
    content: String,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let browser = manager.get_session(&session_id)?;
    browser
        .write_file(&remote_path, content.as_bytes())
        .await
        .map_err(sftp_op_error)
}

/// Write a string to a remote file with `sudo`-elevated privileges (#1328).
///
/// Uploads the buffer to a termiHub-generated temp path via SFTP, then rewrites
/// the destination in place via `sudo -S` over the exec channel with the
/// password supplied on stdin. Returns a typed [`ElevatedWriteResult`]
/// (`success` / `incorrectPassword` / `other`) rather than erroring on an
/// authorization failure, so the caller can re-prompt. The temp file is always
/// cleaned up, and the password is never logged.
#[tauri::command]
pub async fn sftp_write_file_content_elevated(
    session_id: String,
    remote_path: String,
    content: String,
    sudo_password: String,
    manager: State<'_, SftpManager>,
) -> Result<ElevatedWriteResult, TerminalError> {
    // Do not log `sudo_password`.
    debug!(session_id, remote_path, "SFTP elevated write");
    let browser = manager.get_session(&session_id)?;
    browser
        .write_file_content_elevated(&remote_path, &content, &sudo_password)
        .await
        .map_err(sftp_op_error)
}

/// Report whether the SFTP session's SSH connection can open an exec channel
/// (i.e. run remote commands such as `sudo`).
///
/// Returns `true` for a normal SSH+shell connection and `false` for an
/// SFTP-only (`ForceCommand internal-sftp`) or relayed connection. Used by the
/// file editor to know whether privilege-elevated writes are possible.
#[tauri::command]
pub async fn sftp_has_exec_capability(
    session_id: String,
    manager: State<'_, SftpManager>,
) -> Result<bool, TerminalError> {
    let browser = manager.get_session(&session_id)?;
    // A dropped / SFTP-only connection maps to `false` (as before) rather than
    // surfacing an error to the editor.
    Ok(browser.has_exec_capability().await.unwrap_or(false))
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
///
/// The SFTP read/write go through the fully-async core browser and are awaited
/// directly. Only VS Code's blocking `--wait` is run on a `spawn_blocking` thread
/// inside the background task; the re-upload afterwards is a normal `.await` on
/// the core browser. Mirrors `monitoring_open`. See #828.
#[tauri::command]
pub async fn vscode_open_remote(
    session_id: String,
    remote_path: String,
    manager: State<'_, SftpManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), TerminalError> {
    // Clone the session browser Arc before spawning the background task.
    let browser = manager.get_session(&session_id)?;

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
