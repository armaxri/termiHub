use serde::Serialize;
use tauri::{Emitter, Manager, State};
use termihub_core::backends::ssh::parse_ssh_settings;
use tracing::{debug, info};

use crate::connection::manager::ConnectionManager;
use crate::files::sftp::{lock_session, ElevatedWriteResult, SftpManager, Writability};
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
    // The SSH handshake blocks (and uses `block_in_place` internally), so run it
    // on a blocking-pool thread rather than the Tauri command thread — calling it
    // directly aborts the process (`block_in_place` is only valid on a runtime
    // worker thread). Mirrors `monitoring_open`.
    let manager = (*manager).clone();
    tokio::task::spawn_blocking(move || manager.open_session(&config))
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
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
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || lock_session(&session)?.list_dir(&path))
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
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
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || lock_session(&session)?.realpath(&path))
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
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
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || lock_session(&session)?.check_writable(&remote_path))
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
}

/// Open a dedicated SFTP channel off `session` and (for downloads) stat the
/// remote size, on a blocking-pool thread — the SFTP calls use `block_in_place`,
/// which is invalid on the async command thread. Returns the dedicated session
/// plus the known total size (`0` = indeterminate).
async fn open_transfer_channel(
    session: std::sync::Arc<std::sync::Mutex<crate::files::sftp::SftpSession>>,
    remote_path: Option<String>,
) -> Result<(russh_sftp::client::SftpSession, u64), TerminalError> {
    tokio::task::spawn_blocking(move || {
        let session = lock_session(&session)?;
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let dedicated = session.open_dedicated_sftp().await?;
                let total = match &remote_path {
                    Some(path) => session.remote_size(path).await,
                    None => 0,
                };
                Ok::<_, TerminalError>((dedicated, total))
            })
        })
    })
    .await
    .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
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
    let session = manager.get_session(&session_id)?;
    let (dedicated, total) = open_transfer_channel(session, Some(remote_path.clone())).await?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let token = registry.register(&transfer_id);
    let ctx = TransferContext {
        transfer_id: transfer_id.clone(),
        session_id,
        direction: TransferDirection::Download,
        file_name: file_name_of(&remote_path),
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
    let session = manager.get_session(&session_id)?;
    let (dedicated, _total) = open_transfer_channel(session, None).await?;

    // Local files are cheap to stat, so we can report a real total for uploads.
    let total = tokio::fs::metadata(&local_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let token = registry.register(&transfer_id);
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
        file_name: file_name_of(&remote_path),
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
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || lock_session(&session)?.mkdir(&path))
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
}

/// Delete a file or empty directory on the remote host.
#[tauri::command]
pub async fn sftp_delete(
    session_id: String,
    path: String,
    is_directory: bool,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        let session = lock_session(&session)?;
        if is_directory {
            session.remove_dir(&path)
        } else {
            session.remove_file(&path)
        }
    })
    .await
    .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
}

/// Rename a file or directory on the remote host.
#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    old_path: String,
    new_path: String,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || lock_session(&session)?.rename(&old_path, &new_path))
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
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

/// Read a remote file's contents as a UTF-8 string via SFTP.
#[tauri::command]
pub async fn sftp_read_file_content(
    session_id: String,
    remote_path: String,
    manager: State<'_, SftpManager>,
) -> Result<String, TerminalError> {
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || lock_session(&session)?.read_file_content(&remote_path))
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
}

/// Write a string to a remote file via SFTP.
#[tauri::command]
pub async fn sftp_write_file_content(
    session_id: String,
    remote_path: String,
    content: String,
    manager: State<'_, SftpManager>,
) -> Result<(), TerminalError> {
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        lock_session(&session)?.write_file_content(&remote_path, &content)
    })
    .await
    .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
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
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        lock_session(&session)?.write_file_content_elevated(&remote_path, &content, &sudo_password)
    })
    .await
    .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
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
    let session = manager.get_session(&session_id)?;
    tokio::task::spawn_blocking(move || Ok(lock_session(&session)?.has_exec_capability()))
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
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
/// `async` + `spawn_blocking`: the SFTP read/write use `block_in_place`
/// internally, which aborts the process on the synchronous Tauri command thread
/// (and on a raw `std::thread`, which has no runtime context). Both the initial
/// download and the background wait/re-upload therefore run on `spawn_blocking`
/// threads, which carry a Tokio runtime context. Mirrors `monitoring_open`. See #828.
#[tauri::command]
pub async fn vscode_open_remote(
    session_id: String,
    remote_path: String,
    manager: State<'_, SftpManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), TerminalError> {
    // Get a clone of the session Arc before spawning the background task
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

    // Download the remote file to temp on a blocking-pool thread (the SFTP read
    // uses `block_in_place`, which is invalid on the command thread).
    {
        let session = session_arc.clone();
        let remote_path = remote_path.clone();
        let temp_path_str = temp_path_str.clone();
        tokio::task::spawn_blocking(move || {
            lock_session(&session)?.read_file(&remote_path, &temp_path_str)
        })
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))??;
    }

    // Wait for VS Code to close, then re-upload — on a blocking-pool thread so
    // the SFTP write's `block_in_place` has a runtime context (a raw
    // `std::thread` would have none and abort the process).
    tauri::async_runtime::spawn_blocking(move || {
        let result = vscode::open_in_vscode_wait(&temp_path_str);

        let event = match result {
            Ok(()) => {
                // Re-upload the edited file
                let upload_result = lock_session(&session_arc)
                    .and_then(|session| session.write_file(&temp_path_str, &remote_path));
                match upload_result {
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
                }
            }
            Err(e) => VscodeEditCompleteEvent {
                remote_path,
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
