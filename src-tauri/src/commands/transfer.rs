//! Generic transfer-queue commands (issue #1336).
//!
//! These control the shared [`TransferRegistry`] queue model and are named
//! generically (`transfer_*`) so SFTP can migrate onto the same queue later.
//! `ftp_download` / `ftp_upload` register FTP transfers; the FTP data plane is
//! feature-gated behind `ftp` (the commands are always present so the IPC
//! surface is stable, but return an error when the feature is off).

use tauri::{Manager, State};
use tracing::debug;

use crate::files::transfer::persist::{
    FolderPasteEndpoint, FolderPasteOperation, PersistedAgentTarget, PersistedFolderPaste,
};
use crate::files::transfer::remote_copy::RemoteCopyEndpoint;
use crate::files::transfer::{TransferPersistenceManager, TransferRegistry, TransferSnapshot};
use crate::session::manager::SessionManager;
use crate::utils::errors::TerminalError;
#[cfg(feature = "ftp")]
use crate::utils::fs::file_name_of;

/// Pause an in-flight transfer.
///
/// Returns `true` when the transfer accepted the pause (a live *rich* transfer —
/// FTP *and*, since PROD-0012, SFTP), and `false` when it was a no-op: an
/// unknown/finished id, or a transfer on a non-streaming path that cannot pause
/// (Docker/FTP-listing/agent byte-based copies). The frontend uses this to give
/// honest feedback instead of a blanket success toast (#1336; audit
/// FEC-004 / UX-016).
#[tauri::command]
pub fn transfer_pause(
    transfer_id: String,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> bool {
    debug!(transfer_id, "transfer pause");
    // A row the user pauses never resumes on its own (#3883).
    if let Some(persist) = app_handle.try_state::<TransferPersistenceManager>() {
        persist.credential_waits().forget(&transfer_id);
    }
    registry.pause(&transfer_id)
}

/// Resume a paused transfer. Returns `true` when the transfer accepted the
/// resume, `false` on a no-op (see [`transfer_pause`]).
///
/// Handles **both** kinds of paused row (#3199):
///
/// - A **live** in-memory paused transfer — the registry still holds its handle,
///   so this just signals it to continue.
/// - A **rehydrated** paused row persisted by a previous run (PROD-0011) — it has
///   no live handle, session, or credentials, so this **relaunches** it:
///   re-attaches the session from the stored reference (re-sourcing credentials
///   from the live session at resume time — never from the persisted queue),
///   re-spawns the executor from the stored resume offset, and re-enters the
///   scheduler. A session that cannot be re-attached moves the row to a clear
///   Failed state rather than hanging.
#[tauri::command]
pub async fn transfer_resume(
    transfer_id: String,
    registry: State<'_, TransferRegistry>,
    manager: State<'_, SessionManager>,
    app_handle: tauri::AppHandle,
) -> Result<bool, TerminalError> {
    debug!(transfer_id, "transfer resume");
    Ok(crate::files::transfer::relaunch::resume_or_relaunch(
        &transfer_id,
        registry.inner(),
        manager.inner(),
        &app_handle,
    )
    .await)
}

/// Cancel a transfer (queued, active, or paused). Works for every queued
/// transfer, and for a **rehydrated** paused row from a previous run too
/// (#3613): with no live handle its persisted record is pruned and the row moves
/// to Cancelled — and a file of a local folder copy cancels the rest of its
/// folder, as it does before a restart. Returns `true` when something was
/// cancelled, `false` for an unknown/already-finished id.
#[tauri::command]
pub fn transfer_cancel(
    transfer_id: String,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> bool {
    debug!(transfer_id, "transfer cancel");
    registry.cancel(&transfer_id)
        || crate::files::transfer::relaunch::cancel_rehydrated(
            &transfer_id,
            registry.inner(),
            &app_handle,
        )
}

/// Manually retry a failed transfer (resets its attempt counter). Returns
/// `true` when the transfer accepted the retry, `false` on a no-op (see
/// [`transfer_pause`]).
///
/// Like [`transfer_resume`], this handles a **rehydrated** row too (#3199): a
/// failed rehydrated transfer with no live handle is relaunched from its stored
/// checkpoint (re-attaching the session and re-sourcing credentials at resume
/// time) rather than being a silent no-op.
#[tauri::command]
pub async fn transfer_retry(
    transfer_id: String,
    registry: State<'_, TransferRegistry>,
    manager: State<'_, SessionManager>,
    app_handle: tauri::AppHandle,
) -> Result<bool, TerminalError> {
    debug!(transfer_id, "transfer retry");
    Ok(crate::files::transfer::relaunch::resume_or_relaunch(
        &transfer_id,
        registry.inner(),
        manager.inner(),
        &app_handle,
    )
    .await)
}

/// Resolve a session to the end of a remote-to-remote copy it can be: SFTP
/// first, then Docker, then an agent-hosted session that passes the ranged
/// probe (#4115). A session that is none of them (FTP, an agent without
/// `fileRanges`, or an unknown session) surfaces the SFTP "not supported"
/// error, so the caller keeps the byte-based fallback.
async fn resolve_copy_endpoint(
    manager: &SessionManager,
    session_id: &str,
) -> Result<CopyEnd, TerminalError> {
    let sftp_err = match manager.sftp_transfer_browser(session_id).await {
        Ok(browser) => return Ok(CopyEnd::plain(RemoteCopyEndpoint::Sftp(browser))),
        Err(e) => e,
    };
    if let Ok(target) = manager.docker_transfer_target(session_id).await {
        return Ok(CopyEnd::plain(RemoteCopyEndpoint::Docker(target)));
    }
    match manager.ranged_transfer_target(session_id).await {
        Ok(proxy) => Ok(CopyEnd {
            agent: Some(proxy.agent_session_identity().to_persisted()),
            endpoint: RemoteCopyEndpoint::Ranged(proxy),
        }),
        Err(_) => Err(sftp_err),
    }
}

/// A resolved end of a remote-to-remote copy, with the identity of the
/// agent-hosted session behind a ranged end (#4115) — what the persisted
/// record keeps so a relaunch finds that session again.
struct CopyEnd {
    endpoint: RemoteCopyEndpoint,
    agent: Option<PersistedAgentTarget>,
}

impl CopyEnd {
    fn plain(endpoint: RemoteCopyEndpoint) -> Self {
        Self {
            endpoint,
            agent: None,
        }
    }
}

/// Report whether a session can be either end of a streamed remote-to-remote
/// copy ([`session_copy_remote`]): `true` for an SFTP- or Docker-backed
/// session and for an agent-hosted session whose agent serves ranged slices
/// (#4115), `false` otherwise (FTP, agents without `fileRanges`, unknown
/// sessions), which keep the frontend's byte-based read/write fallback (#3586).
#[tauri::command]
pub async fn session_supports_remote_copy(
    session_id: String,
    manager: State<'_, SessionManager>,
) -> Result<bool, TerminalError> {
    Ok(resolve_copy_endpoint(&manager, &session_id).await.is_ok())
}

/// Copy a file directly from one session to another, streaming the bytes
/// **through the desktop with no local staging file** (product feature
/// PROD-0013; Docker ends since #3586).
///
/// Enqueues ONE rich transfer that reads from `src_session` and writes to
/// `dst_session` — each an SFTP session (a dedicated channel per attempt), a
/// Docker session (a streaming `docker exec` per attempt) or an agent-hosted
/// session moved in 256 KiB ranged slices (#4115) — so a remote→remote
/// paste surfaces as a single Transfer Queue row instead of a whole-file
/// in-memory round trip. Pause/resume, auto-retry and byte-verified offset
/// resume all work; progress is measured on the write side and cancel removes
/// the partial destination.
///
/// Both endpoints are resolved (and validated) up front, so an unsupported /
/// unreachable endpoint errors here rather than silently on the queue. The row
/// is registered under `dst_session` (where the file lands); its name/path come
/// from the destination remote path (#1531/#1573). FTP ends are not supported
/// (see [`session_supports_remote_copy`]).
#[tauri::command]
pub async fn session_copy_remote(
    src_session: String,
    src_path: String,
    dst_session: String,
    dst_path: String,
    manager: State<'_, SessionManager>,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    use crate::files::transfer::{self, TransferDirection};

    debug!(
        src_session,
        src_path, dst_session, dst_path, "Session remote-to-remote copy"
    );
    let src = resolve_copy_endpoint(&manager, &src_session).await?;
    let dst = resolve_copy_endpoint(&manager, &dst_session).await?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    // Named/pathed for the *destination* (where the file lands), mirroring the
    // upload half of the retired temp-file dance (#1573).
    let file_name = crate::utils::fs::file_name_of(&dst_path);
    let handle = registry.enqueue(
        &transfer_id,
        &dst_session,
        TransferDirection::Upload,
        &file_name,
        &dst_path,
        0,
    );
    if let Some(pm) = app_handle.try_state::<TransferPersistenceManager>() {
        record_remote_copy(
            &pm,
            &manager,
            &transfer_id,
            (&src_session, &src_path, &src),
            (&dst_session, &dst_path, &dst),
            &file_name,
        );
    }
    let registry = (*registry).clone();
    let sink = transfer::app_progress_sink(app_handle);
    tauri::async_runtime::spawn(async move {
        transfer::remote_copy::run_remote_copy(
            src.endpoint,
            dst.endpoint,
            src_path,
            dst_path,
            handle,
            registry,
            sink,
            transfer::remote_copy::DEFAULT_RESUME_MODE,
            0,
        )
        .await;
    });
    Ok(transfer_id)
}

/// Persist a remote-to-remote copy for the durable queue (PROD-0011): metadata
/// only (references and paths, never credentials), so a restart rehydrates it
/// as paused. It has no local endpoint, so `local_path` is None; its source
/// session reference + path are kept so it can relaunch (#3206), with the saved
/// connections behind SFTP ends (#3876), the container ids of Docker ends
/// (#3586) and the session identities of agent-hosted ends (#4115), so each
/// end re-attaches the way it connected.
fn record_remote_copy(
    pm: &TransferPersistenceManager,
    manager: &SessionManager,
    transfer_id: &str,
    (src_session, src_path, src): (&str, &str, &CopyEnd),
    (dst_session, dst_path, dst): (&str, &str, &CopyEnd),
    file_name: &str,
) {
    use crate::files::transfer::TransferDirection;
    pm.record_registration(
        transfer_id,
        dst_session,
        TransferDirection::Upload,
        file_name,
        dst_path,
        None,
        0,
    );
    pm.record_remote_source(
        transfer_id,
        src_session,
        src_path,
        manager.saved_connection_of(src_session).as_deref(),
    );
    if let RemoteCopyEndpoint::Docker(target) = &src.endpoint {
        pm.record_remote_source_container(transfer_id, target.container_id());
    }
    if let Some(agent) = &src.agent {
        pm.record_remote_source_agent(transfer_id, agent.clone());
    }
    match (&dst.endpoint, &dst.agent) {
        (RemoteCopyEndpoint::Docker(target), _) => {
            pm.record_docker_target(transfer_id, target.container_id());
        }
        (_, Some(agent)) => pm.record_agent_target(transfer_id, agent.clone()),
        _ => {
            crate::files::transfer::relaunch_session::record_saved_connection(
                pm,
                manager,
                transfer_id,
                dst_session,
            );
        }
    }
}

// --- Folder-paste manifests (#3630) ---

/// Record a folder paste the frontend is about to drive file by file and return
/// its manifest id (#3630). The frontend ends it with [`folder_paste_end`] once
/// every file landed; a manifest still recorded at the next launch marks a
/// folder that may be only partly copied. Metadata only — never credentials.
/// Without durable persistence this run, an id is still returned (nothing is
/// recorded).
#[tauri::command]
pub fn folder_paste_begin(
    operation: FolderPasteOperation,
    source: FolderPasteEndpoint,
    destination: FolderPasteEndpoint,
    app_handle: tauri::AppHandle,
) -> String {
    debug!(
        ?operation,
        src = source.path,
        dest = destination.path,
        "folder paste begin"
    );
    match app_handle.try_state::<TransferPersistenceManager>() {
        Some(pm) => pm.begin_folder_paste(operation, source, destination),
        None => uuid::Uuid::new_v4().to_string(),
    }
}

/// Remove a folder-paste manifest: the folder fully landed, or the user
/// dismissed the interrupted-paste notice (#3630). Idempotent.
#[tauri::command]
pub fn folder_paste_end(paste_id: String, app_handle: tauri::AppHandle) {
    debug!(paste_id, "folder paste end");
    if let Some(pm) = app_handle.try_state::<TransferPersistenceManager>() {
        pm.end_folder_paste(&paste_id);
    }
}

/// Link a registered session transfer to the folder paste it copies a file
/// for (#3643). A restart mid-paste then reports that file through the paste's
/// notice (whose Retry re-copies it) instead of as an orphan paused row.
/// Best-effort: a no-op without persistence or for an unknown transfer.
#[tauri::command]
pub fn folder_paste_link_transfer(
    paste_id: String,
    transfer_id: String,
    app_handle: tauri::AppHandle,
) {
    debug!(paste_id, transfer_id, "folder paste link transfer");
    if let Some(pm) = app_handle.try_state::<TransferPersistenceManager>() {
        pm.record_folder_paste(&transfer_id, &paste_id);
    }
}

/// Take the folder pastes a previous run left unfinished (#3630). Each is
/// returned exactly once (its record is removed), so only one window shows the
/// notice and a Retry records a paste of its own.
#[tauri::command]
pub fn folder_paste_take_interrupted(app_handle: tauri::AppHandle) -> Vec<PersistedFolderPaste> {
    app_handle
        .try_state::<TransferPersistenceManager>()
        .map(|pm| pm.take_interrupted_folder_pastes())
        .unwrap_or_default()
}

/// List the rich (queued) transfers, optionally filtered by session.
#[tauri::command]
pub fn transfer_list(
    session_id: Option<String>,
    registry: State<'_, TransferRegistry>,
) -> Vec<TransferSnapshot> {
    registry.list(session_id.as_deref())
}

/// Record the saved connection behind an FTP transfer's session (#3876), so a
/// relaunch after a restart can re-source its password from the store.
#[cfg(feature = "ftp")]
fn record_ftp_saved_connection(
    pm: &TransferPersistenceManager,
    app_handle: &tauri::AppHandle,
    transfer_id: &str,
    session_id: &str,
) {
    if let Some(manager) = app_handle.try_state::<SessionManager>() {
        crate::files::transfer::relaunch_session::record_saved_connection(
            pm,
            &manager,
            transfer_id,
            session_id,
        );
    }
}

/// Parse the frontend FTP settings JSON into an expanded [`FtpConfig`].
#[cfg(feature = "ftp")]
fn parse_ftp_config(
    config: serde_json::Value,
) -> Result<termihub_core::config::FtpConfig, TerminalError> {
    let parsed: termihub_core::config::FtpConfig = serde_json::from_value(config)
        .map_err(|e| TerminalError::ConnectionFailed(format!("invalid FTP settings: {e}")))?;
    Ok(parsed.expand())
}

/// Register an FTP download (remote → local) as a queued transfer, returning
/// its `transfer_id`. Progress is reported via `transfer-progress` events.
#[tauri::command]
pub async fn ftp_download(
    session_id: String,
    config: serde_json::Value,
    remote_path: String,
    local_path: String,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    #[cfg(feature = "ftp")]
    {
        use crate::files::transfer::{self, TransferDirection};
        use termihub_core::backends::ftp::FtpDirection;

        debug!(session_id, remote_path, local_path, "FTP download");
        let config = parse_ftp_config(config)?;
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let file_name = file_name_of(&remote_path);
        let handle = registry.enqueue(
            &transfer_id,
            &session_id,
            TransferDirection::Download,
            &file_name,
            &remote_path,
            0,
        );
        // Durable queue (PROD-0011): persist metadata only — the FTP `config`
        // (which carries credentials) is deliberately NOT persisted, only the
        // session reference and paths.
        if let Some(pm) = app_handle.try_state::<TransferPersistenceManager>() {
            pm.record_registration(
                &transfer_id,
                &session_id,
                TransferDirection::Download,
                &file_name,
                &remote_path,
                Some(local_path.clone()),
                0,
            );
            record_ftp_saved_connection(&pm, &app_handle, &transfer_id, &session_id);
        }
        let registry = (*registry).clone();
        let sink = transfer::app_progress_sink(app_handle);
        tauri::async_runtime::spawn(async move {
            transfer::ftp::run_ftp_transfer(
                config,
                FtpDirection::Download,
                remote_path,
                local_path,
                handle,
                registry,
                sink,
                0,
            )
            .await;
        });
        Ok(transfer_id)
    }
    #[cfg(not(feature = "ftp"))]
    {
        let _ = (
            session_id,
            config,
            remote_path,
            local_path,
            registry,
            app_handle,
        );
        Err(TerminalError::ConnectionFailed(
            "FTP support is not built into this binary".to_string(),
        ))
    }
}

/// Register an FTP upload (local → remote) as a queued transfer, returning its
/// `transfer_id`. Mirrors [`ftp_download`].
#[tauri::command]
pub async fn ftp_upload(
    session_id: String,
    config: serde_json::Value,
    local_path: String,
    remote_path: String,
    registry: State<'_, TransferRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<String, TerminalError> {
    #[cfg(feature = "ftp")]
    {
        use crate::files::transfer::{self, TransferDirection};
        use termihub_core::backends::ftp::FtpDirection;

        debug!(session_id, local_path, remote_path, "FTP upload");
        let config = parse_ftp_config(config)?;
        let transfer_id = uuid::Uuid::new_v4().to_string();
        // Named for the *remote* path, not the local one, so the name always
        // agrees with the `path` this row displays (#1594, mirroring the SFTP
        // fix in #1573). Every honest local→remote upload builds `remote_path`
        // as `<dir>/<basename of local>`, so this is byte-for-byte unchanged
        // for them; it only differs for a future caller that uploads from a
        // scratch/temp path the user never named (as SFTP→SFTP paste does).
        let file_name = file_name_of(&remote_path);
        let handle = registry.enqueue(
            &transfer_id,
            &session_id,
            TransferDirection::Upload,
            &file_name,
            &remote_path,
            0,
        );
        // Durable queue (PROD-0011): persist metadata only — never the FTP
        // `config` credentials, only the session reference and paths.
        if let Some(pm) = app_handle.try_state::<TransferPersistenceManager>() {
            pm.record_registration(
                &transfer_id,
                &session_id,
                TransferDirection::Upload,
                &file_name,
                &remote_path,
                Some(local_path.clone()),
                0,
            );
            record_ftp_saved_connection(&pm, &app_handle, &transfer_id, &session_id);
        }
        let registry = (*registry).clone();
        let sink = transfer::app_progress_sink(app_handle);
        tauri::async_runtime::spawn(async move {
            transfer::ftp::run_ftp_transfer(
                config,
                FtpDirection::Upload,
                remote_path,
                local_path,
                handle,
                registry,
                sink,
                0,
            )
            .await;
        });
        Ok(transfer_id)
    }
    #[cfg(not(feature = "ftp"))]
    {
        let _ = (
            session_id,
            config,
            local_path,
            remote_path,
            registry,
            app_handle,
        );
        Err(TerminalError::ConnectionFailed(
            "FTP support is not built into this binary".to_string(),
        ))
    }
}
