//! [`ConnectionType`] implementation that forwards all calls to a remote
//! agent via JSON-RPC through [`AgentConnectionManager`].
//!
//! The desktop creates a `RemoteProxy` instead of a concrete backend when
//! the user specifies an `agent_id`. All terminal I/O, file browsing, and
//! monitoring operations are proxied to the agent over the SSH transport.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// Default monitoring collection interval in milliseconds (#1233).
///
/// Matches the agent's own default; `set_interval` overrides it per subscription.
const DEFAULT_MONITORING_INTERVAL_MS: u64 = 2000;

/// Channel capacity for the status-derivation driver's stats/status streams.
///
/// Matches the SSH provider's sizing: stats are frequent (small buffer),
/// status transitions are rare.
const MONITORING_CHANNEL_CAPACITY: usize = 16;
const MONITORING_STATUS_CHANNEL_CAPACITY: usize = 8;

/// Grace added on top of the collection interval before a *missing* agent
/// sample counts as one failed collect (SM-012).
///
/// A sample can arrive slightly late under agent-runner load without meaning the
/// stream has dropped; the grace absorbs that jitter. `DEFAULT_STALE_THRESHOLD`
/// consecutive missed windows are still required before the monitor reports
/// `Stale`, so a single late sample never flaps the indicator.
const MONITORING_FRESHNESS_GRACE_MS: u64 = 1000;

// Note: `Mutex` is used only for fields that need interior mutability
// through `&self` (remote_session_id, remote_type_id, etc.).
// `file_browser_proxy` and `monitoring_proxy` use plain `Option` because
// they are only set in `connect(&mut self)` and cleared in
// `disconnect(&mut self)`, so mutable access is guaranteed.

use serde_json::Value;
use tracing::{debug, warn};

use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::{CoreError, FileError, SessionError};
use termihub_core::files::{FileBrowser, FileEntry};
use termihub_core::monitoring::{
    agent_recovery_budget, CollectLoopState, KillSignal, MonitorStatus, MonitorStatusReason,
    MonitorStatusSender, MonitoringProvider, MonitoringReceiver, MonitoringSender,
    MonitoringSubscription, ProcessError, ProcessInfo, ProcessManager, DEFAULT_STALE_THRESHOLD,
};
use termihub_core::protocol::methods::{
    ConnectionTypesResult, FilesListResult, FilesReadResult, MonitoringStatusNotification,
    MonitoringSubscribeParams, MonitoringUnsubscribeParams, ProcessesListResult,
};

use crate::terminal::agent_manager::AgentRpcClient;
use crate::terminal::backend::OUTPUT_CHANNEL_CAPACITY;

/// A [`ConnectionType`] implementation that proxies all operations to a
/// remote agent via JSON-RPC.
///
/// Created by the [`SessionManager`](super::manager::SessionManager) when
/// `agent_id` is provided during connection creation.
pub struct RemoteProxy {
    agent_id: String,
    /// The remote session ID assigned by the agent after `connection.create`.
    remote_session_id: Mutex<Option<String>>,
    agent_manager: Arc<dyn AgentRpcClient>,
    /// The type_id of the remote connection (e.g., "local", "ssh").
    remote_type_id: Mutex<String>,
    /// Capabilities reported by the agent for this connection type.
    remote_capabilities: Mutex<Capabilities>,
    /// std output channel for receiving data from agent_manager.
    std_output_rx: Mutex<Option<mpsc::Receiver<Vec<u8>>>>,
    /// Whether the proxy is connected to a remote session.
    connected: AtomicBool,
    /// File browser proxy (set during connect if supported).
    file_browser_proxy: Option<RemoteFileBrowserProxy>,
    /// Monitoring proxy (set during connect if supported).
    monitoring_proxy: Option<Arc<RemoteMonitoringProxy>>,
    /// Process manager proxy (list / kill), set up on connect when the remote
    /// session can be inspected (PROD-0028).
    process_proxy: Option<Arc<RemoteProcessProxy>>,
}

impl RemoteProxy {
    /// Create a new disconnected `RemoteProxy`.
    ///
    /// Call [`connect()`](ConnectionType::connect) with settings JSON
    /// containing `type` and connection-specific parameters to establish
    /// the remote session.
    pub fn new(agent_id: String, agent_manager: Arc<dyn AgentRpcClient>) -> Self {
        Self {
            agent_id,
            remote_session_id: Mutex::new(None),
            agent_manager,
            remote_type_id: Mutex::new("remote".to_string()),
            remote_capabilities: Mutex::new(Capabilities {
                monitoring: false,
                file_browser: false,
                graphical: false,
                resize: true,
                persistent: false,
                terminal: true,
                // Placeholder until the agent reports; the remote's real
                // capabilities (incl. tunneling) replace these on connect.
                tunneling: false,
            }),
            std_output_rx: Mutex::new(None),
            connected: AtomicBool::new(false),
            file_browser_proxy: None,
            monitoring_proxy: None,
            process_proxy: None,
        }
    }

    fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn remote_session_id(&self) -> Option<String> {
        self.remote_session_id.lock().ok()?.clone()
    }

    /// Re-establish a desktop-side connection to an existing daemon session on the
    /// agent without creating a new session via JSON-RPC.
    ///
    /// Called by [`SessionManager::attach_persistent_tab`] when the desktop's
    /// session entry was cleaned up after an agent SSH disconnect, but the daemon
    /// process survived on the remote host. Registers a fresh output channel and
    /// calls `attach_session` so the daemon sends a buffer replay.
    ///
    /// The caller must insert the returned proxy into `SessionManager::sessions`
    /// under the **same** session ID that was stored in `PersistentRecord` so that
    /// the tab's `existingSessionId` prop and the pending-output buffer in
    /// `TerminalOutputDispatcher` continue to work without any frontend state update.
    pub fn reconnect_existing(
        agent_id: String,
        remote_session_id: String,
        agent_manager: Arc<dyn AgentRpcClient>,
    ) -> Result<Self, SessionError> {
        let (std_tx, std_rx) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_CHANNEL_CAPACITY);

        agent_manager
            .register_session_output(&agent_id, &remote_session_id, std_tx)
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        agent_manager
            .attach_session(&agent_id, &remote_session_id)
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        Ok(Self {
            agent_id,
            remote_session_id: Mutex::new(Some(remote_session_id)),
            agent_manager,
            remote_type_id: Mutex::new("remote".to_string()),
            remote_capabilities: Mutex::new(Capabilities {
                monitoring: false,
                file_browser: false,
                graphical: false,
                resize: true,
                persistent: true,
                terminal: true,
                // Placeholder until the agent reports; the remote's real
                // capabilities (incl. tunneling) replace these on connect.
                tunneling: false,
            }),
            std_output_rx: Mutex::new(Some(std_rx)),
            connected: AtomicBool::new(true),
            file_browser_proxy: None,
            monitoring_proxy: None,
            process_proxy: None,
        })
    }
}

#[async_trait::async_trait]
impl ConnectionType for RemoteProxy {
    fn type_id(&self) -> &str {
        // Return a static string; callers wanting the actual remote type
        // should check session info.
        "remote"
    }

    fn display_name(&self) -> &str {
        "Remote"
    }

    fn settings_schema(&self) -> SettingsSchema {
        // Remote connections use the agent's schema, not a local one.
        SettingsSchema { groups: vec![] }
    }

    fn capabilities(&self) -> Capabilities {
        self.remote_capabilities
            .lock()
            .map(|c| c.clone())
            .unwrap_or(Capabilities {
                monitoring: false,
                file_browser: false,
                graphical: false,
                resize: true,
                persistent: false,
                terminal: true,
                tunneling: false,
            })
    }

    async fn connect(&mut self, settings: Value) -> Result<(), SessionError> {
        self.connect_cancellable(settings, None).await
    }

    /// Connect to the remote session, abortable via an optional cancellation
    /// token.
    ///
    /// Cancelling the token aborts the in-flight agent handshake (create /
    /// attach / capability query) promptly instead of running it to completion,
    /// and tears down any session already created on the agent so no orphan is
    /// left behind (#1122). Without a token this behaves exactly like
    /// [`connect`](Self::connect).
    async fn connect_cancellable(
        &mut self,
        settings: Value,
        cancel: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<(), SessionError> {
        // Fast path: no token → run the handshake directly.
        let Some(cancel) = cancel else {
            return self.run_connect_handshake(settings, None).await;
        };

        // Already cancelled before we even start: nothing was created, so just
        // report the cancellation without touching the agent.
        if cancel.is_cancelled() {
            return Err(SessionError::SpawnFailed(
                "remote connect cancelled".to_string(),
            ));
        }

        // Tracks the session ID created on the agent so a mid-handshake cancel
        // can close it (no orphan). Populated by the handshake immediately after
        // `create_session` succeeds.
        let created_sid: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let agent_id = self.agent_id.clone();
        let agent_manager = self.agent_manager.clone();

        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // Cancellation fired first: drop the handshake future (releasing
                // its &mut self borrow), then tear down any session the agent
                // already created so it does not linger.
                let sid = created_sid.lock().ok().and_then(|g| g.clone());
                if let Some(sid) = sid {
                    let _ = agent_manager.unregister_session_output(&agent_id, &sid);
                    // close_session's internal blocking_recv must not run on a
                    // tokio worker — offload to the blocking pool.
                    let _ = tokio::task::spawn_blocking(move || {
                        agent_manager.close_session(&agent_id, &sid)
                    })
                    .await;
                }
                Err(SessionError::SpawnFailed(
                    "remote connect cancelled".to_string(),
                ))
            }
            result = self.run_connect_handshake(settings, Some(created_sid.clone())) => result,
        }
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        let remote_sid = self.remote_session_id();

        if let Some(sid) = remote_sid {
            // Unregister monitoring channel if monitoring was active.
            if self.monitoring_proxy.is_some() {
                let _ = self
                    .agent_manager
                    .unregister_monitoring_output(self.agent_id(), &sid);
            }

            // Detach from output.
            let _ = self
                .agent_manager
                .unregister_session_output(self.agent_id(), &sid);

            // Close the session on the agent. Runs on the blocking thread pool
            // to keep `oneshot::Receiver::blocking_recv` off a tokio worker.
            let mgr = self.agent_manager.clone();
            let agent_id_owned = self.agent_id.clone();
            let _ =
                tokio::task::spawn_blocking(move || mgr.close_session(&agent_id_owned, &sid)).await;
        }

        // Clear local state.
        if let Ok(mut sid) = self.remote_session_id.lock() {
            *sid = None;
        }
        if let Ok(mut rx) = self.std_output_rx.lock() {
            *rx = None;
        }
        self.file_browser_proxy = None;
        self.monitoring_proxy = None;
        self.process_proxy = None;

        self.connected.store(false, Ordering::SeqCst);
        debug!(agent_id = self.agent_id(), "Remote proxy disconnected");
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst) && self.agent_manager.is_connected(self.agent_id())
    }

    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        let remote_sid = self
            .remote_session_id()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        self.agent_manager
            .send_session_input(self.agent_id(), &remote_sid, data)
            .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        let remote_sid = self
            .remote_session_id()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        self.agent_manager
            .resize_session(self.agent_id(), &remote_sid, cols, rows)
            .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (tokio_tx, tokio_rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);

        // Take the std receiver and bridge it to the tokio channel.
        let std_rx = self.std_output_rx.lock().ok().and_then(|mut r| r.take());

        if let Some(std_rx) = std_rx {
            std::thread::spawn(move || {
                while let Ok(data) = std_rx.recv() {
                    if tokio_tx.blocking_send(data).is_err() {
                        break;
                    }
                }
            });
        }

        tokio_rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        self.monitoring_proxy
            .as_ref()
            .map(|p| p.as_ref() as &dyn MonitoringProvider)
    }

    fn monitoring_handle(&self) -> Option<Arc<dyn MonitoringProvider + Send + Sync>> {
        self.monitoring_proxy
            .as_ref()
            .map(|p| p.clone() as Arc<dyn MonitoringProvider + Send + Sync>)
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        self.file_browser_proxy
            .as_ref()
            .map(|p| p as &dyn FileBrowser)
    }

    fn process_manager(&self) -> Option<Arc<dyn ProcessManager + Send + Sync>> {
        self.process_proxy
            .as_ref()
            .map(|p| p.clone() as Arc<dyn ProcessManager + Send + Sync>)
    }
}

