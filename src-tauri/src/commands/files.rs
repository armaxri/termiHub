use serde::Serialize;
use tauri::{Emitter, Manager, State};
use termihub_core::backends::ssh::SftpFileBrowser;
use termihub_core::files::FileBrowser;
use tracing::debug;

use crate::files::sftp::sftp_op_error;
use crate::files::transfer::TransferRegistry;
use crate::files::FileEntry;
use crate::utils::errors::TerminalError;
use crate::utils::vscode;

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

/// Change the permission bits (chmod) of a local file or directory.
///
/// `mode` is the low 12 bits of a Unix mode (e.g. `0o755`). Unix only; other
/// platforms return a "not supported" error.
#[tauri::command]
pub fn local_set_permissions(path: String, mode: u32) -> Result<(), TerminalError> {
    crate::files::local::set_permissions(&path, mode)
}

/// Change the owner (`uid`) and/or group (`gid`) of a local file or directory.
///
/// A `null` id leaves that side unchanged. Unix only; other platforms return a
/// "not supported" error.
#[tauri::command]
pub fn local_set_owner(
    path: String,
    uid: Option<u32>,
    gid: Option<u32>,
) -> Result<(), TerminalError> {
    crate::files::local::set_owner(&path, uid, gid)
}

/// Create a symbolic link at `link_path` pointing at `target` on the local
/// filesystem. Unix only; other platforms return a "not supported" error.
#[tauri::command]
pub fn local_create_symlink(target: String, link_path: String) -> Result<(), TerminalError> {
    crate::files::local::create_symlink(&target, &link_path)
}

/// Read a local file's contents as a UTF-8 string.
#[tauri::command]
pub fn local_read_file(path: String) -> Result<String, TerminalError> {
    crate::files::local::read_file_content(&path)
}

/// Get metadata (including size) for a single local file.
///
/// Backs the editor's large-file guard (#PROD-014 / #PERF-002): the frontend
/// stats before reading so it can warn instead of freezing on a huge file.
#[tauri::command]
pub fn local_stat(path: String) -> Result<FileEntry, TerminalError> {
    crate::files::local::stat(&path)
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

// --- Native drag-out to the OS file manager (#3457) ---

/// Resolve the per-user drag-out staging root under the app cache dir.
fn drag_out_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, TerminalError> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(crate::files::drag_out::STAGING_DIR_NAME))
        .map_err(|e| TerminalError::InternalError(format!("could not resolve app cache dir: {e}")))
}

/// Create a private staging directory for a remote drag-out and return the local
/// target path for each entry (sanitized per segment: a hostile remote name can
/// never escape the directory). `entries` may describe a nested remote folder
/// tree (#3491); folders are created up front. The caller downloads each file
/// entry to its path, then starts the drag with [`drag_out_start`].
#[tauri::command]
pub fn drag_out_create_staging(
    entries: Vec<crate::files::drag_out::StagingEntry>,
    app: tauri::AppHandle,
    staging: State<'_, crate::files::drag_out::DragOutStaging>,
) -> Result<crate::files::drag_out::StagingDir, TerminalError> {
    let root = drag_out_root(&app)?;
    staging
        .create_tree(&root, &entries)
        .map_err(TerminalError::InvalidParams)
}

/// A live session's file browser as the remote side of a backend staging.
struct SessionStageSource<'a> {
    manager: &'a crate::session::manager::SessionManager,
    session_id: &'a str,
}

#[async_trait::async_trait]
impl crate::files::drag_out::StageSource for SessionStageSource<'_> {
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, String> {
        self.manager
            .list_files(self.session_id, path)
            .await
            .map_err(|e| e.to_string())
    }
    async fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        self.manager
            .read_file(self.session_id, path)
            .await
            .map_err(|e| e.to_string())
    }
}

/// Stage the dragged rows of a byte-based session (Docker / remote agent — no
/// transfer queue) for a drag-out (#3491): the backend reads each file (and,
/// within bounds, each folder recursively) through the session and writes it
/// into a fresh staging directory it owns. The webview supplies only remote
/// paths and names — never a local destination. Returns the staging dir and
/// the local path of each dragged row; on failure the dir is discarded.
#[tauri::command]
pub async fn drag_out_stage_session(
    session_id: String,
    entries: Vec<crate::files::drag_out::SessionStageEntry>,
    app: tauri::AppHandle,
    manager: State<'_, crate::session::manager::SessionManager>,
    staging: State<'_, crate::files::drag_out::DragOutStaging>,
) -> Result<crate::files::drag_out::StagingDir, TerminalError> {
    debug!(
        session_id,
        count = entries.len(),
        "Staging session drag-out"
    );
    let root = drag_out_root(&app)?;
    let dir = staging
        .create_dir(&root)
        .map_err(TerminalError::InternalError)?;
    let source = SessionStageSource {
        manager: &manager,
        session_id: &session_id,
    };
    match crate::files::drag_out::stage_from_source(
        &source,
        &dir,
        &entries,
        crate::files::drag_out::StageLimits::default(),
    )
    .await
    {
        Ok(paths) => Ok(crate::files::drag_out::StagingDir {
            dir: dir.to_string_lossy().into_owned(),
            paths: paths
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
        }),
        Err(e) => {
            if let Err(discard) = staging.discard(&dir) {
                debug!("Could not discard failed session staging: {discard}");
            }
            Err(TerminalError::InternalError(e))
        }
    }
}

/// Delete a staging directory created by [`drag_out_create_staging`]. Paths this
/// process did not create are refused.
#[tauri::command]
pub fn drag_out_discard_staging(
    dir: String,
    staging: State<'_, crate::files::drag_out::DragOutStaging>,
) -> Result<(), TerminalError> {
    staging
        .discard(std::path::Path::new(&dir))
        .map_err(TerminalError::InvalidParams)
}

/// Start a native OS drag of existing local `paths` out of the calling window
/// and resolve with how it ended (`dropped` / `cancelled`). Only file paths are
/// accepted — never arbitrary pasteboard data — and each must be an existing
/// absolute path.
#[tauri::command]
pub async fn drag_out_start(
    paths: Vec<String>,
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<crate::files::drag_out::DragOutResult, TerminalError> {
    let paths = crate::files::drag_out::validate_drag_paths(&paths)
        .map_err(TerminalError::InvalidParams)?;
    debug!(count = paths.len(), "Starting native drag-out");
    let (start_tx, start_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    // The drop callback is `Fn`, so hand the one-shot sender out exactly once.
    let done_tx = std::sync::Mutex::new(Some(done_tx));
    app.run_on_main_thread(move || {
        let started = crate::files::drag_out::start_native_drag(&window, paths, move |result| {
            if let Some(tx) = done_tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(result);
            }
        });
        let _ = start_tx.send(started);
    })
    .map_err(|e| TerminalError::InternalError(format!("could not reach the main thread: {e}")))?;
    start_rx
        .await
        .map_err(|_| TerminalError::InternalError("drag-out start was dropped".to_string()))?
        .map_err(|e| TerminalError::InternalError(format!("could not start drag: {e}")))?;
    done_rx
        .await
        .map_err(|_| TerminalError::InternalError("drag-out ended without a result".to_string()))
}
