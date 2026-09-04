//! [`ConnectionType`] implementation that forwards all calls to a remote
//! agent via JSON-RPC through [`AgentConnectionManager`].
//!
//! The desktop creates a `RemoteProxy` instead of a concrete backend when
//! the user specifies an `agent_id`. All terminal I/O, file browsing, and
//! monitoring operations are proxied to the agent over the SSH transport.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

/// Default monitoring collection interval in milliseconds (#1233).
///
/// Matches the agent's own default; `set_interval` overrides it per subscription.
const DEFAULT_MONITORING_INTERVAL_MS: u64 = 2000;

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
use termihub_core::monitoring::{MonitorStatus, MonitoringProvider, MonitoringSubscription};

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
    monitoring_proxy: Option<RemoteMonitoringProxy>,
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
            }),
            std_output_rx: Mutex::new(None),
            connected: AtomicBool::new(false),
            file_browser_proxy: None,
            monitoring_proxy: None,
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
            }),
            std_output_rx: Mutex::new(Some(std_rx)),
            connected: AtomicBool::new(true),
            file_browser_proxy: None,
            monitoring_proxy: None,
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
            .map(|p| p as &dyn MonitoringProvider)
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        self.file_browser_proxy
            .as_ref()
            .map(|p| p as &dyn FileBrowser)
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
            mgr.send_request(&agent_id_owned, "connection.types", serde_json::json!({}))
        })
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("spawn_blocking join: {e}")))?;
        if let Ok(caps_result) = caps_result {
            if let Some(types) = caps_result.get("types").and_then(|v| v.as_array()) {
                for type_info in types {
                    if type_info.get("typeId").and_then(|v| v.as_str()) == Some(&session_type) {
                        if let Some(caps) = type_info.get("capabilities") {
                            if let Ok(parsed) = serde_json::from_value::<Capabilities>(caps.clone())
                            {
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
                                    self.monitoring_proxy = Some(RemoteMonitoringProxy {
                                        agent_id: self.agent_id.clone(),
                                        monitoring_host,
                                        agent_manager: self.agent_manager.clone(),
                                        interval_ms: AtomicU64::new(DEFAULT_MONITORING_INTERVAL_MS),
                                    });
                                }
                            }
                        }
                        break;
                    }
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
    async fn rpc(&self, method: &'static str, params: Value) -> Result<Value, FileError> {
        let mgr = self.agent_manager.clone();
        let agent_id = self.agent_id.clone();
        tokio::task::spawn_blocking(move || mgr.send_request(&agent_id, method, params))
            .await
            .map_err(|e| FileError::OperationFailed(format!("spawn_blocking join: {e}")))?
            .map_err(|e| FileError::OperationFailed(e.to_string()))
    }
}

#[async_trait::async_trait]
impl FileBrowser for RemoteFileBrowserProxy {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let result = self
            .rpc(
                "connection.files.list",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "path": path,
                }),
            )
            .await?;

        let entries = result
            .get("entries")
            .cloned()
            .unwrap_or(Value::Array(vec![]));
        serde_json::from_value(entries).map_err(|e| FileError::OperationFailed(e.to_string()))
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let result = self
            .rpc(
                "connection.files.read",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "path": path,
                }),
            )
            .await?;

        let data_b64 = result.get("data").and_then(|v| v.as_str()).unwrap_or("");
        base64_decode(data_b64)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        self.rpc(
            "connection.files.write",
            serde_json::json!({
                "connection_id": self.remote_session_id,
                "path": path,
                "data": encoded,
            }),
        )
        .await?;
        Ok(())
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        self.rpc(
            "connection.files.delete",
            serde_json::json!({
                "connection_id": self.remote_session_id,
                "path": path,
            }),
        )
        .await?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        self.rpc(
            "connection.files.rename",
            serde_json::json!({
                "connection_id": self.remote_session_id,
                "from": from,
                "to": to,
            }),
        )
        .await?;
        Ok(())
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let result = self
            .rpc(
                "connection.files.stat",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "path": path,
                }),
            )
            .await?;

        serde_json::from_value(result).map_err(|e| FileError::OperationFailed(e.to_string()))
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        self.rpc(
            "connection.files.mkdir",
            serde_json::json!({
                "connection_id": self.remote_session_id,
                "path": path,
            }),
        )
        .await?;
        Ok(())
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
    interval_ms: AtomicU64,
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
            interval_ms: AtomicU64::new(DEFAULT_MONITORING_INTERVAL_MS),
        }
    }

    /// Run a sync `send_request` on the blocking thread pool so its internal
    /// `oneshot::Receiver::blocking_recv` does not park a tokio worker thread.
    async fn rpc(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let mgr = self.agent_manager.clone();
        let agent_id = self.agent_id.clone();
        tokio::task::spawn_blocking(move || mgr.send_request(&agent_id, method, params))
            .await
            .map_err(|e| CoreError::Other(format!("spawn_blocking join: {e}")))?
            .map_err(|e| CoreError::Other(e.to_string()))
    }
}