impl RemoteProxy {
    /// Run the agent connect handshake (create session, register + attach
    /// output, query capabilities) and populate the proxy's state.
    ///
    /// When `created_sid` is `Some`, the created remote session ID is written
    /// into it immediately after `create_session` returns so a concurrent
    /// cancellation (see [`connect_cancellable`](ConnectionType::connect_cancellable))
    /// can tear the session down.
    async fn run_connect_handshake(
        &mut self,
        settings: Value,
        created_sid: Option<Arc<Mutex<Option<String>>>>,
    ) -> Result<(), SessionError> {
        if self.connected.load(Ordering::SeqCst) {
            return Err(SessionError::AlreadyExists(
                "Already connected to remote session".to_string(),
            ));
        }

        // Extract the remote connection type and config from settings.
        // Normalise frontend aliases: "shell" is the user-facing name but the
        // agent registry uses "local".  Apply the same mapping here so that
        // capability lookups and the monitoring-host check ("local" → "self")
        // work correctly when the frontend sends type = "shell".
        let raw_type = settings
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("local");
        let session_type = match raw_type {
            "shell" => "local".to_string(),
            other => other.to_string(),
        };

        let config = settings
            .get("config")
            .cloned()
            .unwrap_or_else(|| settings.clone());

        let title = settings
            .get("title")
            .and_then(|v| v.as_str())
            .map(String::from);

        // Optional: link this session to a saved connection definition so it
        // can be re-attached after tab close, agent restart, or desktop restart.
        // The frontend places `definitionId` inside the connection settings
        // (which the desktop's `SessionManager::create_connection` wraps under
        // a `config` key before reaching us), so look there first; fall back
        // to the top level for callers that pass it alongside `type`.
        let definition_id = config
            .get("definitionId")
            .or_else(|| config.get("definition_id"))
            .or_else(|| settings.get("definitionId"))
            .or_else(|| settings.get("definition_id"))
            .and_then(|v| v.as_str())
            .map(String::from);

        // Store the remote type for metadata.
        if let Ok(mut t) = self.remote_type_id.lock() {
            *t = session_type.clone();
        }

        // Create the session on the agent.
        //
        // The agent_manager helpers internally call `oneshot::Receiver::blocking_recv`,
        // which parks the calling thread until the io task delivers the response.
        // When called directly from an async task (Tauri's `create_connection` command),
        // the parked tokio worker never wakes from the cross-task `tx.send`, so we run
        // the blocking calls on the dedicated blocking thread pool via `spawn_blocking`.
        let mgr = self.agent_manager.clone();
        let agent_id_owned = self.agent_id.clone();
        let session_type_owned = session_type.clone();
        let title_owned = title.clone();
        let config_owned = config.clone();
        let definition_id_owned = definition_id.clone();
        let session_info = tokio::task::spawn_blocking(move || {
            mgr.create_session(
                &agent_id_owned,
                &session_type_owned,
                config_owned,
                title_owned.as_deref(),
                definition_id_owned.as_deref(),
            )
        })
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("spawn_blocking join: {e}")))?
        .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        let remote_sid = session_info.session_id.clone();

        // Publish the created session ID so a concurrent cancellation can tear
        // it down (no orphan) even though we have not finished attaching yet.
        if let Some(cell) = &created_sid {
            if let Ok(mut slot) = cell.lock() {
                *slot = Some(remote_sid.clone());
            }
        }

        // Set up output channel: std sync channel for agent_manager,
        // which we'll bridge to tokio in subscribe_output().
        let (std_tx, std_rx) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_CHANNEL_CAPACITY);

        // Register the output sender with the agent manager.
        // `register_session_output` does not block on a response — just pushes a
        // command into the io task's channel — so it's safe to call directly here.
        self.agent_manager
            .register_session_output(self.agent_id(), &remote_sid, std_tx)
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        // Attach to the session to start receiving output. Same reasoning as
        // `create_session` above: must run on the blocking thread pool.
        let mgr = self.agent_manager.clone();
        let agent_id_owned = self.agent_id.clone();
        let remote_sid_owned = remote_sid.clone();
        tokio::task::spawn_blocking(move || mgr.attach_session(&agent_id_owned, &remote_sid_owned))
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("spawn_blocking join: {e}")))?
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        // Store state.
        if let Ok(mut sid) = self.remote_session_id.lock() {
            *sid = Some(remote_sid.clone());
        }
        if let Ok(mut rx) = self.std_output_rx.lock() {
            *rx = Some(std_rx);
        }

        // Query capabilities from the agent for this session type.
        let mgr = self.agent_manager.clone();
        let agent_id_owned = self.agent_id.clone();
        let caps_result = tokio::task::spawn_blocking(move || {
            mgr.send_request(
                &agent_id_owned,
                termihub_core::protocol::methods::CONNECTION_TYPES,
                serde_json::json!({}),
            )
        })
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("spawn_blocking join: {e}")))?;
        // Parse the reply into the shared `ConnectionTypesResult` DTO (DUP-001)
        // and pick this session type's typed `Capabilities` — replacing the
        // hand-rolled `get("types")`/`get("typeId")`/`get("capabilities")`
        // indexing. A malformed reply leaves the defaults in place.
        if let Ok(caps_result) = caps_result {
            let type_info = serde_json::from_value::<ConnectionTypesResult>(caps_result)
                .ok()
                .and_then(|r| r.types.into_iter().find(|t| t.type_id == session_type));
            if let Some(type_info) = type_info {
                let parsed = type_info.capabilities;
                if let Ok(mut c) = self.remote_capabilities.lock() {
                    *c = parsed.clone();
                }
                // Set up file browser proxy if supported.
                if parsed.file_browser {
                    self.file_browser_proxy = Some(RemoteFileBrowserProxy {
                        agent_id: self.agent_id.clone(),
                        remote_session_id: remote_sid.clone(),
                        agent_manager: self.agent_manager.clone(),
                    });
                }
                // Set up monitoring proxy if supported.
                if parsed.monitoring {
                    // Local sessions are monitored on the agent host itself
                    // via the "self" sentinel; SSH sessions use the session ID.
                    let monitoring_host = if session_type == "local" {
                        "self".to_string()
                    } else {
                        remote_sid.clone()
                    };
                    self.monitoring_proxy = Some(Arc::new(RemoteMonitoringProxy {
                        agent_id: self.agent_id.clone(),
                        monitoring_host,
                        agent_manager: self.agent_manager.clone(),
                        interval_ms: Arc::new(AtomicU64::new(DEFAULT_MONITORING_INTERVAL_MS)),
                        paused_tx: tokio::sync::watch::channel(false).0,
                    }));
                    // A host that can be monitored can also have its processes
                    // listed/killed (PROD-0028). For a local agent session the
                    // "self"-hosted manager runs on the agent; the agent scopes
                    // by the connection id it receives (None for local).
                    // Agent-hosted SSH/Docker/WSL process support is a follow-up —
                    // the agent returns NotSupported for those today.
                    let process_connection_id = if session_type == "local" {
                        None
                    } else {
                        Some(remote_sid.clone())
                    };
                    self.process_proxy = Some(Arc::new(RemoteProcessProxy {
                        agent_id: self.agent_id.clone(),
                        connection_id: process_connection_id,
                        agent_manager: self.agent_manager.clone(),
                    }));
                }
            }
        }

        self.connected.store(true, Ordering::SeqCst);
        debug!(
            agent_id = self.agent_id(),
            remote_session_id = %remote_sid,
            "Remote proxy connected"
        );

        Ok(())
    }
}

/// File browser proxy that forwards operations to a remote agent.
///
/// Returned by `ConnectionType::file_browser()` on `RemoteProxy`.
pub struct RemoteFileBrowserProxy {
    agent_id: String,
    remote_session_id: String,
    agent_manager: Arc<dyn AgentRpcClient>,
}

impl RemoteFileBrowserProxy {
    /// Run a sync `send_request` on the blocking thread pool so its internal
    /// `oneshot::Receiver::blocking_recv` does not park a tokio worker thread.
    async fn rpc(
        &self,
        method: &'static str,
        params: impl serde::Serialize,
    ) -> Result<Value, FileError> {
        // Serialize the shared param DTO into the RPC `Value` here so every
        // call site stays a one-liner (DUP-001).
        let params =
            serde_json::to_value(&params).map_err(|e| FileError::OperationFailed(e.to_string()))?;
        let mgr = self.agent_manager.clone();
        let agent_id = self.agent_id.clone();
        tokio::task::spawn_blocking(move || mgr.send_request(&agent_id, method, params))
            .await
            .map_err(|e| FileError::OperationFailed(format!("spawn_blocking join: {e}")))?
            .map_err(|e| FileError::OperationFailed(e.to_string()))
    }
}

/// Builders for the `connection.files.*` JSON-RPC request params.
///
/// These are factored out of the [`FileBrowser`] impl below as pure functions
/// that return the shared `core::protocol::methods` param DTOs (DUP-001): the
/// desktop and the agent share one definition of each request wire shape, so the
/// field names can no longer silently drift. Callers serialize the returned DTO
/// (`RemoteFileBrowserProxy::rpc` takes `impl Serialize`). The wire bytes are
/// pinned byte-for-byte against the pre-migration `json!` in the `wire_contract`
/// tests (audit findings AGT-001, AGT-009, TBE-009).
///
/// `delete` is the notable asymmetry — `FilesDeleteParams` is the only files DTO
/// with `#[serde(rename_all = "camelCase")]`, so it serializes to
/// `connectionId`/`isDirectory` while its siblings use snake_case.
mod files_params {
    use termihub_core::protocol::methods::{
        FilesCopyParams, FilesCreateSymlinkParams, FilesDeleteParams, FilesListParams,
        FilesMkdirParams, FilesReadParams, FilesRenameParams, FilesSetOwnerParams,
        FilesSetPermissionsParams, FilesStatParams, FilesWriteParams,
    };

    pub(super) fn list(connection_id: &str, path: &str) -> FilesListParams {
        FilesListParams {
            connection_id: Some(connection_id.to_string()),
            path: path.to_string(),
        }
    }

    pub(super) fn read(connection_id: &str, path: &str) -> FilesReadParams {
        FilesReadParams {
            connection_id: Some(connection_id.to_string()),
            path: path.to_string(),
        }
    }

    pub(super) fn write(connection_id: &str, path: &str, data_b64: &str) -> FilesWriteParams {
        FilesWriteParams {
            connection_id: Some(connection_id.to_string()),
            path: path.to_string(),
            data: data_b64.to_string(),
        }
    }

    /// `FilesDeleteParams` serializes to `connectionId`/`isDirectory` (camelCase).
    /// `isDirectory` is advisory: the agent self-detects the entry kind via
    /// `stat` and discards this hint (`agent/src/handler/dispatch.rs`), but the
    /// field must be present for the agent's `params.parse()` to succeed. The
    /// [`FileBrowser::delete`] trait carries no directory flag to forward here,
    /// so a benign `false` is sent purely to satisfy the required field.
    pub(super) fn delete(connection_id: &str, path: &str) -> FilesDeleteParams {
        FilesDeleteParams {
            connection_id: Some(connection_id.to_string()),
            path: path.to_string(),
            is_directory: false,
        }
    }

    /// The trait's `from`/`to` map onto the agent's `old_path`/`new_path`.
    pub(super) fn rename(connection_id: &str, from: &str, to: &str) -> FilesRenameParams {
        FilesRenameParams {
            connection_id: Some(connection_id.to_string()),
            old_path: from.to_string(),
            new_path: to.to_string(),
        }
    }

    pub(super) fn stat(connection_id: &str, path: &str) -> FilesStatParams {
        FilesStatParams {
            connection_id: Some(connection_id.to_string()),
            path: path.to_string(),
        }
    }

    pub(super) fn mkdir(connection_id: &str, path: &str) -> FilesMkdirParams {
        FilesMkdirParams {
            connection_id: Some(connection_id.to_string()),
            path: path.to_string(),
        }
    }

    /// `mode` carries the low 12 mode bits.
    pub(super) fn set_permissions(
        connection_id: &str,
        path: &str,
        mode: u32,
    ) -> FilesSetPermissionsParams {
        FilesSetPermissionsParams {
            connection_id: Some(connection_id.to_string()),
            path: path.to_string(),
            mode,
        }
    }

    /// A `None` `uid`/`gid` side serializes as JSON `null` and leaves that owner
    /// component unchanged on the agent.
    pub(super) fn set_owner(
        connection_id: &str,
        path: &str,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> FilesSetOwnerParams {
        FilesSetOwnerParams {
            connection_id: Some(connection_id.to_string()),
            path: path.to_string(),
            uid,
            gid,
        }
    }

    pub(super) fn create_symlink(
        connection_id: &str,
        target: &str,
        link_path: &str,
    ) -> FilesCreateSymlinkParams {
        FilesCreateSymlinkParams {
            connection_id: Some(connection_id.to_string()),
            target: target.to_string(),
            link_path: link_path.to_string(),
        }
    }

    pub(super) fn copy(connection_id: &str, src: &str, dest: &str) -> FilesCopyParams {
        FilesCopyParams {
            connection_id: Some(connection_id.to_string()),
            src: src.to_string(),
            dest: dest.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl FileBrowser for RemoteFileBrowserProxy {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let result = self
            .rpc(
                termihub_core::protocol::methods::CONNECTION_FILES_LIST,
                files_params::list(&self.remote_session_id, path),
            )
            .await?;

        // Parse the reply into the shared `FilesListResult` DTO (DUP-001).
        serde_json::from_value::<FilesListResult>(result)
            .map(|r| r.entries)
            .map_err(|e| FileError::OperationFailed(e.to_string()))
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let result = self
            .rpc(
                termihub_core::protocol::methods::CONNECTION_FILES_READ,
                files_params::read(&self.remote_session_id, path),
            )
            .await?;

        // Parse the reply into the shared `FilesReadResult` DTO (DUP-001).
        let parsed = serde_json::from_value::<FilesReadResult>(result)
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;
        base64_decode(&parsed.data)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_FILES_WRITE,
            files_params::write(&self.remote_session_id, path, &encoded),
        )
        .await?;
        Ok(())
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_FILES_DELETE,
            files_params::delete(&self.remote_session_id, path),
        )
        .await?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_FILES_RENAME,
            files_params::rename(&self.remote_session_id, from, to),
        )
        .await?;
        Ok(())
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let result = self
            .rpc(
                termihub_core::protocol::methods::CONNECTION_FILES_STAT,
                files_params::stat(&self.remote_session_id, path),
            )
            .await?;

        serde_json::from_value(result).map_err(|e| FileError::OperationFailed(e.to_string()))
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_FILES_MKDIR,
            files_params::mkdir(&self.remote_session_id, path),
        )
        .await?;
        Ok(())
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> Result<(), FileError> {
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_FILES_SET_PERMISSIONS,
            files_params::set_permissions(&self.remote_session_id, path, mode),
        )
        .await?;
        Ok(())
    }

    async fn set_owner(
        &self,
        path: &str,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> Result<(), FileError> {
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_FILES_SET_OWNER,
            files_params::set_owner(&self.remote_session_id, path, uid, gid),
        )
        .await?;
        Ok(())
    }

    async fn create_symlink(&self, target: &str, link_path: &str) -> Result<(), FileError> {
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_FILES_CREATE_SYMLINK,
            files_params::create_symlink(&self.remote_session_id, target, link_path),
        )
        .await?;
        Ok(())
    }

    async fn copy(&self, src: &str, dest: &str) -> Result<(), FileError> {
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_FILES_COPY,
            files_params::copy(&self.remote_session_id, src, dest),
        )
        .await?;
        Ok(())
    }
}

