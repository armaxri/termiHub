//! Type-agnostic session commands using the unified [`ConnectionType`] trait.
//!
//! Replaces the old `terminal.rs` commands with a single `create_connection`
//! entry point and uniform I/O commands. File browsing and monitoring are
//! accessed through the session's connection capabilities.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tracing::{debug, info};

use termihub_core::connection::ConnectionTypeInfo;
use termihub_core::files::FileEntry;

use crate::commands::files::open_transfer_channel;
use crate::connection::manager::ConnectionManager;
use crate::files::sftp::{ElevatedWriteResult, Writability};
use crate::files::transfer::{self, TransferContext, TransferDirection, TransferRegistry};
use crate::session::line_ending::LineEnding;
use crate::session::manager::{
    PersistentSessionSummary, SessionInfo, SessionLogStatus, SessionManager,
};
use crate::system_monitor_projection::projection::fold_monitor_transition;
use crate::utils::errors::TerminalError;
use crate::utils::fs::file_name_of;
use crate::utils::shell_detect;
use crate::window::WindowManager;

/// Create a new connection session.
///
/// For local connections, pass `type_id` (e.g., "local", "ssh", "serial")
/// and `settings` (JSON matching the type's settings schema). For remote
/// (agent-mediated) connections, also pass `agent_id`.
///
/// `spawned` marks the session as opened via the CLI/context-menu spawn path
/// (#1446, #1466) — a container with no saved connection id. It is recorded on
/// the backend session so the Open Connections panel groups it under "Spawned
/// Containers" from this authoritative marker, which survives the tab close that
/// would otherwise strip the frontend-only `spawned` tab flag. Defaults to
/// `false` when the frontend omits it (normal local/agent connections).
// Tauri command: the argument list is the IPC surface (typed params + injected
// State), so it cannot be collapsed into a struct without losing the command
// binding — the arity lint does not apply here.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_connection(
    type_id: String,
    mut settings: Value,
    agent_id: Option<String>,
    connect_id: Option<String>,
    spawned: Option<bool>,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
    conn_manager: State<'_, ConnectionManager>,
) -> Result<String, TerminalError> {
    info!(type_id, agent_id = ?agent_id, spawned = ?spawned, "Creating connection");
    // Expand any saved-connection jump-host references to inline hops before the
    // settings reach core (which only connects with inline hops) — #940.
    conn_manager
        .resolve_jump_host_refs(&mut settings, None)
        .map_err(|e| TerminalError::ConnectionFailed(e.to_string()))?;
    manager
        .create_connection(
            &type_id,
            settings,
            agent_id.as_deref(),
            connect_id.as_deref(),
            spawned.unwrap_or(false),
            app_handle,
        )
        .await
}