#[async_trait::async_trait]
impl MonitoringProvider for RemoteMonitoringProxy {
    async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError> {
        let (tx, rx) = tokio::sync::mpsc::channel(16);

        // Register monitoring channel so agent_manager routes notifications to it.
        self.agent_manager
            .register_monitoring_output(&self.agent_id, &self.monitoring_host, tx)
            .map_err(|e| CoreError::Other(e.to_string()))?;

        // Send subscribe request to agent at the currently-configured cadence
        // (#1233); the frontend may later change it via `set_interval`.
        self.rpc(
            "connection.monitoring.subscribe",
            serde_json::json!({
                "host": self.monitoring_host,
                "interval_ms": self.interval_ms.load(Ordering::SeqCst),
            }),
        )
        .await?;

        // The agent-mediated path does not yet forward a status stream (that
        // arrives in a later stage of the lifecycle redesign). Report an
        // initial `Live` so the frontend renders live agent stats rather than
        // staying stuck at `Connecting`. Agent-side Stale/Reconnecting will be
        // wired through this same channel in a follow-up (#1229 is S2, desktop
        // SSH only).
        let (status_tx, status_rx) = tokio::sync::mpsc::channel(1);
        let _ = status_tx.send(MonitorStatus::Live).await;

        Ok(MonitoringSubscription {
            stats: rx,
            status: status_rx,
        })
    }

    async fn unsubscribe(&self) -> Result<(), CoreError> {
        // Unregister monitoring channel before telling the agent to stop.
        let _ = self
            .agent_manager
            .unregister_monitoring_output(&self.agent_id, &self.monitoring_host);

        self.rpc(
            "connection.monitoring.unsubscribe",
            serde_json::json!({
                "host": self.monitoring_host,
            }),
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
                "connection.monitoring.subscribe",
                serde_json::json!({
                    "host": self.monitoring_host,
                    "interval_ms": ms,
                }),
            )
            .await
        {
            warn!(host = %self.monitoring_host, error = %e, "Failed to update agent monitoring interval");
        }
    }

    async fn set_paused(&self, _paused: bool) {
        // Agent-mediated pause requires a protocol addition to signal the remote
        // collect loop; tracked as a follow-up to #1233. Desktop-direct SSH
        // monitoring supports pause today via the SSH provider.
        debug!(
            host = %self.monitoring_host,
            "Pause/resume not yet supported for agent-mediated monitoring (follow-up to #1233)"
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
            _definition: serde_json::Value,
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
            _params: serde_json::Value,
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
            _params: serde_json::Value,
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
            _definition: serde_json::Value,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn update_definition(
            &self,
            _agent_id: &str,
            _params: serde_json::Value,
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
            _params: serde_json::Value,
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
            _definition: serde_json::Value,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn update_definition(
            &self,
            _agent_id: &str,
            _params: serde_json::Value,
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
            _params: serde_json::Value,
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
}