/// Process manager proxy that forwards list/kill to a remote agent (PROD-0028).
///
/// Returned by `ConnectionType::process_manager()` on `RemoteProxy`. Holds the
/// scope `connection_id` the agent expects (`None` for a local agent session,
/// the remote session id otherwise) so the agent resolves the same host the
/// session runs on.
pub struct RemoteProcessProxy {
    agent_id: String,
    connection_id: Option<String>,
    agent_manager: Arc<dyn AgentRpcClient>,
}

/// Builders for the `connection.processes.*` JSON-RPC request params.
///
/// Return the shared `core::protocol::methods` param DTOs (DUP-001), so the
/// desktop and agent share one definition of each `connection.processes.*`
/// request shape; the `wire_contract` tests pin the bytes. Both use snake_case
/// defaults; `signal` serializes as the camelCase `KillSignal` (`"term"` /
/// `"kill"`).
mod processes_params {
    use termihub_core::monitoring::KillSignal;
    use termihub_core::protocol::methods::{ProcessKillParams, ProcessesListParams};

    pub(super) fn list(connection_id: Option<&str>) -> ProcessesListParams {
        ProcessesListParams {
            connection_id: connection_id.map(str::to_string),
        }
    }

    pub(super) fn kill(
        connection_id: Option<&str>,
        pid: u32,
        signal: KillSignal,
    ) -> ProcessKillParams {
        ProcessKillParams {
            connection_id: connection_id.map(str::to_string),
            pid,
            signal,
        }
    }
}

impl RemoteProcessProxy {
    /// Run a sync `send_request` on the blocking pool (mirrors
    /// [`RemoteFileBrowserProxy::rpc`]) and map the outcome to [`ProcessError`].
    ///
    /// `is_kill` selects the fallback error variant so a transport/agent failure
    /// is reported as a kill or a list failure appropriately; the agent's
    /// "not supported" message is recognised and surfaced as
    /// [`ProcessError::NotSupported`] so the desktop keeps the typed distinction.
    async fn rpc(
        &self,
        method: &'static str,
        params: impl serde::Serialize,
        pid: Option<u32>,
    ) -> Result<Value, ProcessError> {
        let params =
            serde_json::to_value(&params).map_err(|e| ProcessError::ListFailed(e.to_string()))?;
        let mgr = self.agent_manager.clone();
        let agent_id = self.agent_id.clone();
        let result =
            tokio::task::spawn_blocking(move || mgr.send_request(&agent_id, method, params))
                .await
                .map_err(|e| ProcessError::ListFailed(format!("spawn_blocking join: {e}")))?;
        result.map_err(|e| {
            let msg = e.to_string();
            if msg.to_ascii_lowercase().contains("not supported")
                || msg.to_ascii_lowercase().contains("not yet supported")
            {
                ProcessError::NotSupported
            } else if let Some(pid) = pid {
                ProcessError::KillFailed { pid, message: msg }
            } else {
                ProcessError::ListFailed(msg)
            }
        })
    }
}

#[async_trait::async_trait]
impl ProcessManager for RemoteProcessProxy {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, ProcessError> {
        let result = self
            .rpc(
                termihub_core::protocol::methods::CONNECTION_PROCESSES_LIST,
                processes_params::list(self.connection_id.as_deref()),
                None,
            )
            .await?;
        // Parse the reply into the shared `ProcessesListResult` DTO (DUP-001).
        serde_json::from_value::<ProcessesListResult>(result)
            .map(|r| r.processes)
            .map_err(|e| ProcessError::ListFailed(e.to_string()))
    }

    async fn kill_process(&self, pid: u32, signal: KillSignal) -> Result<(), ProcessError> {
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_PROCESSES_KILL,
            processes_params::kill(self.connection_id.as_deref(), pid, signal),
            Some(pid),
        )
        .await
        .map(|_| ())
    }
}

/// Monitoring proxy that forwards operations to a remote agent.
pub struct RemoteMonitoringProxy {
    agent_id: String,
    /// The host key used for subscribe/unsubscribe requests and output routing.
    /// "self" for local sessions; the remote session ID for SSH sessions.
    monitoring_host: String,
    agent_manager: Arc<dyn AgentRpcClient>,
    /// Current collection interval in ms (#1233). `set_interval` re-subscribes
    /// the agent with the new cadence; `subscribe` reads it for the initial ask.
    ///
    /// Shared (`Arc`) so the spawned status-derivation driver can read the live
    /// cadence when computing its sample-freshness window (SM-012).
    interval_ms: Arc<AtomicU64>,
    /// Desktop-side pause state for an agent-mediated monitor (SM-013).
    ///
    /// Pause now propagates to the agent's poller too (#3001): `set_paused`
    /// unsubscribes the agent on pause and re-subscribes on resume (reusing the
    /// existing verbs), so the remote host stops sampling/streaming while
    /// paused. This channel keeps the desktop in sync in the meantime: the
    /// status-derivation driver watches it and, while paused, holds the badge at
    /// `Paused` and drops any sample still in flight — so the UI never desyncs
    /// from the "paused" label even before the agent acts on the RPC. A `watch`
    /// channel so a `set_paused` on the provider steers the running driver
    /// immediately (each `subscribe` takes a fresh receiver).
    paused_tx: tokio::sync::watch::Sender<bool>,
}

impl RemoteMonitoringProxy {
    /// Build a proxy that monitors a chosen agent's **own** host — the "self"
    /// sentinel — independent of any session's transport (#2593).
    ///
    /// Used when a system monitor's run-location resolves to an agent: the
    /// desktop routes `connection.monitoring.subscribe` for host `"self"`
    /// through that agent, so the streamed samples come from the agent host
    /// itself. The interval starts at the shared default and can be re-tuned via
    /// [`MonitoringProvider::set_interval`].
    pub fn for_agent_self(agent_id: String, agent_manager: Arc<dyn AgentRpcClient>) -> Self {
        Self {
            agent_id,
            monitoring_host: "self".to_string(),
            agent_manager,
            interval_ms: Arc::new(AtomicU64::new(DEFAULT_MONITORING_INTERVAL_MS)),
            paused_tx: tokio::sync::watch::channel(false).0,
        }
    }

    /// Run a sync `send_request` on the blocking thread pool so its internal
    /// `oneshot::Receiver::blocking_recv` does not park a tokio worker thread.
    async fn rpc(
        &self,
        method: &'static str,
        params: impl serde::Serialize,
    ) -> Result<Value, CoreError> {
        let params = serde_json::to_value(&params).map_err(|e| CoreError::Other(e.to_string()))?;
        let mgr = self.agent_manager.clone();
        let agent_id = self.agent_id.clone();
        tokio::task::spawn_blocking(move || mgr.send_request(&agent_id, method, params))
            .await
            .map_err(|e| CoreError::Other(format!("spawn_blocking join: {e}")))?
            .map_err(|e| CoreError::Other(e.to_string()))
    }
}

/// Derive the observable [`MonitorStatus`] for an agent-mediated monitor from
/// the *actual* sample flow, and forward samples to the consumer (SM-012).
///
/// The agent runs the real collect loop and streams samples over JSON-RPC; the
/// desktop only receives them. Unlike the direct-SSH provider, this side cannot
/// observe a collect success/failure directly, so it infers them:
///
/// - a sample arriving within the freshness window is a successful collect
///   (`CollectLoopState::on_success` → `Live`);
/// - no sample within `interval + grace` is a missed collect
///   (`on_failure`); `DEFAULT_STALE_THRESHOLD` consecutive misses → `Stale`;
/// - once `Stale`, if the agent transport is down (`transport_alive` is
///   `false`, i.e. the agent-connection layer is reconnecting) the monitor
///   reports `Reconnecting`. A later sample recovers it to `Live`;
/// - **bounded `Connecting`/`Reconnecting` (#3300).** If no first sample
///   arrives — or none after entering `Reconnecting` — within
///   `CollectLoopState::pre_live_failure_limit` consecutive freshness windows
///   (3 × the stale threshold, 6 windows by default: ≈18 s at the 2 s default
///   interval, comfortably past the agent's 10 s collect timeout so a slow
///   first agent sample still lands), the monitor resolves to `Offline`
///   instead of hanging. Unlike the direct providers the driver does not end
///   on `Offline`: the subscription stays registered, so a sample that does
///   arrive later still recovers to `Live`.
///
/// **Agent-reported status (#3321).** A current agent reports every
/// collect-loop transition as a `connection.monitoring.status` notification,
/// routed here on `reports_rx`. A report is applied as-is
/// ([`CollectLoopState::apply_reported`]) — the agent observes its own collects
/// and re-dials, which the desktop can only guess at. Once an agent has sent a
/// report, a non-`Live` status it reported (or that the desktop inferred) is no
/// longer advanced by missed samples while the agent transport is up: the agent
/// will report `Reconnecting`/`Offline`/`Live` itself, and its reconnect
/// campaign legitimately outlasts the desktop's short pre-`Live` bound. An older
/// agent never reports, so the driver keeps inferring exactly as before.
///
/// **Bounded `Stale` (#3321).** With the agent transport up, a `Stale` monitor
/// never escalates to `Reconnecting` (that needs a dead transport), so an agent
/// whose own loop gave up and stopped streaming would leave the badge `Stale`
/// forever. The driver therefore accrues the silent time while `Stale` (or, for
/// a reporting agent, any non-`Live` status) with the transport up, and resolves
/// `Offline` once it reaches [`agent_recovery_budget`] for the current interval
/// — the worst case in which the agent's loop either recovers or ends itself
/// (217 s at the 2 s default: 2 stale collects + 6 pre-`Live` collects at
/// `interval + 10 s` collect timeout, plus the 121 s reconnect backoff). Any
/// sample or agent report restarts the count, and a late sample still recovers
/// `Offline` to `Live`.
///
/// **Pause (SM-013, #3001).** Pausing an agent-hosted monitor unsubscribes the
/// agent's poller (`set_paused` → `connection.monitoring.unsubscribe`), so the
/// remote host stops sampling/streaming. This driver also honours pause on the
/// desktop so the UI stays in sync in the gap before the agent acts: while
/// `paused_rx` reads `true` it emits `Paused`, then **discards** any sample
/// still in flight (no forward to `stats_tx`, no freshness/`Stale` accounting),
/// so the numbers freeze at the last reading and the badge stays `Paused`.
/// Resuming re-subscribes the agent and emits `Live`; the next fresh sample
/// flows through again.
///
/// The loop ends when the consumer drops `stats_tx` (tab closed), the agent
/// registration is torn down on `unsubscribe`/`disconnect` (closing `raw_rx`),
/// or the provider is dropped (closing `paused_rx`). A closed `reports_rx`
/// only means no reports will arrive (inference continues).
#[allow(clippy::too_many_arguments)]
async fn drive_monitor_status<F>(
    mut raw_rx: MonitoringReceiver,
    stats_tx: MonitoringSender,
    status_tx: MonitorStatusSender,
    interval_ms: Arc<AtomicU64>,
    grace: Duration,
    transport_alive: F,
    mut paused_rx: tokio::sync::watch::Receiver<bool>,
    reports_rx: tokio::sync::mpsc::Receiver<MonitoringStatusNotification>,
) where
    F: Fn() -> bool + Send,
{
    let mut loop_state = CollectLoopState::with_threshold(DEFAULT_STALE_THRESHOLD);
    let mut reports_rx = Some(reports_rx);
    // Whether this agent has ever reported its own status (#3321).
    let mut agent_reports = false;
    // Silent time accrued toward the `Stale` bound (#3321).
    let mut silent = Duration::ZERO;

    // Honour a monitor that starts paused (the pause state survives a
    // re-subscribe on the provider).
    if *paused_rx.borrow_and_update() && loop_state.pause().is_some() {
        let _ = status_tx.send(loop_state.update()).await;
    }

    loop {
        // Paused: keep the agent subscription open but discard whatever it keeps
        // streaming, and never count it for freshness — the badge holds `Paused`
        // and the numbers stay frozen at the last reading (SM-013).
        if loop_state.is_paused() {
            tokio::select! {
                changed = paused_rx.changed() => {
                    if changed.is_err() {
                        break; // provider dropped: subscription is going away
                    }
                    if !*paused_rx.borrow_and_update() {
                        // Resumed: announce Live; the next fresh sample keeps it Live.
                        if loop_state.resume().is_some() {
                            let _ = status_tx.send(loop_state.update()).await;
                        }
                    }
                }
                raw = raw_rx.recv() => match raw {
                    // Drop samples that arrive while paused.
                    Some(_) => {}
                    // Raw channel closed: the subscription was torn down.
                    None => break,
                },
                // Pause is owned by the desktop: note that the agent reports,
                // but do not apply a report while paused.
                report = next_report(&mut reports_rx) => match report {
                    Some(_) => agent_reports = true,
                    None => reports_rx = None,
                },
            }
            continue;
        }

        let interval = Duration::from_millis(interval_ms.load(Ordering::SeqCst).max(1));
        let freshness = interval.saturating_add(grace);

        // `biased`: pause first, then agent reports, then samples. The agent
        // sends a status report before the sample it concerns and the I/O task
        // routes both in wire order, so draining reports first never applies a
        // report older than a sample already seen.
        tokio::select! {
            biased;
            changed = paused_rx.changed() => {
                if changed.is_err() {
                    break; // provider dropped
                }
                if *paused_rx.borrow_and_update() && loop_state.pause().is_some() {
                    let _ = status_tx.send(loop_state.update()).await;
                }
            }
            report = next_report(&mut reports_rx) => match report {
                Some(report) => {
                    // The agent's own view of its loop wins over inference.
                    agent_reports = true;
                    silent = Duration::ZERO;
                    // Emit on a status *or* reason change: an agent that
                    // re-reports `Offline` with a different cause must still
                    // update the badge text (#3301).
                    let before = loop_state.update();
                    loop_state.apply_reported(report.status, report.reason);
                    let after = loop_state.update();
                    if after != before {
                        debug!(
                            host = %report.host,
                            status = ?after.status,
                            reason = ?after.reason,
                            "Agent reported monitoring status"
                        );
                        let _ = status_tx.send(after).await;
                    }
                }
                // Reports channel closed: this client routes none; keep inferring.
                None => reports_rx = None,
            },
            recv = tokio::time::timeout(freshness, raw_rx.recv()) => match recv {
                Ok(Some(stats)) => {
                    // Fresh sample: forward it, then mark the loop Live.
                    if stats_tx.send(stats).await.is_err() {
                        break; // consumer gone
                    }
                    silent = Duration::ZERO;
                    if loop_state.on_success().is_some() {
                        let _ = status_tx.send(loop_state.update()).await;
                    }
                }
                // Raw channel closed: the subscription was torn down. Stop cleanly
                // (no status emit — the session is going away).
                Ok(None) => break,
                Err(_elapsed) => {
                    let alive = transport_alive();
                    // A reporting agent owns its non-Live transitions while its
                    // transport is up (#3321); otherwise infer as before.
                    let agent_owns_status = agent_reports
                        && alive
                        && matches!(
                            loop_state.status(),
                            MonitorStatus::Connecting
                                | MonitorStatus::Stale
                                | MonitorStatus::Reconnecting
                        );
                    if !agent_owns_status {
                        // No fresh sample within the window: count a missed collect.
                        if loop_state.on_failure().is_some() {
                            // With the agent transport up, a missed sample is the
                            // agent going quiet, not a lost connection (#3301).
                            if alive {
                                loop_state.attribute(MonitorStatusReason::Silent);
                            }
                            let _ = status_tx.send(loop_state.update()).await;
                        }
                        // Sustained drop: if the agent transport itself is down,
                        // the agent-connection layer is re-establishing it, so
                        // surface Reconnecting rather than leaving the numbers
                        // merely dimmed.
                        if loop_state.should_begin_reconnect()
                            && !alive
                            && loop_state.begin_reconnect().is_some()
                        {
                            // The agent transport itself is down (#3301).
                            loop_state.attribute(MonitorStatusReason::Transport);
                            let _ = status_tx.send(loop_state.update()).await;
                        }
                    }
                    // Bounded Stale (#3321): with the transport up, an agent that
                    // stopped streaming has recovered or ended its loop within
                    // its recovery budget — resolve Offline rather than leave the
                    // badge Stale forever.
                    let bounded = alive
                        && (agent_owns_status || loop_state.status() == MonitorStatus::Stale);
                    if bounded {
                        silent = silent.saturating_add(freshness);
                        if silent >= agent_recovery_budget(interval) {
                            silent = Duration::ZERO;
                            if loop_state.exhaust_reconnect().is_some() {
                                // Transport up, yet no sample or report within the
                                // budget: the agent went silent (#3301).
                                loop_state.attribute(MonitorStatusReason::Silent);
                                warn!(
                                    budget_secs = agent_recovery_budget(interval).as_secs(),
                                    "Agent monitor sent no sample or status within its \
                                     recovery budget: Offline"
                                );
                                let _ = status_tx.send(loop_state.update()).await;
                            }
                        }
                    } else {
                        silent = Duration::ZERO;
                    }
                }
            },
        }
    }
}