/// Cancel an in-flight (still connecting) session by its `connect_id`.
///
/// Fires the cancellation token registered by [`create_connection`] so a Stop /
/// tab-close while a session is connecting aborts the handshake promptly instead
/// of waiting out the connect timeout (#952). No-op if the connect already
/// finished. Returns whether a connecting session was found.
#[tauri::command]
pub fn cancel_connecting(
    connect_id: String,
    manager: State<'_, SessionManager>,
) -> Result<bool, TerminalError> {
    info!(connect_id, "Cancelling connecting session");
    Ok(manager.cancel_connecting(&connect_id))
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

/// Set the line ending applied to a session's interactive input (Enter / paste).
///
/// `line_ending` is `"cr"`, `"lf"`, or `"crlf"`; unknown values fall back to LF.
#[tauri::command]
pub async fn set_session_line_ending(
    session_id: String,
    line_ending: String,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    debug!(session_id, line_ending, "Setting session line ending");
    manager
        .set_session_line_ending(&session_id, LineEnding::from_opt_str(Some(&line_ending)))
        .await;
    Ok(())
}

/// Resize a session's terminal.
///
/// Multi-window resize ownership (#1900): a PTY has exactly one size, so only the
/// window currently displaying a session may drive its resize. An **unclaimed**
/// session (the single-window case, or before any move) resizes from any window;
/// once a session is owned, a resize from a non-owning window is ignored so two
/// windows never race the backend size.
#[tauri::command]
pub async fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    window: tauri::WebviewWindow,
    manager: State<'_, SessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<(), TerminalError> {
    if !window_manager.may_resize(&session_id, window.label()) {
        debug!(
            session_id,
            window = window.label(),
            "Ignoring resize from non-owning window (#1900)"
        );
        return Ok(());
    }
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

/// List all active local sessions.
#[tauri::command]
pub async fn list_local_sessions(
    manager: State<'_, SessionManager>,
) -> Result<Vec<SessionInfo>, String> {
    Ok(manager.list_sessions().await)
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

/// List available serial ports, respecting the user-configured prefix set.
///
/// When no prefix list has been saved, all built-in prefixes are used.
#[tauri::command]
pub fn list_serial_ports(conn_manager: State<'_, ConnectionManager>) -> Vec<String> {
    let settings = conn_manager.get_settings();
    match &settings.serial_port_scan_prefixes {
        Some(prefixes) => {
            let enabled: Vec<&str> = prefixes
                .iter()
                .filter(|p| p.enabled)
                .map(|p| p.prefix.as_str())
                .collect();
            termihub_core::session::serial::list_serial_ports_with_enabled_prefixes(&enabled)
        }
        None => termihub_core::session::serial::list_serial_ports(),
    }
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

/// Whether an SSH private key file is passphrase-encrypted (#885).
///
/// Lets the connect paths decide whether to prompt for a key passphrase based
/// on the key's actual encryption instead of the "Save password" flag. On any
/// read error the caller should treat the result as "uncertain" and prompt.
#[tauri::command]
pub async fn is_ssh_key_encrypted(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::utils::ssh_key_validate::is_ssh_key_encrypted(&path)
    })
    .await
    .map_err(|e| format!("Encryption-detection task failed: {e}"))?
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

/// Get metadata for a single file via a session's file browser capability.
///
/// Backs the editor's remote external-change detection (#1627): the frontend
/// re-stats the open file on an interval and compares `modified`/`size`.
#[tauri::command]
pub async fn session_stat(
    session_id: String,
    path: String,
    manager: State<'_, SessionManager>,
) -> Result<FileEntry, TerminalError> {
    debug!(session_id, path, "Session file stat");
    manager.stat_file(&session_id, &path).await
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

// --- Session-scoped SFTP advanced operations & transfers (#2312) ---
//
// Session-path mirrors of the standalone `sftp_*` commands, routed through the
// session's `ConnectionType` file browser rather than a separate `SftpManager`
// session. They only succeed for an SFTP-backed (SSH) session; other backends
// return a "not supported" error. Part of the #2307 convergence (step A):
// additive, so the standalone `sftp_*` path keeps working unchanged.

/// Resolve a remote path to its canonical absolute form via a session's SFTP
/// realpath.
///
/// Passing `"."` yields the session's home directory, avoiding a `/home/<user>`
/// guess (mirror of `sftp_realpath`, #2312).
#[tauri::command]
pub async fn session_realpath(
    session_id: String,
    path: String,
    manager: State<'_, SessionManager>,
) -> Result<String, TerminalError> {
    debug!(session_id, path, "Session SFTP realpath");
    manager.session_realpath(&session_id, &path).await
}

/// Authoritatively check whether a remote file is writable by the connecting
/// user, via a non-destructive SFTP write-open probe on a session (mirror of
/// `sftp_check_writable`, #2312).
#[tauri::command]
pub async fn session_check_writable(
    session_id: String,
    remote_path: String,
    manager: State<'_, SessionManager>,
) -> Result<Writability, TerminalError> {
    debug!(session_id, "Session SFTP check writable");
    manager
        .session_check_writable(&session_id, &remote_path)
        .await
}

/// Write a string to a remote file with `sudo`-elevated privileges over a
/// session's SFTP connection.
///
/// Returns a typed [`ElevatedWriteResult`] (`success` / `incorrectPassword` /
/// `other`) rather than erroring on an authorization failure, so the caller can
/// re-prompt. The temp upload is always cleaned up and the password is never
/// logged (mirror of `sftp_write_file_content_elevated`, #2312).
#[tauri::command]
pub async fn session_write_file_elevated(
    session_id: String,
    remote_path: String,
    content: String,
    sudo_password: String,
    manager: State<'_, SessionManager>,
) -> Result<ElevatedWriteResult, TerminalError> {
    // Do not log `sudo_password`.
    debug!(session_id, remote_path, "Session SFTP elevated write");
    manager
        .session_write_file_elevated(&session_id, &remote_path, &content, &sudo_password)
        .await
}

/// Report whether a session's SFTP connection can open an exec channel (i.e. run
/// remote commands such as `sudo`).
///
/// Returns `true` for a normal SSH+shell connection and `false` for an
/// SFTP-only / relayed connection, letting the editor know whether elevated
/// writes are possible (mirror of `sftp_has_exec_capability`, #2312).
#[tauri::command]
pub async fn session_has_exec_capability(
    session_id: String,
    manager: State<'_, SessionManager>,
) -> Result<bool, TerminalError> {
    manager.session_has_exec_capability(&session_id).await
}

/// Start a download (remote → local) over a session's SFTP connection.
///
/// Registers a `transfer_id`, runs a chunked copy on a **dedicated** SFTP
/// channel in the background, and returns the id immediately — the copy does not
/// hold the session lock, so listing / navigating the same session stays live
/// during the transfer (#1245). Progress and completion are reported via
/// `transfer-progress` events (mirror of `sftp_download`, #2312).
#[tauri::command]
pub async fn session_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    manager: State<'_, SessionManager>,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    debug!(session_id, remote_path, local_path, "Session SFTP download");
    let browser = manager.sftp_transfer_browser(&session_id).await?;
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

/// Start an upload (local → remote) over a session's SFTP connection.
///
/// Registers a `transfer_id`, runs a chunked copy on a dedicated SFTP channel in
/// the background, and returns the id immediately (#1245). Mirrors
/// [`session_download`] and the standalone `sftp_upload` (#2312).
#[tauri::command]
pub async fn session_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    manager: State<'_, SessionManager>,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    debug!(session_id, local_path, remote_path, "Session SFTP upload");
    let browser = manager.sftp_transfer_browser(&session_id).await?;
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

/// Open a remote file in VS Code over a session's SFTP connection: download,
/// open with `--wait`, re-upload on close.
///
/// Session-path mirror of the standalone `vscode_open_remote` — the one
/// `sftp_*`-only command #2312 left without a session equivalent — so an SSH tab
/// can edit a remote file in VS Code straight from its `ConnectionType` session,
/// with no separate `SftpManager` session. Resolves the owned
/// `Arc<SftpFileBrowser>` from the session path and reuses the exact shared
/// download → edit → re-upload flow. Only succeeds for an SFTP-backed session;
/// other backends return a "not supported" error. Completes the step-A backend
/// parity of the #2307 convergence.
#[tauri::command]
pub async fn session_vscode_open_remote(
    session_id: String,
    remote_path: String,
    manager: State<'_, SessionManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), TerminalError> {
    debug!(session_id, remote_path, "Session SFTP open in VS Code");
    let browser = manager.sftp_transfer_browser(&session_id).await?;
    crate::commands::files::open_remote_in_vscode(browser, remote_path, app_handle).await
}

// --- Session-based monitoring commands ---

/// Capabilities of an active session exposed to the frontend.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCapabilities {
    pub monitoring: bool,
    pub file_browser: bool,
}

/// Return the capabilities of an active session.
#[tauri::command]
pub async fn session_get_capabilities(
    session_id: String,
    manager: State<'_, SessionManager>,
) -> Result<SessionCapabilities, TerminalError> {
    let caps = manager
        .session_capabilities(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()))?;
    Ok(SessionCapabilities {
        monitoring: caps.monitoring,
        file_browser: caps.file_browser,
    })
}

/// Start session-based monitoring, pushing stats as `session-monitoring-stats` events.
///
/// `interval_ms` sets the collection cadence for this monitor; when omitted the
/// provider's default interval is used (#1233).
#[tauri::command]
pub async fn session_monitoring_open(
    session_id: String,
    interval_ms: Option<u64>,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    info!(session_id, interval_ms = ?interval_ms, "Starting session monitoring");
    // Server-authority fold (#2376): reflect the connect outcome into the shared
    // `SystemMonitorStore` at the source. Additive — the client `monitor.opened`
    // / `monitor.openFailed` mirror stays in place, so no user-facing change. The
    // entry itself is created client-side (`monitor.open`, which carries the UI
    // `host` label the command does not have); making the server own entry
    // creation is the remaining #2224 inversion step.
    match manager
        .start_session_monitoring(&session_id, interval_ms, app_handle.clone())
        .await
    {
        Ok(()) => {
            fold_monitor_transition(&app_handle, |store| store.opened(&session_id));
            Ok(())
        }
        Err(e) => {
            fold_monitor_transition(&app_handle, |store| {
                store.open_failed(&session_id, Some(e.to_string()));
            });
            Err(e)
        }
    }
}

/// Stop session-based monitoring.
#[tauri::command]
pub async fn session_monitoring_close(
    session_id: String,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    info!(session_id, "Stopping session monitoring");
    let result = manager.stop_session_monitoring(&session_id).await;
    // Server-authority fold (#2376): drop the entry from the shared store at the
    // source (retaining the stats cache, as the store's `close` does). Additive —
    // the client `monitor.close` mirror stays in place.
    fold_monitor_transition(&app_handle, |store| store.close(&session_id));
    result
}

/// Pause or resume a session monitor's collection loop (#1233).
#[tauri::command]
pub async fn session_monitoring_set_paused(
    session_id: String,
    paused: bool,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    info!(session_id, paused, "Setting session monitoring paused");
    manager
        .set_session_monitoring_paused(&session_id, paused)
        .await?;
    // Server-authority fold (#2376): mirror the pause/resume into the shared store
    // at the source (additive; the collector loop also emits the authoritative
    // `Paused`/`Live` status, folded by the push task).
    fold_monitor_transition(&app_handle, |store| store.set_paused(&session_id, paused));
    Ok(())
}

/// Change a session monitor's refresh interval (#1233).
#[tauri::command]
pub async fn session_monitoring_set_interval(
    session_id: String,
    interval_ms: u64,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    info!(
        session_id,
        interval_ms, "Setting session monitoring interval"
    );
    manager
        .set_session_monitoring_interval(&session_id, interval_ms)
        .await?;
    // Server-authority fold (#2376): mirror the new cadence into the shared store
    // at the source (additive).
    fold_monitor_transition(&app_handle, |store| {
        store.set_interval(&session_id, interval_ms)
    });
    Ok(())
}

/// Cancel a session monitor's in-flight connect / collect (#1233).
#[tauri::command]
pub async fn session_monitoring_cancel(
    session_id: String,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    info!(session_id, "Cancelling session monitoring connect");
    let result = manager.cancel_session_monitoring(&session_id).await;
    // Server-authority fold (#2376): a cancel tears the monitor down (the frontend
    // `cancelMonitoring` disconnects), so drop the entry from the shared store at
    // the source. Additive — the client teardown's `monitor.close` mirror stays.
    fold_monitor_transition(&app_handle, |store| store.close(&session_id));
    result
}

// --- Session output logging commands (#1960) ---

/// Start writing a session's output to a file.
///
/// `path` is the destination; when omitted a default
/// `<connection>-<timestamp>.log` under the platform log directory's `sessions`
/// subfolder is used. `timestamps` prefixes each line with a wall-clock stamp.
/// Returns the resolved transcript path.
#[tauri::command]
pub async fn session_logging_start(
    session_id: String,
    path: Option<String>,
    timestamps: Option<bool>,
    manager: State<'_, SessionManager>,
) -> Result<String, TerminalError> {
    info!(session_id, timestamps = ?timestamps, "Starting session logging");
    let resolved = manager
        .start_session_logging(
            &session_id,
            path.map(std::path::PathBuf::from),
            timestamps.unwrap_or(false),
        )
        .await?;
    Ok(resolved.to_string_lossy().into_owned())
}

/// Stop writing a session's output to a file.
///
/// Returns the transcript path if logging was active, else `null`.
#[tauri::command]
pub fn session_logging_stop(
    session_id: String,
    manager: State<'_, SessionManager>,
) -> Option<String> {
    info!(session_id, "Stopping session logging");
    manager
        .stop_session_logging(&session_id)
        .map(|p| p.to_string_lossy().into_owned())
}

/// Current logging status for a session, or `null` when not logging.
#[tauri::command]
pub fn session_logging_status(
    session_id: String,
    manager: State<'_, SessionManager>,
) -> Option<SessionLogStatus> {
    manager.session_logging_status(&session_id)
}

// --- Persistent session commands ---

/// Start a persistent session for a saved connection.
///
/// Creates the backend process and registers it in the persistent session
/// registry. Returns the new session ID. Idempotent: if the connection is
/// already running, the existing session ID is returned.
#[tauri::command]
pub async fn start_persistent_session(
    connection_id: String,
    type_id: String,
    mut settings: Value,
    agent_id: Option<String>,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
    conn_manager: State<'_, ConnectionManager>,
) -> Result<String, TerminalError> {
    info!(connection_id, type_id, agent_id = ?agent_id, "Starting persistent session");
    // Expand saved-connection jump-host references to inline hops before core
    // sees them; seed the visited set with this connection so a hop that
    // references itself is rejected as circular (#940).
    conn_manager
        .resolve_jump_host_refs(&mut settings, Some(&connection_id))
        .map_err(|e| TerminalError::ConnectionFailed(e.to_string()))?;
    manager
        .start_persistent_session(
            &connection_id,
            &type_id,
            settings,
            agent_id.as_deref(),
            app_handle,
        )
        .await
}

/// Adopt an already-running agent session into the persistent registry.
///
/// Use when the frontend discovers a surviving agent session (e.g. via the
/// sidebar's Active Sessions list) and wants to re-attach to it with
/// scrollback replay. The agent's session is linked to the desktop's
/// `connectionId` without spawning a new backend session.
#[tauri::command]
pub async fn adopt_persistent_session(
    connection_id: String,
    agent_id: String,
    agent_session_id: String,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<String, TerminalError> {
    info!(
        connection_id,
        agent_id, agent_session_id, "Adopting persistent session"
    );
    manager
        .adopt_persistent_session(&connection_id, &agent_id, &agent_session_id, app_handle)
        .await
}

/// Stop a persistent session for a saved connection.
///
/// Closes the backend process and removes the persistent registry entry.
/// All attached tabs receive the `terminal-exit` event and transition to
/// the disconnected state. No-op if the session is not registered.
#[tauri::command]
pub async fn stop_persistent_session(
    connection_id: String,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<(), TerminalError> {
    info!(connection_id, "Stopping persistent session");
    manager
        .stop_persistent_session(&connection_id, app_handle)
        .await
}

/// Register `tab_id` as attached to the persistent session for `connection_id`.
///
/// Returns an error if the session is no longer alive (the frontend should
/// transition the connection state to `error` and let the user restart).
#[tauri::command]
pub async fn attach_persistent_tab(
    connection_id: String,
    tab_id: String,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<u32, TerminalError> {
    debug!(connection_id, tab_id, "Attaching tab to persistent session");
    manager
        .attach_persistent_tab(&connection_id, &tab_id, app_handle)
        .await
}

/// Unregister `tab_id` from its persistent session, keeping the backend process alive.
///
/// The caller must pass `session_id` (not `connection_id`) so the backend can
/// locate the record without requiring a full connection lookup.
#[tauri::command]
pub async fn detach_persistent_tab(
    session_id: String,
    tab_id: String,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<u32, TerminalError> {
    debug!(session_id, tab_id, "Detaching tab from persistent session");
    manager
        .detach_persistent_tab(&session_id, &tab_id, app_handle)
        .await
}

/// Return a snapshot of all registered persistent sessions.
#[tauri::command]
pub async fn list_persistent_sessions(
    manager: State<'_, SessionManager>,
) -> Result<Vec<PersistentSessionSummary>, TerminalError> {
    Ok(manager.list_persistent_sessions().await)
}

/// Fetch the scrollback buffer from the agent for a persistent session.
///
/// Sends a `session.getBuffer` request to the agent, which queries the daemon's
/// ring buffer non-destructively and returns a base64-encoded snapshot.
/// The caller (frontend xterm) writes the decoded bytes directly.
#[tauri::command]
pub async fn get_agent_session_buffer(
    session_id: String,
    manager: State<'_, SessionManager>,
) -> Result<Vec<u8>, String> {
    manager
        .get_remote_session_buffer(&session_id)
        .await
        .map_err(|e| e.to_string())
}