/// Next agent status report, or pending forever once there is no channel.
async fn next_report(
    reports_rx: &mut Option<tokio::sync::mpsc::Receiver<MonitoringStatusNotification>>,
) -> Option<MonitoringStatusNotification> {
    match reports_rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

#[async_trait::async_trait]
impl MonitoringProvider for RemoteMonitoringProxy {
    async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError> {
        // Raw channel fed directly by the agent's monitoring notifications. A
        // status-derivation driver (below) is interposed between this and the
        // consumer so the reported `MonitorStatus` follows the *actual* sample
        // flow instead of a hardcoded `Live` (SM-012).
        let (raw_tx, raw_rx) = tokio::sync::mpsc::channel(MONITORING_CHANNEL_CAPACITY);

        // Register monitoring channel so agent_manager routes notifications to it.
        self.agent_manager
            .register_monitoring_output(&self.agent_id, &self.monitoring_host, raw_tx)
            .map_err(|e| CoreError::Other(e.to_string()))?;

        // Route the agent's own status reports (#3321). An older agent never
        // sends them; the driver then infers status from the sample flow alone.
        let (reports_tx, reports_rx) =
            tokio::sync::mpsc::channel(MONITORING_STATUS_CHANNEL_CAPACITY);
        if let Err(e) = self.agent_manager.register_monitoring_status_output(
            &self.agent_id,
            &self.monitoring_host,
            reports_tx,
        ) {
            warn!(
                host = %self.monitoring_host,
                error = %e,
                "Failed to route agent monitoring status reports; inferring status"
            );
        }

        // Send subscribe request to agent at the currently-configured cadence
        // (#1233); the frontend may later change it via `set_interval`.
        self.rpc(
            termihub_core::protocol::methods::CONNECTION_MONITORING_SUBSCRIBE,
            MonitoringSubscribeParams {
                host: self.monitoring_host.clone(),
                interval_ms: Some(self.interval_ms.load(Ordering::SeqCst)),
            },
        )
        .await?;

        // Consumer-facing channels. The driver forwards each fresh agent sample
        // onto `stats_tx` and drives `status_tx` from a `CollectLoopState`: a
        // sample arriving marks the loop `Live`; missing samples past the
        // freshness window mark it `Stale`; and once stale with the agent
        // transport down (reconnect underway) it reports `Reconnecting`. This
        // mirrors the direct-SSH provider's status machine (#1229/#1230) so a
        // mid-stream drop dims the numbers instead of freezing them as live.
        let (stats_tx, stats_rx) = tokio::sync::mpsc::channel(MONITORING_CHANNEL_CAPACITY);
        let (status_tx, status_rx) = tokio::sync::mpsc::channel(MONITORING_STATUS_CHANNEL_CAPACITY);

        let agent_manager = self.agent_manager.clone();
        let agent_id = self.agent_id.clone();
        let interval_ms = self.interval_ms.clone();
        let paused_rx = self.paused_tx.subscribe();
        tokio::spawn(drive_monitor_status(
            raw_rx,
            stats_tx,
            status_tx,
            interval_ms,
            Duration::from_millis(MONITORING_FRESHNESS_GRACE_MS),
            move || agent_manager.is_connected(&agent_id),
            paused_rx,
            reports_rx,
        ));

        Ok(MonitoringSubscription {
            stats: stats_rx,
            status: status_rx,
        })
    }

    async fn unsubscribe(&self) -> Result<(), CoreError> {
        // Unregister monitoring channel before telling the agent to stop.
        let _ = self
            .agent_manager
            .unregister_monitoring_output(&self.agent_id, &self.monitoring_host);

        self.rpc(
            termihub_core::protocol::methods::CONNECTION_MONITORING_UNSUBSCRIBE,
            MonitoringUnsubscribeParams {
                host: self.monitoring_host.clone(),
            },
        )
        .await?;
        Ok(())
    }

    async fn set_interval(&self, interval: std::time::Duration) {
        // The agent's `connection.monitoring.subscribe` replaces an existing
        // subscription, so re-issuing it with the new cadence changes the
        // interval in place (#1233). The output channel stays registered.
        let ms = (interval.as_millis() as u64).max(1);
        self.interval_ms.store(ms, Ordering::SeqCst);
        if let Err(e) = self
            .rpc(
                termihub_core::protocol::methods::CONNECTION_MONITORING_SUBSCRIBE,
                MonitoringSubscribeParams {
                    host: self.monitoring_host.clone(),
                    interval_ms: Some(ms),
                },
            )
            .await
        {
            warn!(host = %self.monitoring_host, error = %e, "Failed to update agent monitoring interval");
        }
    }

    async fn set_paused(&self, paused: bool) {
        // Propagate pause/resume to the agent so its remote poller actually
        // stops sampling/streaming while paused, instead of only being honoured
        // on the desktop (#3001). This reuses the existing subscribe/unsubscribe
        // verbs rather than inventing a parallel pause channel, so it is fully
        // back-compat: every agent already implements both.
        //
        // The desktop-side steering stays too (SM-013): while paused the
        // status-derivation driver holds the badge at `Paused` and drops any
        // sample still in flight, so the UI never desyncs from the "paused"
        // label even in the gap before the agent acts on the RPC (or if the RPC
        // fails against an unreachable agent). `send_replace` updates the value
        // even with no live subscriber (a later `subscribe` reads it).
        if paused {
            // Steer the desktop driver first so no late sample slips through,
            // then stop the remote poller. The output channel stays registered,
            // so a later resume routes fresh samples back to the same driver.
            self.paused_tx.send_replace(true);
            if let Err(e) = self
                .rpc(
                    termihub_core::protocol::methods::CONNECTION_MONITORING_UNSUBSCRIBE,
                    MonitoringUnsubscribeParams {
                        host: self.monitoring_host.clone(),
                    },
                )
                .await
            {
                warn!(
                    host = %self.monitoring_host,
                    error = %e,
                    "Failed to pause agent monitoring poller (desktop pause still honoured)"
                );
            }
        } else {
            // Restart the remote poller at the current cadence *before* resuming
            // the desktop driver, so fresh samples are already flowing when it
            // un-holds. The agent's `subscribe` replaces any existing
            // subscription, so this restarts the poller in place.
            if let Err(e) = self
                .rpc(
                    termihub_core::protocol::methods::CONNECTION_MONITORING_SUBSCRIBE,
                    MonitoringSubscribeParams {
                        host: self.monitoring_host.clone(),
                        interval_ms: Some(self.interval_ms.load(Ordering::SeqCst)),
                    },
                )
                .await
            {
                warn!(
                    host = %self.monitoring_host,
                    error = %e,
                    "Failed to resume agent monitoring poller"
                );
            }
            self.paused_tx.send_replace(false);
        }
        debug!(
            host = %self.monitoring_host,
            paused,
            "Agent-mediated monitor pause propagated to the agent poller (#3001)"
        );
    }

    async fn cancel_connect(&self) {
        // Cancelling an agent-mediated connect requires a protocol addition;
        // tracked as a follow-up to #1233. Unsubscribing already stops the loop.
        debug!(
            host = %self.monitoring_host,
            "Cancel not yet supported for agent-mediated monitoring (follow-up to #1233)"
        );
    }
}

/// Decode a base64 string to bytes.
fn base64_decode(input: &str) -> Result<Vec<u8>, FileError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| FileError::OperationFailed(format!("Base64 decode failed: {e}")))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::connection::config::AgentSettings;
    use crate::terminal::agent_manager::{
        AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
        AgentFolderInfo, AgentRpcClient, AgentSessionInfo,
    };
    use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
    use crate::utils::errors::TerminalError;
    use termihub_core::monitoring::MonitoringSender;

    // ── MockAgentRpcClient ────────────────────────────────────────────

    /// Minimal in-memory mock of `AgentRpcClient` for unit tests.
    ///
    /// `create_session` records calls and returns a canned session.
    /// All other mutating methods succeed silently. `is_connected` returns
    /// `true` once at least one `create_session` call has been recorded.
    struct MockAgentRpcClient {
        created_sessions: Mutex<Vec<(String, String, serde_json::Value)>>,
        /// Records the definition_id passed to each create_session call, in order.
        created_definition_ids: Mutex<Vec<Option<String>>>,
        send_request_result: Option<serde_json::Value>,
        /// Records (method, params) for every send_request call.
        sent_requests: Mutex<Vec<(String, serde_json::Value)>>,
        /// Records remote_session_id for every register_monitoring_output call.
        registered_monitoring_hosts: Mutex<Vec<String>>,
    }

    impl MockAgentRpcClient {
        fn new() -> Self {
            Self {
                created_sessions: Mutex::new(Vec::new()),
                created_definition_ids: Mutex::new(Vec::new()),
                send_request_result: None,
                sent_requests: Mutex::new(Vec::new()),
                registered_monitoring_hosts: Mutex::new(Vec::new()),
            }
        }

        fn with_capabilities(capabilities_result: serde_json::Value) -> Self {
            Self {
                created_sessions: Mutex::new(Vec::new()),
                created_definition_ids: Mutex::new(Vec::new()),
                send_request_result: Some(capabilities_result),
                sent_requests: Mutex::new(Vec::new()),
                registered_monitoring_hosts: Mutex::new(Vec::new()),
            }
        }
    }

    impl AgentRpcClient for MockAgentRpcClient {
        fn connect_agent(
            &self,
            _agent_id: &str,
            _config: &RemoteAgentConfig,
            _agent_settings: Option<&AgentSettings>,
        ) -> Result<AgentConnectResult, TerminalError> {
            Ok(AgentConnectResult {
                capabilities: AgentCapabilities {
                    connection_types: vec![],
                    max_sessions: 10,
                    available_shells: vec![],
                    available_serial_ports: vec![],
                    docker_available: false,
                    available_docker_images: vec![],
                    monitoring_supported: false,
                    agent_version: "mock".to_string(),
                },
                agent_version: "mock".to_string(),
                protocol_version: "0.2.0".to_string(),
            })
        }

        fn cancel_connect(&self, _agent_id: &str) -> bool {
            false
        }
        fn disconnect_agent(&self, _agent_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }

        fn is_connected(&self, _agent_id: &str) -> bool {
            !self.created_sessions.lock().unwrap().is_empty()
        }

        fn get_capabilities(&self, _agent_id: &str) -> Option<AgentCapabilities> {
            None
        }

        fn shutdown_agent(
            &self,
            _agent_id: &str,
            _reason: Option<&str>,
        ) -> Result<u32, TerminalError> {
            Ok(0)
        }

        fn send_request(
            &self,
            _agent_id: &str,
            method: &str,
            params: serde_json::Value,
        ) -> Result<serde_json::Value, TerminalError> {
            self.sent_requests
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            Ok(self
                .send_request_result
                .clone()
                .unwrap_or(serde_json::Value::Null))
        }

        fn create_session(
            &self,
            agent_id: &str,
            session_type: &str,
            config: serde_json::Value,
            _title: Option<&str>,
            definition_id: Option<&str>,
        ) -> Result<AgentSessionInfo, TerminalError> {
            self.created_sessions.lock().unwrap().push((
                agent_id.to_string(),
                session_type.to_string(),
                config,
            ));
            self.created_definition_ids
                .lock()
                .unwrap()
                .push(definition_id.map(String::from));
            Ok(AgentSessionInfo {
                session_id: "mock-session-1".to_string(),
                title: "Mock Session".to_string(),
                session_type: session_type.to_string(),
                status: "running".to_string(),
                attached: false,
                definition_id: definition_id.map(String::from),
            })
        }

        fn attach_session(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            Ok(())
        }

        fn close_session(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            Ok(())
        }

        fn list_sessions(&self, _agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
            Ok(vec![])
        }

        fn list_connections_and_folders(
            &self,
            _agent_id: &str,
        ) -> Result<AgentConnectionsData, TerminalError> {
            Ok(AgentConnectionsData {
                connections: vec![],
                folders: vec![],
            })
        }

        fn list_definitions(
            &self,
            _agent_id: &str,
        ) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
            Ok(vec![])
        }

        fn save_definition(
            &self,
            _agent_id: &str,
            _definition: termihub_core::protocol::methods::ConnectionCreateParams,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            Ok(AgentDefinitionInfo {
                id: "mock-def".to_string(),
                name: "Mock".to_string(),
                session_type: "local".to_string(),
                config: serde_json::Value::Null,
                persistent: false,
                folder_id: None,
                terminal_options: None,
                icon: None,
                source_file: None,
            })
        }

        fn update_definition(
            &self,
            _agent_id: &str,
            _params: termihub_core::protocol::methods::ConnectionUpdateParams,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            Ok(AgentDefinitionInfo {
                id: "mock-def".to_string(),
                name: "Updated".to_string(),
                session_type: "local".to_string(),
                config: serde_json::Value::Null,
                persistent: false,
                folder_id: None,
                terminal_options: None,
                icon: None,
                source_file: None,
            })
        }

        fn delete_definition(&self, _agent_id: &str, _def_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }

        fn create_folder(
            &self,
            _agent_id: &str,
            _name: &str,
            _parent_id: Option<&str>,
        ) -> Result<AgentFolderInfo, TerminalError> {
            Ok(AgentFolderInfo {
                id: "mock-folder".to_string(),
                name: "Mock Folder".to_string(),
                parent_id: None,
                is_expanded: false,
            })
        }

        fn update_folder(
            &self,
            _agent_id: &str,
            _params: termihub_core::protocol::methods::FolderUpdateParams,
        ) -> Result<AgentFolderInfo, TerminalError> {
            Ok(AgentFolderInfo {
                id: "mock-folder".to_string(),
                name: "Updated Folder".to_string(),
                parent_id: None,
                is_expanded: false,
            })
        }

        fn delete_folder(&self, _agent_id: &str, _folder_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }

        fn register_session_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _output_tx: OutputSender,
        ) -> Result<(), TerminalError> {
            Ok(())
        }

        fn unregister_session_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            Ok(())
        }

        fn register_monitoring_output(
            &self,
            _agent_id: &str,
            remote_session_id: &str,
            _monitoring_tx: MonitoringSender,
        ) -> Result<(), TerminalError> {
            self.registered_monitoring_hosts
                .lock()
                .unwrap()
                .push(remote_session_id.to_string());
            Ok(())
        }

        fn unregister_monitoring_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            Ok(())
        }

        fn send_session_input(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _data: &[u8],
        ) -> Result<(), TerminalError> {
            Ok(())
        }

        fn resize_session(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _cols: u16,
            _rows: u16,
        ) -> Result<(), TerminalError> {
            Ok(())
        }

        fn apply_agent_settings(
            &self,
            _agent_id: &str,
            _settings: &AgentSettings,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
    }

    fn make_proxy() -> RemoteProxy {
        RemoteProxy::new("agent-1".to_string(), Arc::new(MockAgentRpcClient::new()))
    }

    // ── Compile-time trait checks ─────────────────────────────────────

    fn _assert_send<T: Send>() {}

    #[test]
    fn remote_proxy_is_send() {
        _assert_send::<RemoteProxy>();
    }

    #[test]
    fn remote_file_browser_proxy_is_send() {
        _assert_send::<RemoteFileBrowserProxy>();
    }

    #[test]
    fn remote_monitoring_proxy_is_send() {
        _assert_send::<RemoteMonitoringProxy>();
    }

    fn _assert_file_browser_compiles(proxy: &RemoteProxy) {
        let _: Option<&dyn FileBrowser> = proxy.file_browser();
        let _: Option<&dyn MonitoringProvider> = proxy.monitoring();
    }

    // ── Behaviour tests using MockAgentRpcClient ──────────────────────

    #[test]
    fn new_proxy_is_not_connected() {
        let proxy = make_proxy();
        assert!(!proxy.is_connected());
    }

    #[tokio::test]
    async fn connect_calls_create_and_attach_session() {
        let mock = Arc::new(MockAgentRpcClient::new());
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());

        let settings = json!({ "type": "local", "config": {} });
        proxy
            .connect(settings)
            .await
            .expect("connect should succeed");

        let sessions = mock.created_sessions.lock().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].0, "agent-1");
        assert_eq!(sessions[0].1, "local");
    }

    /// `SessionManager::create_connection` wraps the frontend's settings under a
    /// `config` key before calling `RemoteProxy::connect`, so `definitionId` (set
    /// by the frontend alongside `title` and the connection's own settings) lives
    /// at `settings.config.definitionId`, not at the top level. This regression
    /// test pins the lookup so the agent reattach path (which depends on the
    /// agent storing definition_id) stays wired up.
    #[tokio::test]
    async fn connect_forwards_definition_id_from_wrapped_settings() {
        let mock = Arc::new(MockAgentRpcClient::new());
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());

        let settings = json!({
            "type": "local",
            "config": {
                "shell": "/bin/zsh",
                "title": "Build Shell",
                "definitionId": "def-42",
            },
        });
        proxy
            .connect(settings)
            .await
            .expect("connect should succeed");

        let ids = mock.created_definition_ids.lock().unwrap();
        assert_eq!(ids.as_slice(), &[Some("def-42".to_string())]);
    }

    #[tokio::test]
    async fn connect_forwards_no_definition_id_when_absent() {
        let mock = Arc::new(MockAgentRpcClient::new());
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());

        let settings = json!({ "type": "local", "config": { "shell": "/bin/zsh" } });
        proxy
            .connect(settings)
            .await
            .expect("connect should succeed");

        let ids = mock.created_definition_ids.lock().unwrap();
        assert_eq!(ids.as_slice(), &[None]);
    }

    #[tokio::test]
    async fn connect_twice_returns_error() {
        let mut proxy = make_proxy();
        let settings = json!({ "type": "local", "config": {} });
        proxy
            .connect(settings.clone())
            .await
            .expect("first connect");
        let result = proxy.connect(settings).await;
        assert!(result.is_err(), "second connect should fail");

        proxy.disconnect().await.ok();
    }

    #[tokio::test]
    async fn disconnect_clears_connected_state() {
        let mut proxy = make_proxy();
        let settings = json!({ "type": "local", "config": {} });
        proxy.connect(settings).await.expect("connect");

        proxy.disconnect().await.expect("disconnect");

        // is_connected checks both local flag and mock.is_connected()
        // After disconnect the local flag is false.
        assert!(!proxy.is_connected());
    }

    #[tokio::test]
    async fn write_after_connect_succeeds() {
        let mut proxy = make_proxy();
        proxy
            .connect(json!({ "type": "local", "config": {} }))
            .await
            .expect("connect");

        let result = proxy.write(b"hello");
        assert!(result.is_ok());

        proxy.disconnect().await.ok();
    }

    #[tokio::test]
    async fn resize_after_connect_succeeds() {
        let mut proxy = make_proxy();
        proxy
            .connect(json!({ "type": "local", "config": {} }))
            .await
            .expect("connect");

        let result = proxy.resize(120, 40);
        assert!(result.is_ok());

        proxy.disconnect().await.ok();
    }

    #[test]
    fn write_before_connect_returns_error() {
        let proxy = make_proxy();
        assert!(proxy.write(b"data").is_err());
    }

    #[test]
    fn resize_before_connect_returns_error() {
        let proxy = make_proxy();
        assert!(proxy.resize(80, 24).is_err());
    }

    /// Build a mock client that responds to `connection.types` with monitoring=true for "local".
    fn make_mock_with_local_monitoring() -> Arc<MockAgentRpcClient> {
        Arc::new(MockAgentRpcClient::with_capabilities(json!({
            "types": [
                {
                    "typeId": "local",
                    "displayName": "Local Shell",
                    "icon": "terminal",
                    "schema": {"groups": []},
                    "capabilities": {
                        "monitoring": true,
                        "fileBrowser": false,
                        "resize": true,
                        "persistent": false
                    }
                }
            ]
        })))
    }

    #[tokio::test]
    async fn monitoring_proxy_uses_self_for_local_session() {
        let mock = make_mock_with_local_monitoring();
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());

        proxy
            .connect(json!({ "type": "local", "config": {} }))
            .await
            .expect("connect should succeed");

        // Monitoring should be available.
        assert!(
            proxy.monitoring().is_some(),
            "monitoring() should return Some for local session with monitoring capability"
        );

        // Subscribe — this sends monitoring subscribe to agent.
        let _rx = proxy
            .monitoring()
            .unwrap()
            .subscribe()
            .await
            .expect("subscribe should succeed");

        // The host registered and sent to the agent must be "self".
        {
            let registered = mock.registered_monitoring_hosts.lock().unwrap();
            assert_eq!(
                registered.as_slice(),
                ["self"],
                "local session monitoring should register under 'self'"
            );
        }

        {
            let sent = mock.sent_requests.lock().unwrap();
            let subscribe_req = sent
                .iter()
                .find(|(m, _)| m == "connection.monitoring.subscribe")
                .expect("subscribe request should have been sent");
            assert_eq!(
                subscribe_req.1["host"].as_str(),
                Some("self"),
                "subscribe request host must be 'self' for local session"
            );
        }

        proxy.disconnect().await.ok();
    }

    /// #3001: pausing an agent-hosted monitor must propagate to the agent so its
    /// remote poller stops sampling/streaming — not merely be honoured on the
    /// desktop. Resuming must re-subscribe the agent to restart the poller. The
    /// fix reuses the existing subscribe/unsubscribe verbs (every agent already
    /// implements them), so it needs no protocol addition and stays back-compat.
    /// Before the fix `set_paused` sent no RPC at all, so the agent kept polling.
    #[tokio::test]
    async fn pausing_agent_monitor_stops_remote_poller_and_resume_restarts_it() {
        let mock = Arc::new(MockAgentRpcClient::new());
        let proxy = RemoteMonitoringProxy::for_agent_self("agent-1".to_string(), mock.clone());

        // Pause: the agent's poller must be told to stop so it stops wasting
        // remote CPU/bandwidth while paused.
        proxy.set_paused(true).await;
        {
            let sent = mock.sent_requests.lock().unwrap();
            assert!(
                sent.iter().any(|(m, p)| m == "connection.monitoring.unsubscribe"
                    && p["host"].as_str() == Some("self")),
                "pausing an agent monitor must send unsubscribe to stop the remote poller, got: {sent:?}"
            );
        }

        // Resume: the agent must be re-subscribed so its poller restarts.
        proxy.set_paused(false).await;
        {
            let sent = mock.sent_requests.lock().unwrap();
            assert!(
                sent.iter().any(|(m, p)| m == "connection.monitoring.subscribe"
                    && p["host"].as_str() == Some("self")),
                "resuming an agent monitor must re-subscribe to restart the remote poller, got: {sent:?}"
            );
        }
    }

    #[tokio::test]
    async fn monitoring_proxy_uses_session_id_for_ssh_session() {
        let mock = Arc::new(MockAgentRpcClient::with_capabilities(json!({
            "types": [
                {
                    "typeId": "ssh",
                    "displayName": "SSH",
                    "icon": "ssh",
                    "schema": {"groups": []},
                    "capabilities": {
                        "monitoring": true,
                        "fileBrowser": false,
                        "resize": true,
                        "persistent": true
                    }
                }
            ]
        })));
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());

        proxy
            .connect(json!({ "type": "ssh", "config": {"host": "server", "port": 22} }))
            .await
            .expect("connect should succeed");

        assert!(proxy.monitoring().is_some());

        let _rx = proxy
            .monitoring()
            .unwrap()
            .subscribe()
            .await
            .expect("subscribe should succeed");

        // For non-local sessions, host should be the remote session ID.
        {
            let registered = mock.registered_monitoring_hosts.lock().unwrap();
            assert_eq!(registered.len(), 1);
            assert_ne!(
                registered[0], "self",
                "ssh session monitoring should NOT register under 'self'"
            );
            assert_eq!(
                registered[0], "mock-session-1",
                "ssh session should use the remote session ID"
            );
        }

        proxy.disconnect().await.ok();
    }

    /// The frontend sends `type: "shell"` but the agent normalises it to `"local"`.
    /// The desktop must map "shell" → "local" when looking up capabilities so that
    /// monitoring is enabled and the host is set to "self".
    #[tokio::test]
    async fn monitoring_proxy_uses_self_for_shell_alias() {
        let mock = make_mock_with_local_monitoring();
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());

        // Frontend passes "shell" as the type (the common alias).
        proxy
            .connect(json!({ "type": "shell", "config": {} }))
            .await
            .expect("connect should succeed");

        assert!(
            proxy.monitoring().is_some(),
            "monitoring() should return Some when type is 'shell' (alias for 'local')"
        );

        let _rx = proxy
            .monitoring()
            .unwrap()
            .subscribe()
            .await
            .expect("subscribe should succeed");

        let registered = mock.registered_monitoring_hosts.lock().unwrap();
        assert_eq!(
            registered.as_slice(),
            ["self"],
            "'shell' session monitoring should register under 'self' (same as 'local')"
        );
    }

    // ── Regression: blocking_recv must not deadlock on a tokio worker ─

    /// Mock that faithfully reproduces the real `AgentConnectionManager`
    /// response delivery: `create_session` blocks on a `oneshot::Receiver`
    /// whose value is sent by a separate `tokio::spawn`ed task.
    ///
    /// The real `agent_io_task` runs as a tokio task and delivers responses
    /// across task boundaries the same way. If a caller invokes
    /// `create_session` directly from an async tokio task (instead of inside
    /// `spawn_blocking`), the `Receiver::blocking_recv()` parks the current
    /// runtime worker; in that scenario the cross-task `tx.send` wake can
    /// fail to re-schedule the parked worker and the await hangs forever —
    /// the exact symptom that prompted this regression test.
    struct BlockingRecvMockAgentRpcClient;

    impl AgentRpcClient for BlockingRecvMockAgentRpcClient {
        fn connect_agent(
            &self,
            _agent_id: &str,
            _config: &RemoteAgentConfig,
            _agent_settings: Option<&AgentSettings>,
        ) -> Result<AgentConnectResult, TerminalError> {
            unimplemented!()
        }
        fn cancel_connect(&self, _agent_id: &str) -> bool {
            false
        }
        fn disconnect_agent(&self, _agent_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn is_connected(&self, _agent_id: &str) -> bool {
            true
        }
        fn get_capabilities(&self, _agent_id: &str) -> Option<AgentCapabilities> {
            None
        }
        fn shutdown_agent(
            &self,
            _agent_id: &str,
            _reason: Option<&str>,
        ) -> Result<u32, TerminalError> {
            Ok(0)
        }

        fn send_request(
            &self,
            _agent_id: &str,
            _method: &str,
            _params: serde_json::Value,
        ) -> Result<serde_json::Value, TerminalError> {
            cross_task_blocking_recv(serde_json::Value::Null)
        }

        fn create_session(
            &self,
            _agent_id: &str,
            session_type: &str,
            _config: serde_json::Value,
            _title: Option<&str>,
            _definition_id: Option<&str>,
        ) -> Result<AgentSessionInfo, TerminalError> {
            cross_task_blocking_recv(AgentSessionInfo {
                session_id: "mock-session-1".to_string(),
                title: "Mock Session".to_string(),
                session_type: session_type.to_string(),
                status: "running".to_string(),
                attached: false,
                definition_id: None,
            })
        }

        fn attach_session(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            cross_task_blocking_recv(())
        }

        fn close_session(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            cross_task_blocking_recv(())
        }

        fn list_sessions(&self, _agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
            Ok(vec![])
        }
        fn list_connections_and_folders(
            &self,
            _agent_id: &str,
        ) -> Result<AgentConnectionsData, TerminalError> {
            Ok(AgentConnectionsData {
                connections: vec![],
                folders: vec![],
            })
        }
        fn list_definitions(
            &self,
            _agent_id: &str,
        ) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
            Ok(vec![])
        }
        fn save_definition(
            &self,
            _agent_id: &str,
            _definition: termihub_core::protocol::methods::ConnectionCreateParams,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn update_definition(
            &self,
            _agent_id: &str,
            _params: termihub_core::protocol::methods::ConnectionUpdateParams,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_definition(&self, _agent_id: &str, _def_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn create_folder(
            &self,
            _agent_id: &str,
            _name: &str,
            _parent_id: Option<&str>,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn update_folder(
            &self,
            _agent_id: &str,
            _params: termihub_core::protocol::methods::FolderUpdateParams,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_folder(&self, _agent_id: &str, _folder_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn register_session_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _output_tx: OutputSender,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn unregister_session_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn register_monitoring_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _monitoring_tx: MonitoringSender,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn unregister_monitoring_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn send_session_input(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _data: &[u8],
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn resize_session(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _cols: u16,
            _rows: u16,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn apply_agent_settings(
            &self,
            _agent_id: &str,
            _settings: &AgentSettings,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
    }

    /// Helper used by `BlockingRecvMockAgentRpcClient` to reproduce the
    /// `agent_manager::send_request` blocking pattern: spawn a tokio task
    /// that fulfils a oneshot after a short delay, then call `blocking_recv`
    /// on the calling thread. Mirrors what the real agent_io_task does.
    fn cross_task_blocking_recv<T: Send + 'static>(value: T) -> Result<T, TerminalError> {
        let (tx, rx) = tokio::sync::oneshot::channel::<T>();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            let _ = tx.send(value);
        });
        rx.blocking_recv()
            .map_err(|_| TerminalError::RemoteError("oneshot dropped".to_string()))
    }

    /// Regression for the local-agent shell hang: `RemoteProxy::connect`
    /// invokes sync `agent_manager` helpers that internally call
    /// `oneshot::Receiver::blocking_recv`. When invoked directly from an
    /// async tokio task on a single-worker multi-thread runtime, the call
    /// hangs because the parked worker cannot service the task that
    /// completes the oneshot. The fix wraps each blocking call in
    /// `tokio::task::spawn_blocking`, which runs on the dedicated blocking
    /// thread pool. We exercise the pattern on a `worker_threads = 1`
    /// runtime so that the deadlock is forced if the fix regresses.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn connect_does_not_deadlock_on_blocking_recv() {
        let mock = Arc::new(BlockingRecvMockAgentRpcClient);
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock);

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            proxy.connect(json!({ "type": "local", "config": {} })),
        )
        .await;

        assert!(
            result.is_ok(),
            "RemoteProxy::connect must complete without deadlocking on cross-task oneshot wake-ups"
        );
        result
            .unwrap()
            .expect("connect should succeed against the blocking-recv mock");
    }

    // ── Regression #1122: cancel must abort the remote-proxy handshake ─

    /// Mock whose `attach_session` blocks until the test releases it, so a
    /// cancellation can fire *during* the handshake. `create_session` returns a
    /// session immediately (recording the assigned remote session ID), and every
    /// `close_session` call is recorded so the test can assert the partially
    /// established session was torn down (no orphan).
    struct HangingAttachMockAgentRpcClient {
        /// Held by the mock so a (never-reached-on-cancel) attach can block on it.
        attach_gate: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>>,
        /// Remote session IDs passed to `close_session`, in order.
        closed_sessions: std::sync::Mutex<Vec<String>>,
    }

    impl HangingAttachMockAgentRpcClient {
        fn new(attach_gate: std::sync::mpsc::Receiver<()>) -> Self {
            Self {
                attach_gate: std::sync::Mutex::new(Some(attach_gate)),
                closed_sessions: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    impl AgentRpcClient for HangingAttachMockAgentRpcClient {
        fn connect_agent(
            &self,
            _agent_id: &str,
            _config: &RemoteAgentConfig,
            _agent_settings: Option<&AgentSettings>,
        ) -> Result<AgentConnectResult, TerminalError> {
            unimplemented!()
        }
        fn cancel_connect(&self, _agent_id: &str) -> bool {
            false
        }
        fn disconnect_agent(&self, _agent_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn is_connected(&self, _agent_id: &str) -> bool {
            true
        }
        fn get_capabilities(&self, _agent_id: &str) -> Option<AgentCapabilities> {
            None
        }
        fn shutdown_agent(
            &self,
            _agent_id: &str,
            _reason: Option<&str>,
        ) -> Result<u32, TerminalError> {
            Ok(0)
        }
        fn send_request(
            &self,
            _agent_id: &str,
            _method: &str,
            _params: serde_json::Value,
        ) -> Result<serde_json::Value, TerminalError> {
            Ok(serde_json::Value::Null)
        }
        fn create_session(
            &self,
            _agent_id: &str,
            session_type: &str,
            _config: serde_json::Value,
            _title: Option<&str>,
            _definition_id: Option<&str>,
        ) -> Result<AgentSessionInfo, TerminalError> {
            Ok(AgentSessionInfo {
                session_id: "mock-session-1".to_string(),
                title: "Mock Session".to_string(),
                session_type: session_type.to_string(),
                status: "running".to_string(),
                attached: false,
                definition_id: None,
            })
        }
        fn attach_session(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            // Block until the test releases the gate. On cancellation the caller
            // aborts the wrapping future, so this blocking call never returns a
            // successful attach and the gate is simply dropped.
            if let Some(gate) = self.attach_gate.lock().unwrap().take() {
                let _ = gate.recv();
            }
            Ok(())
        }
        fn close_session(
            &self,
            _agent_id: &str,
            remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            self.closed_sessions
                .lock()
                .unwrap()
                .push(remote_session_id.to_string());
            Ok(())
        }
        fn list_sessions(&self, _agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
            Ok(vec![])
        }
        fn list_connections_and_folders(
            &self,
            _agent_id: &str,
        ) -> Result<AgentConnectionsData, TerminalError> {
            Ok(AgentConnectionsData {
                connections: vec![],
                folders: vec![],
            })
        }
        fn list_definitions(
            &self,
            _agent_id: &str,
        ) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
            Ok(vec![])
        }
        fn save_definition(
            &self,
            _agent_id: &str,
            _definition: termihub_core::protocol::methods::ConnectionCreateParams,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn update_definition(
            &self,
            _agent_id: &str,
            _params: termihub_core::protocol::methods::ConnectionUpdateParams,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_definition(&self, _agent_id: &str, _def_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn create_folder(
            &self,
            _agent_id: &str,
            _name: &str,
            _parent_id: Option<&str>,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn update_folder(
            &self,
            _agent_id: &str,
            _params: termihub_core::protocol::methods::FolderUpdateParams,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_folder(&self, _agent_id: &str, _folder_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn register_session_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _output_tx: OutputSender,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn unregister_session_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn register_monitoring_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _monitoring_tx: MonitoringSender,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn unregister_monitoring_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn send_session_input(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _data: &[u8],
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn resize_session(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _cols: u16,
            _rows: u16,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn apply_agent_settings(
            &self,
            _agent_id: &str,
            _settings: &AgentSettings,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
    }

    /// Regression for #1122: cancelling the token mid-handshake aborts the
    /// remote-proxy connect. The proxy must return an error, must NOT report
    /// itself connected, and must tear down the session it created on the agent
    /// so no orphan is left behind.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn connect_cancellable_aborts_handshake_and_cleans_up() {
        use tokio_util::sync::CancellationToken;

        // The gate is never released, so `attach_session` hangs until cancel.
        let (_gate_tx, gate_rx) = std::sync::mpsc::channel::<()>();
        let mock = Arc::new(HangingAttachMockAgentRpcClient::new(gate_rx));
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());

        let token = CancellationToken::new();

        // Fire the cancel shortly after connect begins, while attach is blocked.
        let cancel_token = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            cancel_token.cancel();
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            proxy.connect_cancellable(json!({ "type": "local", "config": {} }), Some(token)),
        )
        .await
        .expect("connect_cancellable must not hang after cancellation");

        assert!(
            result.is_err(),
            "a cancelled remote connect must return an error"
        );
        assert!(
            !proxy.is_connected(),
            "a cancelled remote connect must not leave the proxy connected"
        );
        assert!(
            proxy.remote_session_id().is_none(),
            "a cancelled remote connect must not retain a remote session ID"
        );

        // The session created on the agent must be torn down (no orphan). The
        // proxy created "mock-session-1" and must close it on cancel.
        let closed = mock.closed_sessions.lock().unwrap();
        assert!(
            closed.iter().any(|s| s == "mock-session-1"),
            "the partially established remote session must be closed on cancel, got: {closed:?}"
        );
    }

    // ── connection.files.* wire-contract round-trip (AGT-001, AGT-009, TBE-009) ──
    //
    // The desktop hand-builds the `connection.files.*` request params in
    // `files_params` with no compile-time link to the agent's parameter structs
    // (`termihub_agent::protocol::methods`). These tests serialize each desktop
    // request and deserialize it into the agent's real struct — a serde
    // round-trip that fails to compile-or-parse the moment the two sides drift.
    // They need no live agent and no Docker, so they gate every PR (the live
    // agent path only runs in the dark nightly integration lane, TBE-009).
    //
    // Before the fix these fail: `rename` sent `{from,to}` (agent requires
    // `old_path`/`new_path`) and `delete` omitted the required `isDirectory`
    // and sent snake `connection_id` where the camelCase-only `FilesDeleteParams`
    // expects `connectionId` (AGT-001, AGT-009).
    mod wire_contract {
        use super::super::{files_params, processes_params};
        use serde_json::json;
        use termihub_core::monitoring::KillSignal;

        const CONN: &str = "session-42";
        const PATH: &str = "/home/user/file.txt";

        // DUP-001: the builders return the shared `core::protocol::methods` param
        // DTOs (the agent deserializes the same types). Each test pins the wire by
        // comparing `to_value(<builder>)` with the exact pre-migration hand-built
        // `json!` — a change is a WIRE BREAK.

        #[test]
        fn processes_list_params_match_hand_built_json() {
            assert_eq!(
                serde_json::to_value(processes_params::list(Some(CONN))).unwrap(),
                json!({ "connection_id": CONN }),
            );
            // The local (`None`) scope stays a JSON `null`, not a string.
            assert_eq!(
                serde_json::to_value(processes_params::list(None)).unwrap(),
                json!({ "connection_id": null }),
            );
        }

        #[test]
        fn process_kill_params_match_hand_built_json() {
            assert_eq!(
                serde_json::to_value(processes_params::kill(Some(CONN), 4321, KillSignal::Kill))
                    .unwrap(),
                json!({ "connection_id": CONN, "pid": 4321, "signal": "kill" }),
            );
        }

        #[test]
        fn rename_params_match_hand_built_json() {
            assert_eq!(
                serde_json::to_value(files_params::rename(CONN, "/old/name.txt", "/new/name.txt"))
                    .unwrap(),
                json!({
                    "connection_id": CONN,
                    "old_path": "/old/name.txt",
                    "new_path": "/new/name.txt",
                }),
            );
        }

        #[test]
        fn delete_params_match_hand_built_json() {
            // `FilesDeleteParams` is the camelCase outlier: connectionId/isDirectory.
            assert_eq!(
                serde_json::to_value(files_params::delete(CONN, PATH)).unwrap(),
                json!({ "connectionId": CONN, "path": PATH, "isDirectory": false }),
            );
        }

        #[test]
        fn list_read_write_stat_mkdir_params_match_hand_built_json() {
            assert_eq!(
                serde_json::to_value(files_params::list(CONN, PATH)).unwrap(),
                json!({ "connection_id": CONN, "path": PATH }),
            );
            assert_eq!(
                serde_json::to_value(files_params::read(CONN, PATH)).unwrap(),
                json!({ "connection_id": CONN, "path": PATH }),
            );
            assert_eq!(
                serde_json::to_value(files_params::write(CONN, PATH, "ZGF0YQ==")).unwrap(),
                json!({ "connection_id": CONN, "path": PATH, "data": "ZGF0YQ==" }),
            );
            assert_eq!(
                serde_json::to_value(files_params::stat(CONN, PATH)).unwrap(),
                json!({ "connection_id": CONN, "path": PATH }),
            );
            assert_eq!(
                serde_json::to_value(files_params::mkdir(CONN, PATH)).unwrap(),
                json!({ "connection_id": CONN, "path": PATH }),
            );
        }

        #[test]
        fn set_permissions_params_match_hand_built_json() {
            assert_eq!(
                serde_json::to_value(files_params::set_permissions(CONN, PATH, 0o755)).unwrap(),
                json!({ "connection_id": CONN, "path": PATH, "mode": 0o755 }),
            );
        }

        #[test]
        fn set_owner_params_match_hand_built_json() {
            assert_eq!(
                serde_json::to_value(files_params::set_owner(CONN, PATH, Some(1000), Some(50)))
                    .unwrap(),
                json!({ "connection_id": CONN, "path": PATH, "uid": 1000, "gid": 50 }),
            );
            // A `None` side stays a JSON `null` (owner component left unchanged).
            assert_eq!(
                serde_json::to_value(files_params::set_owner(CONN, PATH, None, Some(50))).unwrap(),
                json!({ "connection_id": CONN, "path": PATH, "uid": null, "gid": 50 }),
            );
        }

        #[test]
        fn create_symlink_params_match_hand_built_json() {
            assert_eq!(
                serde_json::to_value(files_params::create_symlink(CONN, "/real", "/link")).unwrap(),
                json!({ "connection_id": CONN, "target": "/real", "link_path": "/link" }),
            );
        }

        #[test]
        fn copy_params_match_hand_built_json() {
            assert_eq!(
                serde_json::to_value(files_params::copy(CONN, "/a", "/b")).unwrap(),
                json!({ "connection_id": CONN, "src": "/a", "dest": "/b" }),
            );
        }
    }

    // ── Agent-mediated monitor status derivation (SM-012) ──────────────

    mod status_driver {
        use std::sync::atomic::AtomicU64;
        use std::sync::Arc;
        use std::time::Duration;

        use tokio::sync::mpsc;

        use super::super::drive_monitor_status;
        use termihub_core::monitoring::{
            agent_recovery_budget, CollectLoopState, MonitorStatus, MonitorStatusReason,
            MonitorStatusReceiver, MonitorStatusUpdate, SystemStats,
        };
        use termihub_core::protocol::methods::MonitoringStatusNotification;

        /// A reports channel whose sender is already gone: an older agent (or
        /// client) that never reports status (#3321).
        fn no_reports() -> mpsc::Receiver<MonitoringStatusNotification> {
            mpsc::channel(1).1
        }

        fn report(
            status: MonitorStatus,
            reason: Option<MonitorStatusReason>,
        ) -> MonitoringStatusNotification {
            MonitoringStatusNotification {
                host: "self".to_string(),
                status,
                reason,
            }
        }

        /// Await the next status transition within a (paused-clock) deadline
        /// long enough to cover the agent recovery budget.
        async fn next_status_within(
            rx: &mut MonitorStatusReceiver,
            deadline: Duration,
        ) -> MonitorStatus {
            next_update_within(rx, deadline).await.status
        }

        /// Like [`next_status_within`], but the whole update (status + reason).
        async fn next_update_within(
            rx: &mut MonitorStatusReceiver,
            deadline: Duration,
        ) -> MonitorStatusUpdate {
            tokio::time::timeout(deadline, rx.recv())
                .await
                .expect("a status transition should arrive before the deadline")
                .expect("status channel should stay open")
        }

        /// Test cadence: 20 ms interval + 30 ms grace = 50 ms freshness windows.
        const INTERVAL_MS: u64 = 20;
        const GRACE: Duration = Duration::from_millis(30);
        const WINDOW: Duration = Duration::from_millis(50);

        /// A syntactically valid stats sample (values are irrelevant to the
        /// status logic — only that a sample *arrived*).
        fn sample() -> SystemStats {
            SystemStats {
                hostname: "agent-host".to_string(),
                uptime_seconds: 1.0,
                load_average: [0.1, 0.1, 0.1],
                cpu_usage_percent: 5.0,
                memory_total_kb: 16_000_000,
                memory_available_kb: 12_000_000,
                memory_used_percent: 25.0,
                disk_total_kb: 50_000_000,
                disk_used_kb: 20_000_000,
                disk_used_percent: 40.0,
                os_info: "Linux".to_string(),
                swap_total_kb: 2_000_000,
                swap_used_kb: 500_000,
                swap_used_percent: 25.0,
                net_rx_bytes_per_sec: 1024.0,
                net_tx_bytes_per_sec: 512.0,
                per_core_cpu_percent: vec![25.0, 75.0],
            }
        }

        /// Await the next status transition, failing if none arrives in time.
        async fn next_status(rx: &mut MonitorStatusReceiver) -> MonitorStatus {
            next_update(rx).await.status
        }

        /// Await the next status update (status + reason, #3301).
        async fn next_update(rx: &mut MonitorStatusReceiver) -> MonitorStatusUpdate {
            next_update_within(rx, Duration::from_secs(5)).await
        }

        /// SM-012: while samples flow the monitor is `Live`; when the agent
        /// samples stop (a mid-stream drop) the derived status flips to `Stale`
        /// — it does NOT stay frozen at `Live`. The old code hardcoded `Live`
        /// and emitted it exactly once, so the `Stale` assertion below is the
        /// one it could never satisfy.
        #[tokio::test]
        async fn samples_flowing_is_live_then_drop_is_stale_not_frozen_live() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, mut stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            // Tight interval + grace so the freshness window is short in tests.
            let interval = Arc::new(AtomicU64::new(20));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                Duration::from_millis(30),
                || true, // transport stays up: a merely-slow agent, not a drop
                paused_rx,
                no_reports(),
            ));

            // A fresh sample: the monitor reports Live and forwards the sample.
            raw_tx.send(sample()).await.expect("send sample");
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Live,
                "a fresh agent sample must report Live"
            );
            assert!(
                stats_rx.recv().await.is_some(),
                "the sample must be forwarded to the consumer"
            );

            // Stop sending samples: the freshness timeout must surface Stale
            // (DEFAULT_STALE_THRESHOLD = 2 missed windows), not frozen Live.
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Stale,
                "a stalled agent sample stream must report Stale, not frozen Live"
            );

            drop(raw_tx);
            handle
                .await
                .expect("driver task should end when raw channel closes");
        }

        /// SM-012: when the agent *transport* is down (reconnect underway), a
        /// sustained sample drop escalates past `Stale` to `Reconnecting`.
        #[tokio::test]
        async fn transport_down_escalates_stale_to_reconnecting() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(20));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                Duration::from_millis(30),
                || false, // transport is down → reconnect underway
                paused_rx,
                no_reports(),
            ));

            // First sample establishes Live, then the stream stops.
            raw_tx.send(sample()).await.expect("send sample");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Stale);
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Reconnecting,
                "a drop with a dead agent transport must escalate to Reconnecting"
            );

            drop(raw_tx);
            handle
                .await
                .expect("driver task should end when raw channel closes");
        }

        /// #3300: an agent that never streams a first sample must not leave the
        /// monitor in `Connecting` forever: after `pre_live_failure_limit`
        /// missed freshness windows it resolves to `Offline`. A sample that
        /// arrives later still recovers it to `Live` (the driver keeps going).
        #[tokio::test(start_paused = true)]
        async fn no_first_sample_resolves_offline_then_a_late_sample_recovers() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, mut stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(20));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);
            let started = tokio::time::Instant::now();

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                Duration::from_millis(30),
                || true, // agent reachable, it just never streams
                paused_rx,
                no_reports(),
            ));

            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Offline,
                "no first agent sample must resolve Connecting -> Offline"
            );
            let limit = CollectLoopState::new().pre_live_failure_limit();
            assert_eq!(
                started.elapsed(),
                Duration::from_millis(50) * limit,
                "Offline after exactly `pre_live_failure_limit` freshness windows"
            );

            raw_tx.send(sample()).await.expect("send late sample");
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Live,
                "a late agent sample still recovers the monitor"
            );
            assert!(
                stats_rx.recv().await.is_some(),
                "the late sample is forwarded"
            );

            drop(raw_tx);
            handle
                .await
                .expect("driver task should end when raw channel closes");
        }

        /// #3300: a slow first agent sample that lands inside the generous bound
        /// (well past the `Stale` threshold) goes straight to `Live` — the
        /// bound must not kill a monitor whose first collect is merely slow.
        #[tokio::test(start_paused = true)]
        async fn a_slow_first_sample_within_the_bound_goes_live() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(20));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                Duration::from_millis(30),
                || true,
                paused_rx,
                no_reports(),
            ));

            // One window short of the bound (50 ms windows).
            let limit = CollectLoopState::new().pre_live_failure_limit();
            tokio::time::sleep(Duration::from_millis(50) * (limit - 1) + Duration::from_millis(10))
                .await;
            raw_tx.send(sample()).await.expect("send slow first sample");
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Live,
                "a slow first sample inside the bound must go Live, not Offline"
            );

            drop(raw_tx);
            handle
                .await
                .expect("driver task should end when raw channel closes");
        }

        /// #3300: while the agent transport is down the monitor reports
        /// `Reconnecting`; if no sample arrives within the bound it resolves to
        /// `Offline` rather than staying `Reconnecting` forever.
        #[tokio::test(start_paused = true)]
        async fn reconnecting_without_a_sample_resolves_offline() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(20));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                Duration::from_millis(30),
                || false, // agent transport down → reconnect underway
                paused_rx,
                no_reports(),
            ));

            raw_tx.send(sample()).await.expect("send sample");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Stale);
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Reconnecting
            );
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Offline,
                "a reconnect that never yields a sample must resolve to Offline"
            );

            drop(raw_tx);
            handle
                .await
                .expect("driver task should end when raw channel closes");
        }

        /// #3300: a paused agent monitor ignores missed windows — it never
        /// resolves to `Offline` while paused, however long the pause lasts.
        #[tokio::test(start_paused = true)]
        async fn paused_monitor_never_resolves_offline() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(20));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(true);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                Duration::from_millis(30),
                || true,
                paused_rx,
                no_reports(),
            ));

            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Paused);
            tokio::time::sleep(Duration::from_secs(60)).await;
            assert!(
                status_rx.try_recv().is_err(),
                "a paused monitor must not transition while paused"
            );

            drop(raw_tx);
            handle
                .await
                .expect("driver task should end when raw channel closes");
        }

        /// SM-013: pausing an agent-hosted monitor must actually take effect on
        /// the desktop even though the agent keeps streaming. While paused the
        /// driver emits `Paused`, drops the samples the agent keeps pushing (they
        /// must NOT reach the consumer, and must NOT flip the badge back to
        /// `Live`), then resumes cleanly — emitting `Live` and forwarding samples
        /// again. Before the fix `set_paused` was a no-op, so the discarded
        /// samples flowed through and each one re-emitted `Live`, desyncing the
        /// UI from its "paused" label.
        #[tokio::test]
        async fn pause_stops_forwarding_and_holds_paused_then_resumes() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, mut stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            // A generous freshness window so a stalled stream does not race the
            // pause assertions with a spurious `Stale`.
            let interval = Arc::new(AtomicU64::new(10_000));
            let (paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                Duration::from_millis(30),
                || true, // transport stays up throughout
                paused_rx,
                no_reports(),
            ));

            // Establish Live with a first sample.
            raw_tx.send(sample()).await.expect("send sample");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);
            assert!(
                stats_rx.recv().await.is_some(),
                "the pre-pause sample must be forwarded"
            );

            // Pause: the driver must emit Paused.
            paused_tx.send_replace(true);
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Paused,
                "pausing an agent monitor must report Paused on the desktop"
            );

            // Samples the agent keeps streaming while paused must be discarded:
            // neither forwarded to the consumer nor allowed to re-emit Live.
            raw_tx.send(sample()).await.expect("send sample");
            raw_tx.send(sample()).await.expect("send sample");
            assert!(
                tokio::time::timeout(Duration::from_millis(150), stats_rx.recv())
                    .await
                    .is_err(),
                "a paused agent monitor must not forward the samples it keeps receiving"
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(150), status_rx.recv())
                    .await
                    .is_err(),
                "a paused agent monitor must not flip its badge back to Live"
            );

            // Resume: the driver emits Live and forwards fresh samples again.
            paused_tx.send_replace(false);
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Live,
                "resuming must report Live"
            );
            raw_tx.send(sample()).await.expect("send sample");
            assert!(
                stats_rx.recv().await.is_some(),
                "a resumed monitor must forward samples again"
            );

            drop(raw_tx);
            handle
                .await
                .expect("driver task should end when raw channel closes");
        }

        // ── Bounded Stale + agent-reported status (#3321) ────────────────

        /// #3321 regression: an older agent (no status reports) whose loop gave
        /// up stops streaming while its transport stays up. The monitor goes
        /// `Stale` and — instead of staying `Stale` forever — resolves `Offline`
        /// once the agent's full recovery budget has elapsed. A late sample
        /// still recovers it to `Live`.
        #[tokio::test(start_paused = true)]
        async fn old_agent_stale_with_transport_up_resolves_offline_after_budget() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, mut stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(INTERVAL_MS));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                GRACE,
                || true, // agent transport stays up; its monitor loop ended
                paused_rx,
                no_reports(),
            ));

            raw_tx.send(sample()).await.expect("send sample");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);
            assert!(stats_rx.recv().await.is_some());
            let last_sample = tokio::time::Instant::now();
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Stale);

            let budget = agent_recovery_budget(Duration::from_millis(INTERVAL_MS));
            assert_eq!(
                next_status_within(&mut status_rx, budget * 2).await,
                MonitorStatus::Offline,
                "a Stale monitor with a live agent transport must not stay Stale forever"
            );
            let elapsed = last_sample.elapsed();
            assert!(
                elapsed >= budget && elapsed <= budget + WINDOW * 3,
                "Offline once the agent recovery budget ({budget:?}) is spent, got {elapsed:?}"
            );

            raw_tx.send(sample()).await.expect("send late sample");
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Live,
                "a late sample still recovers the monitor (#3322)"
            );

            drop(raw_tx);
            handle.await.expect("driver ends when raw channel closes");
        }

        /// #3321: a sample arriving inside the bound keeps the monitor alive —
        /// the bound restarts, so a merely-slow recovery never goes Offline.
        #[tokio::test(start_paused = true)]
        async fn a_sample_inside_the_stale_bound_recovers_and_restarts_it() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(INTERVAL_MS));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                GRACE,
                || true,
                paused_rx,
                no_reports(),
            ));

            raw_tx.send(sample()).await.expect("send sample");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Stale);

            let budget = agent_recovery_budget(Duration::from_millis(INTERVAL_MS));
            tokio::time::sleep(budget - WINDOW * 4).await;
            raw_tx.send(sample()).await.expect("send recovering sample");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);
            // The next drop starts a fresh bound: Stale again, not Offline.
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Stale);

            drop(raw_tx);
            handle.await.expect("driver ends when raw channel closes");
        }

        /// #3321: a reporting agent's status is applied as-is, over inference —
        /// including a parse-typed `Offline` the desktop could never infer.
        #[tokio::test(start_paused = true)]
        async fn agent_reported_status_is_applied_over_inference() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, mut stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let (reports_tx, reports_rx) = mpsc::channel(8);
            // A long cadence, so no missed-sample inference interferes.
            let interval = Arc::new(AtomicU64::new(60_000));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                GRACE,
                || true,
                paused_rx,
                reports_rx,
            ));

            reports_tx
                .send(report(MonitorStatus::Live, None))
                .await
                .expect("report");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);
            // A sample after the matching report does not re-emit Live.
            raw_tx.send(sample()).await.expect("send sample");
            assert!(stats_rx.recv().await.is_some());

            reports_tx
                .send(report(
                    MonitorStatus::Stale,
                    Some(MonitorStatusReason::Transport),
                ))
                .await
                .expect("report");
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Stale,
                "the agent's Stale is applied immediately, without waiting two windows"
            );
            reports_tx
                .send(report(
                    MonitorStatus::Reconnecting,
                    Some(MonitorStatusReason::Transport),
                ))
                .await
                .expect("report");
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Reconnecting,
                "Reconnecting is reported even though the agent transport is up"
            );
            reports_tx
                .send(report(
                    MonitorStatus::Offline,
                    Some(MonitorStatusReason::Parse),
                ))
                .await
                .expect("report");
            assert_eq!(
                next_update(&mut status_rx).await,
                MonitorStatusUpdate::with_reason(
                    MonitorStatus::Offline,
                    Some(MonitorStatusReason::Parse)
                ),
                "the agent's parse reason is carried through to the consumer (#3301)"
            );

            // A later sample (e.g. after a re-subscribe) still recovers.
            raw_tx.send(sample()).await.expect("send sample");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);

            drop(raw_tx);
            handle.await.expect("driver ends when raw channel closes");
        }

        /// #3321: while a reporting agent says it is `Reconnecting` (transport
        /// up), missed samples must not cut its reconnect campaign short with
        /// the desktop's 6-window pre-Live bound — only the full recovery budget
        /// resolves it `Offline`, and every agent report restarts that budget.
        #[tokio::test(start_paused = true)]
        async fn reporting_agent_reconnect_is_bounded_by_the_recovery_budget_only() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let (reports_tx, reports_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(INTERVAL_MS));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                GRACE,
                || true,
                paused_rx,
                reports_rx,
            ));

            reports_tx
                .send(report(MonitorStatus::Live, None))
                .await
                .expect("report");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);
            reports_tx
                .send(report(
                    MonitorStatus::Reconnecting,
                    Some(MonitorStatusReason::Transport),
                ))
                .await
                .expect("report");
            assert_eq!(
                next_status(&mut status_rx).await,
                MonitorStatus::Reconnecting
            );

            // Far past the pre-Live bound (6 windows): still Reconnecting.
            let limit = CollectLoopState::new().pre_live_failure_limit();
            tokio::time::sleep(WINDOW * limit * 10).await;
            assert!(
                status_rx.try_recv().is_err(),
                "the agent's reconnect must not be cut short by the pre-Live bound"
            );

            // A repeated report (no visible change) restarts the budget.
            reports_tx
                .send(report(
                    MonitorStatus::Reconnecting,
                    Some(MonitorStatusReason::Transport),
                ))
                .await
                .expect("report");
            tokio::task::yield_now().await;
            let restarted = tokio::time::Instant::now();

            let budget = agent_recovery_budget(Duration::from_millis(INTERVAL_MS));
            assert_eq!(
                next_status_within(&mut status_rx, budget * 2).await,
                MonitorStatus::Offline,
                "an agent that goes silent mid-reconnect is still bounded"
            );
            assert!(
                restarted.elapsed() >= budget,
                "the report restarted the budget"
            );

            // The agent finally reports Live again.
            reports_tx
                .send(report(MonitorStatus::Live, None))
                .await
                .expect("report");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);

            drop(raw_tx);
            handle.await.expect("driver ends when raw channel closes");
        }

        /// #3321: an agent report never overrides a desktop pause.
        #[tokio::test(start_paused = true)]
        async fn agent_reports_are_ignored_while_paused() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let (reports_tx, reports_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(INTERVAL_MS));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(true);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                GRACE,
                || true,
                paused_rx,
                reports_rx,
            ));

            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Paused);
            reports_tx
                .send(report(
                    MonitorStatus::Offline,
                    Some(MonitorStatusReason::Transport),
                ))
                .await
                .expect("report");
            tokio::time::sleep(Duration::from_secs(600)).await;
            assert!(
                status_rx.try_recv().is_err(),
                "a paused monitor holds Paused regardless of agent reports"
            );

            drop(raw_tx);
            handle.await.expect("driver ends when raw channel closes");
        }

        /// #3301: a re-report that keeps the status but changes the cause is
        /// still forwarded, so the badge text follows the agent's latest reason.
        #[tokio::test(start_paused = true)]
        async fn reported_reason_change_is_forwarded_without_a_status_change() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let (reports_tx, reports_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(60_000));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                GRACE,
                || true,
                paused_rx,
                reports_rx,
            ));

            for reason in [MonitorStatusReason::Transport, MonitorStatusReason::Parse] {
                reports_tx
                    .send(report(MonitorStatus::Offline, Some(reason)))
                    .await
                    .expect("report");
                assert_eq!(
                    next_update(&mut status_rx).await,
                    MonitorStatusUpdate::with_reason(MonitorStatus::Offline, Some(reason))
                );
            }
            // An identical re-report emits nothing.
            reports_tx
                .send(report(
                    MonitorStatus::Offline,
                    Some(MonitorStatusReason::Parse),
                ))
                .await
                .expect("report");
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert!(status_rx.try_recv().is_err(), "no change, no emit");

            drop(raw_tx);
            handle.await.expect("driver ends when raw channel closes");
        }

        /// #3301: with the agent transport up, an (older, non-reporting) agent
        /// that stops streaming is attributed `Silent` — "no data from agent" —
        /// on both the inferred `Stale` and the bounded `Offline`, never
        /// "connection lost".
        #[tokio::test(start_paused = true)]
        async fn silent_agent_with_transport_up_is_attributed_silent() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(INTERVAL_MS));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                GRACE,
                || true,
                paused_rx,
                no_reports(),
            ));

            raw_tx.send(sample()).await.expect("send sample");
            assert_eq!(
                next_update(&mut status_rx).await,
                MonitorStatusUpdate::new(MonitorStatus::Live)
            );
            assert_eq!(
                next_update(&mut status_rx).await,
                MonitorStatusUpdate::with_reason(
                    MonitorStatus::Stale,
                    Some(MonitorStatusReason::Silent)
                )
            );
            let budget = agent_recovery_budget(Duration::from_millis(INTERVAL_MS));
            assert_eq!(
                next_update_within(&mut status_rx, budget * 2).await,
                MonitorStatusUpdate::with_reason(
                    MonitorStatus::Offline,
                    Some(MonitorStatusReason::Silent)
                ),
                "the bounded-Stale Offline is the agent going silent"
            );

            drop(raw_tx);
            handle.await.expect("driver ends when raw channel closes");
        }

        /// #3301: with the agent transport down, the inferred `Reconnecting`
        /// and the eventual `Offline` are transport failures ("connection lost").
        #[tokio::test(start_paused = true)]
        async fn dead_agent_transport_is_attributed_transport() {
            let (raw_tx, raw_rx) = mpsc::channel::<SystemStats>(16);
            let (stats_tx, _stats_rx) = mpsc::channel(16);
            let (status_tx, mut status_rx) = mpsc::channel(8);
            let interval = Arc::new(AtomicU64::new(INTERVAL_MS));
            let (_paused_tx, paused_rx) = tokio::sync::watch::channel(false);
            let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
            let alive_probe = alive.clone();

            let handle = tokio::spawn(drive_monitor_status(
                raw_rx,
                stats_tx,
                status_tx,
                interval,
                GRACE,
                move || alive_probe.load(std::sync::atomic::Ordering::SeqCst),
                paused_rx,
                no_reports(),
            ));

            raw_tx.send(sample()).await.expect("send sample");
            assert_eq!(next_status(&mut status_rx).await, MonitorStatus::Live);
            alive.store(false, std::sync::atomic::Ordering::SeqCst);

            assert_eq!(
                next_update(&mut status_rx).await,
                MonitorStatusUpdate::with_reason(
                    MonitorStatus::Stale,
                    Some(MonitorStatusReason::Transport)
                )
            );
            assert_eq!(
                next_update(&mut status_rx).await,
                MonitorStatusUpdate::with_reason(
                    MonitorStatus::Reconnecting,
                    Some(MonitorStatusReason::Transport)
                )
            );
            assert_eq!(
                next_update(&mut status_rx).await,
                MonitorStatusUpdate::with_reason(
                    MonitorStatus::Offline,
                    Some(MonitorStatusReason::Transport)
                ),
                "a dead agent transport resolves Offline as a lost connection"
            );

            drop(raw_tx);
            handle.await.expect("driver ends when raw channel closes");
        }
    }
}
