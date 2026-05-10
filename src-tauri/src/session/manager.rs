//! Unified session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Replaces the legacy `TerminalManager` with a single manager that holds
//! `Box<dyn ConnectionType>` for both local and remote (agent-mediated)
//! connections. Local connections use the core backend implementations;
//! remote connections use [`RemoteProxy`](super::remote_proxy::RemoteProxy).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use serde::Serialize;
use tauri::Emitter;
use termihub_core::connection::{
    Capabilities, ConnectionType, ConnectionTypeInfo, ConnectionTypeRegistry,
};
use termihub_core::files::FileEntry;
use termihub_core::monitoring::SystemStats;
use termihub_core::output::coalescer::OutputCoalescer;
use termihub_core::output::screen_clear::contains_screen_clear;
use tracing::{error, info, warn};

use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

use super::remote_proxy::RemoteProxy;

/// Maximum number of concurrent sessions.
const MAX_SESSIONS: usize = 50;

/// Maximum coalesced output size per emit (32 KB).
const MAX_COALESCE_BYTES: usize = 32 * 1024;

/// Maximum time to wait for the screen-clear sequence before flushing
/// buffered output anyway.
const CLEAR_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Output event emitted via Tauri events.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub data: Vec<u8>,
}

/// Exit event emitted when a terminal process exits.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<i32>,
}

/// State change event emitted when a persistent session transitions state.
#[derive(Debug, Clone, Serialize)]
pub struct PersistentSessionStateEvent {
    pub connection_id: String,
    pub session_id: Option<String>,
    pub state: String,
    pub attached_tab_count: u32,
    pub error_message: Option<String>,
}

/// Public summary of a persistent session, returned by `list_persistent_sessions`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentSessionSummary {
    pub connection_id: String,
    pub session_id: String,
    pub attached_tab_count: u32,
}

/// Internal record for a persistent session.
struct PersistentRecord {
    connection_id: String,
    session_id: String,
    attached_tabs: HashSet<String>,
}

/// Error event emitted when a session-level error occurs.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct TerminalErrorEvent {
    pub session_id: String,
    pub message: String,
}

// ── EventEmitter trait ─────────────────────────────────────────────

/// Abstracts frontend event delivery for dependency injection in tests.
///
/// The production implementation wraps `tauri::AppHandle` and emits
/// Tauri events to the webview. Test implementations record emitted
/// events for assertions without requiring a real Tauri runtime.
pub trait EventEmitter: Clone + Send + Sync + 'static {
    /// Emit a terminal output chunk. Returns `false` if delivery failed
    /// (e.g., the webview was closed), signalling the reader to stop.
    fn emit_output(&self, event: &TerminalOutputEvent) -> bool;

    /// Emit a session exit notification.
    fn emit_exit(&self, event: &TerminalExitEvent);

    /// Emit a persistent session state change. Default no-op for test implementations.
    fn emit_persistent_state(&self, _event: &PersistentSessionStateEvent) {}
}

impl<R: tauri::Runtime> EventEmitter for tauri::AppHandle<R> {
    fn emit_output(&self, event: &TerminalOutputEvent) -> bool {
        self.emit("terminal-output", event).is_ok()
    }

    fn emit_exit(&self, event: &TerminalExitEvent) {
        let _ = self.emit("terminal-exit", event);
    }

    fn emit_persistent_state(&self, event: &PersistentSessionStateEvent) {
        let _ = self.emit("persistent-session-state-changed", event);
    }
}

/// Information about an active session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub connection_type: String,
    pub alive: bool,
    /// Set when the session is a remote proxy; identifies the agent it runs on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// Internal session entry held by the manager.
struct SessionEntry {
    connection: Box<dyn ConnectionType>,
    info: SessionInfo,
    /// Remote session ID assigned by the agent (set for remote proxy sessions).
    remote_session_id: Option<String>,
}

/// Push event emitted via Tauri when session-based monitoring delivers stats.
#[derive(Debug, Clone, Serialize)]
pub struct SessionMonitoringStatsEvent {
    pub session_id: String,
    pub stats: SystemStats,
}

/// Manages all active connection sessions.
///
/// Holds a [`ConnectionTypeRegistry`] for creating local connections and
/// an [`AgentConnectionManager`] for creating remote (agent-mediated)
/// connections via [`RemoteProxy`].
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
    registry: Arc<ConnectionTypeRegistry>,
    agent_manager: Arc<dyn AgentRpcClient>,
    /// Abort handles for active session-monitoring push tasks, keyed by session ID.
    monitoring_tasks: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
    /// Registry for persistent sessions, keyed by connection ID.
    persistent_sessions: Arc<Mutex<HashMap<String, PersistentRecord>>>,
}

impl SessionManager {
    /// Create a new session manager with the given registry and agent manager.
    pub fn new(registry: ConnectionTypeRegistry, agent_manager: Arc<dyn AgentRpcClient>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            registry: Arc::new(registry),
            agent_manager,
            monitoring_tasks: Arc::new(Mutex::new(HashMap::new())),
            persistent_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Create a new connection session.
    ///
    /// If `agent_id` is `Some`, creates a [`RemoteProxy`] that forwards
    /// to the specified agent. Otherwise, creates a local connection from
    /// the registry.
    ///
    /// Returns the session ID on success.
    pub async fn create_connection<E: EventEmitter>(
        &self,
        type_id: &str,
        settings: serde_json::Value,
        agent_id: Option<&str>,
        emitter: E,
    ) -> Result<String, TerminalError> {
        // Enforce session limit.
        {
            let sessions = self.sessions.lock().await;
            if sessions.len() >= MAX_SESSIONS {
                return Err(TerminalError::SpawnFailed(format!(
                    "Maximum number of sessions ({MAX_SESSIONS}) reached"
                )));
            }
        }

        let session_id = uuid::Uuid::new_v4().to_string();

        let (connection, remote_session_id): (Box<dyn ConnectionType>, Option<String>) =
            if let Some(aid) = agent_id {
                // Remote: create proxy to agent.
                let mut proxy = RemoteProxy::new(aid.to_string(), self.agent_manager.clone());
                // Wrap settings with the type information for the remote side.
                let remote_settings = serde_json::json!({
                    "type": type_id,
                    "config": settings,
                });
                proxy
                    .connect(remote_settings)
                    .await
                    .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
                let remote_sid = proxy.remote_session_id();
                (Box::new(proxy), remote_sid)
            } else {
                // Local: instantiate from registry.
                let mut conn = self
                    .registry
                    .create(type_id)
                    .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
                conn.connect(settings.clone())
                    .await
                    .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
                (conn, None)
            };

        // Build a human-readable title.
        let title = Self::build_title(type_id, &settings, agent_id);

        // Subscribe to output.
        let output_rx = connection.subscribe_output();

        let info = SessionInfo {
            id: session_id.clone(),
            title,
            connection_type: type_id.to_string(),
            alive: true,
            agent_id: agent_id.map(|s| s.to_string()),
        };

        // Store session.
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                session_id.clone(),
                SessionEntry {
                    connection,
                    info: info.clone(),
                    remote_session_id,
                },
            );
        }

        // Determine if we should wait for screen clear (initial command).
        let has_initial_command = settings
            .get("initialCommand")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty());

        // Spawn output streaming task.
        let sessions_clone = self.sessions.clone();
        let persistent_sessions_clone = self.persistent_sessions.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            Self::run_output_reader(
                sid,
                output_rx,
                emitter,
                sessions_clone,
                persistent_sessions_clone,
                has_initial_command,
            )
            .await;
        });

        // Send initial command after a short delay.
        if let Some(cmd) = settings
            .get("initialCommand")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            let sessions = self.sessions.clone();
            let sid = session_id.clone();
            let cmd = cmd.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let sessions = sessions.lock().await;
                if let Some(entry) = sessions.get(&sid) {
                    let input = format!("{cmd}\n");
                    let _ = entry.connection.write(input.as_bytes());
                }
            });
        }

        info!(session_id = %session_id, type_id, "Created session");
        Ok(session_id)
    }

    /// Send input data to a session.
    pub async fn send_input(&self, session_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        // Fast-path: skip the blocking write entirely for sessions already
        // known to be dead (alive flag cleared by a previous write failure or
        // by the reader thread).  This prevents a cascade of IPC calls from
        // rapid keystrokes all blocking for SO_SNDTIMEO before giving up.
        if !entry.connection.is_connected() {
            return Err(TerminalError::WriteFailed(
                "session disconnected".to_string(),
            ));
        }
        let data = data.to_vec();
        // block_in_place lets tokio keep processing other tasks while this
        // thread blocks on the potentially-slow synchronous write (e.g. SSH
        // write on a dead connection waiting for SO_SNDTIMEO to fire).
        tokio::task::block_in_place(|| entry.connection.write(&data))
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))
    }

    /// Resize a session's terminal.
    pub async fn resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        tokio::task::block_in_place(|| entry.connection.resize(cols, rows))
            .map_err(|e| TerminalError::ResizeFailed(e.to_string()))
    }

    /// Close a session.
    ///
    /// Explicitly calls [`ConnectionType::disconnect`] before dropping the entry
    /// so that backends that release resources in `disconnect()` (not just `Drop`)
    /// — notably Serial, which clears `output_tx` to stop its reader thread —
    /// are cleaned up immediately.
    pub async fn close_session(&self, session_id: &str) -> Result<(), TerminalError> {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut entry) = sessions.remove(session_id) {
            entry.connection.disconnect().await.ok();
            info!(session_id, "Closed session");
        }
        Ok(())
    }

    /// List all active sessions.
    pub async fn list_sessions(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.lock().await;
        sessions
            .values()
            .map(|entry| {
                let mut info = entry.info.clone();
                info.alive = entry.connection.is_connected();
                info
            })
            .collect()
    }

    /// List directory contents via a session's file browser capability.
    pub async fn list_files(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<FileEntry>, TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let browser = entry
            .connection
            .file_browser()
            .ok_or_else(|| TerminalError::RemoteError("No file browser capability".to_string()))?;
        browser
            .list_dir(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Read a file via a session's file browser capability.
    pub async fn read_file(&self, session_id: &str, path: &str) -> Result<Vec<u8>, TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let browser = entry
            .connection
            .file_browser()
            .ok_or_else(|| TerminalError::RemoteError("No file browser capability".to_string()))?;
        browser
            .read_file(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Write a file via a session's file browser capability.
    pub async fn write_file(
        &self,
        session_id: &str,
        path: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let browser = entry
            .connection
            .file_browser()
            .ok_or_else(|| TerminalError::RemoteError("No file browser capability".to_string()))?;
        browser
            .write_file(path, data)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Delete a file via a session's file browser capability.
    pub async fn delete_file(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let browser = entry
            .connection
            .file_browser()
            .ok_or_else(|| TerminalError::RemoteError("No file browser capability".to_string()))?;
        browser
            .delete(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Rename a file via a session's file browser capability.
    pub async fn rename_file(
        &self,
        session_id: &str,
        from: &str,
        to: &str,
    ) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let browser = entry
            .connection
            .file_browser()
            .ok_or_else(|| TerminalError::RemoteError("No file browser capability".to_string()))?;
        browser
            .rename(from, to)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Create a directory via a session's file browser capability.
    pub async fn mkdir_file(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let browser = entry
            .connection
            .file_browser()
            .ok_or_else(|| TerminalError::RemoteError("No file browser capability".to_string()))?;
        browser
            .mkdir(path)
            .await
            .map_err(|e| TerminalError::RemoteError(e.to_string()))
    }

    /// Get the list of available connection types from the registry.
    pub fn available_types(&self) -> Vec<ConnectionTypeInfo> {
        self.registry.available_types()
    }

    /// Return the capabilities of an active session.
    pub async fn session_capabilities(&self, session_id: &str) -> Option<Capabilities> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(session_id)
            .map(|e| e.connection.capabilities())
    }

    /// Subscribe to a session's monitoring provider and forward stats as Tauri events.
    ///
    /// Spawns a background task that reads from the `MonitoringReceiver` and emits
    /// `session-monitoring-stats` events to the frontend.  Call
    /// [`stop_session_monitoring`] to cancel the task and unsubscribe.
    pub async fn start_session_monitoring<R: tauri::Runtime>(
        &self,
        session_id: &str,
        app_handle: tauri::AppHandle<R>,
    ) -> Result<(), TerminalError> {
        let rx = {
            let sessions = self.sessions.lock().await;
            let entry = sessions
                .get(session_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
            let provider = entry.connection.monitoring().ok_or_else(|| {
                TerminalError::RemoteError("No monitoring capability".to_string())
            })?;
            provider
                .subscribe()
                .await
                .map_err(|e| TerminalError::RemoteError(e.to_string()))?
        };

        let sid = session_id.to_string();
        let join_handle = tokio::spawn(async move {
            let mut rx = rx;
            while let Some(stats) = rx.recv().await {
                let event = SessionMonitoringStatsEvent {
                    session_id: sid.clone(),
                    stats,
                };
                if app_handle.emit("session-monitoring-stats", &event).is_err() {
                    break;
                }
            }
            info!(session_id = %sid, "Session monitoring push task ended");
        });

        let abort_handle = join_handle.abort_handle();
        self.monitoring_tasks
            .lock()
            .await
            .insert(session_id.to_string(), abort_handle);
        Ok(())
    }

    /// Stop session-based monitoring: abort the push task and unsubscribe.
    pub async fn stop_session_monitoring(&self, session_id: &str) -> Result<(), TerminalError> {
        if let Some(handle) = self.monitoring_tasks.lock().await.remove(session_id) {
            handle.abort();
        }

        let sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get(session_id) {
            if let Some(provider) = entry.connection.monitoring() {
                if let Err(e) = provider.unsubscribe().await {
                    warn!(session_id, error = %e, "Session monitoring unsubscribe error");
                }
            }
        }
        Ok(())
    }

    // ── Persistent session management ──────────────────────────────────

    /// Start a persistent session for `connection_id`.
    ///
    /// Creates a backend session and registers it in the persistent registry.
    /// Returns the new session ID. If a session for this connection already exists,
    /// returns `Ok(existing_session_id)` without creating a duplicate.
    pub async fn start_persistent_session<E: EventEmitter>(
        &self,
        connection_id: &str,
        type_id: &str,
        settings: serde_json::Value,
        agent_id: Option<&str>,
        emitter: E,
    ) -> Result<String, TerminalError> {
        // Idempotency: if already running return the existing session ID.
        {
            let ps = self.persistent_sessions.lock().await;
            if let Some(record) = ps.get(connection_id) {
                let sessions = self.sessions.lock().await;
                if sessions.contains_key(&record.session_id) {
                    return Ok(record.session_id.clone());
                }
                // Session is registered but backend entry is gone (crashed) — fall through.
            }
        }

        let session_id = self
            .create_connection(type_id, settings, agent_id, emitter.clone())
            .await?;

        {
            let mut ps = self.persistent_sessions.lock().await;
            ps.insert(
                connection_id.to_string(),
                PersistentRecord {
                    connection_id: connection_id.to_string(),
                    session_id: session_id.clone(),
                    attached_tabs: HashSet::new(),
                },
            );
        }

        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.to_string(),
            session_id: Some(session_id.clone()),
            state: "running".to_string(),
            attached_tab_count: 0,
            error_message: None,
        });

        info!(connection_id, session_id, "Persistent session started");
        Ok(session_id)
    }

    /// Stop a persistent session for `connection_id`.
    ///
    /// Closes the backend session and removes the persistent registry entry.
    /// No-op if the session is not registered as persistent.
    pub async fn stop_persistent_session<E: EventEmitter>(
        &self,
        connection_id: &str,
        emitter: E,
    ) -> Result<(), TerminalError> {
        let record = {
            let mut ps = self.persistent_sessions.lock().await;
            ps.remove(connection_id)
        };

        let Some(record) = record else {
            return Ok(());
        };

        self.close_session(&record.session_id).await?;

        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.to_string(),
            session_id: Some(record.session_id.clone()),
            state: "stopped".to_string(),
            attached_tab_count: 0,
            error_message: None,
        });

        info!(connection_id, session_id = %record.session_id, "Persistent session stopped");
        Ok(())
    }

    /// Register `tab_id` as attached to the persistent session for `connection_id`.
    ///
    /// Returns the new attached-tab count. Returns an error if the session is not
    /// registered or the backend session is no longer alive.
    pub async fn attach_persistent_tab<E: EventEmitter>(
        &self,
        connection_id: &str,
        tab_id: &str,
        emitter: E,
    ) -> Result<u32, TerminalError> {
        let (count, session_id) = {
            let mut ps = self.persistent_sessions.lock().await;
            let record = ps.get_mut(connection_id).ok_or_else(|| {
                TerminalError::SessionNotFound(format!(
                    "No persistent session for connection {connection_id}"
                ))
            })?;
            // Verify backend session is still alive.
            {
                let sessions = self.sessions.lock().await;
                if !sessions.contains_key(&record.session_id) {
                    return Err(TerminalError::SessionNotFound(format!(
                        "Persistent session {} for connection {} is no longer alive",
                        record.session_id, connection_id
                    )));
                }
            }
            record.attached_tabs.insert(tab_id.to_string());
            (record.attached_tabs.len() as u32, record.session_id.clone())
        };

        // Kick off a background reconnect of the DaemonClient so the daemon sends a
        // fresh buffer replay as a connection.output notification. The new tab's
        // Terminal component receives the scrollback when it calls subscribeOutput,
        // which flushes pendingOutput — even when the DaemonClient went stale.
        let agent_info = {
            let sessions = self.sessions.lock().await;
            sessions.get(&session_id).and_then(|e| {
                e.info
                    .agent_id
                    .as_deref()
                    .zip(e.remote_session_id.as_deref())
                    .map(|(aid, rsid)| (aid.to_string(), rsid.to_string()))
            })
        };
        if let Some((agent_id, remote_sid)) = agent_info {
            let am = self.agent_manager.clone();
            // Detached task — the JoinHandle is intentionally dropped here so
            // attach_persistent_tab returns immediately without waiting for the SSH
            // round-trip. Dropping a tokio JoinHandle does not cancel the task.
            let _reattach = tokio::task::spawn_blocking(move || {
                if let Err(e) = am.attach_session(&agent_id, &remote_sid) {
                    warn!(
                        error = %e,
                        "attach_persistent_tab: daemon client reattach failed"
                    );
                }
            });
        }

        let state = if count > 0 { "attached" } else { "running" }.to_string();
        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.to_string(),
            session_id: Some(session_id),
            state,
            attached_tab_count: count,
            error_message: None,
        });

        Ok(count)
    }

    /// Unregister `tab_id` from the persistent session identified by `session_id`.
    ///
    /// Keeps the backend session alive. Returns the new attached-tab count.
    /// No-op (returns 0) if the session is not in the persistent registry.
    pub async fn detach_persistent_tab<E: EventEmitter>(
        &self,
        session_id: &str,
        tab_id: &str,
        emitter: E,
    ) -> Result<u32, TerminalError> {
        let (connection_id, count) = {
            let mut ps = self.persistent_sessions.lock().await;
            let Some(record) = ps.values_mut().find(|r| r.session_id == session_id) else {
                return Ok(0);
            };
            record.attached_tabs.remove(tab_id);
            let count = record.attached_tabs.len() as u32;
            (record.connection_id.clone(), count)
        };

        let state = if count > 0 { "attached" } else { "running" }.to_string();
        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.clone(),
            session_id: Some(session_id.to_string()),
            state,
            attached_tab_count: count,
            error_message: None,
        });

        info!(
            session_id,
            tab_id,
            remaining = count,
            "Tab detached from persistent session"
        );
        Ok(count)
    }

    /// List all registered persistent sessions and their current state.
    pub async fn list_persistent_sessions(&self) -> Vec<PersistentSessionSummary> {
        let ps = self.persistent_sessions.lock().await;
        ps.values()
            .map(|r| PersistentSessionSummary {
                connection_id: r.connection_id.clone(),
                session_id: r.session_id.clone(),
                attached_tab_count: r.attached_tabs.len() as u32,
            })
            .collect()
    }

    /// Fetch the scrollback buffer from the agent for a persistent session.
    ///
    /// Sends `session.getBuffer` over JSON-RPC to the agent, which queries
    /// the daemon's ring buffer non-destructively and returns a base64-encoded
    /// snapshot.
    pub async fn get_remote_session_buffer(
        &self,
        session_id: &str,
    ) -> Result<Vec<u8>, TerminalError> {
        let (agent_id, remote_sid) = {
            let sessions = self.sessions.lock().await;
            let entry = sessions
                .get(session_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
            let agent_id =
                entry.info.agent_id.clone().ok_or_else(|| {
                    TerminalError::RemoteError("not a remote session".to_string())
                })?;
            let remote_sid = entry.remote_session_id.clone().ok_or_else(|| {
                TerminalError::RemoteError("remote session ID unavailable".to_string())
            })?;
            (agent_id, remote_sid)
        };

        let result = self
            .agent_manager
            .send_request(
                &agent_id,
                "session.getBuffer",
                serde_json::json!({ "session_id": remote_sid }),
            )
            .map_err(|e| TerminalError::RemoteError(e.to_string()))?;

        let b64 = result.get("data").and_then(|v| v.as_str()).unwrap_or("");
        if b64.is_empty() {
            return Ok(Vec::new());
        }

        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| TerminalError::RemoteError(format!("base64 decode error: {e}")))
    }

    // ── End persistent session management ──────────────────────────────

    /// Build a human-readable title from type and settings.
    ///
    /// For proxy sessions (`agent_id` is `Some`) the same descriptive title is
    /// used as for local sessions — the agent context is conveyed by the UI
    /// section header, not by the title itself.
    fn build_title(type_id: &str, settings: &serde_json::Value, agent_id: Option<&str>) -> String {
        let _ = agent_id;
        match type_id {
            "local" => settings
                .get("shell")
                .and_then(|v| v.as_str())
                .unwrap_or("Shell")
                .to_string(),
            "ssh" => {
                let user = settings
                    .get("username")
                    .and_then(|v| v.as_str())
                    .unwrap_or("user");
                let host = settings
                    .get("host")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                format!("SSH: {user}@{host}")
            }
            "serial" => {
                let port = settings
                    .get("port")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                format!("Serial: {port}")
            }
            "telnet" => {
                let host = settings
                    .get("host")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let port = settings.get("port").and_then(|v| v.as_u64()).unwrap_or(23);
                format!("Telnet: {host}:{port}")
            }
            "docker" => {
                let image = settings
                    .get("image")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let runtime = settings
                    .get("runtime")
                    .and_then(|v| v.as_str())
                    .unwrap_or("auto");
                match runtime {
                    "docker" => format!("Docker: {image}"),
                    "podman" => format!("Podman: {image}"),
                    _ => format!("Container: {image}"),
                }
            }
            "wsl" => {
                let distro = settings
                    .get("distribution")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                format!("WSL: {distro}")
            }
            _ => type_id.to_string(),
        }
    }

    /// Insert a raw session entry for testing.
    #[cfg(test)]
    pub async fn insert_test_session(&self, session_id: &str, connection: Box<dyn ConnectionType>) {
        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id.to_string(),
            SessionEntry {
                connection,
                info: SessionInfo {
                    id: session_id.to_string(),
                    title: "test".to_string(),
                    connection_type: "mock".to_string(),
                    alive: true,
                    agent_id: None,
                },
                remote_session_id: None,
            },
        );
    }

    /// Read output from a connection and emit Tauri events.
    ///
    /// Coalesces pending output chunks into a single event (up to
    /// `MAX_COALESCE_BYTES`) to reduce IPC overhead.
    async fn run_output_reader<E: EventEmitter>(
        session_id: String,
        mut output_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
        emitter: E,
        sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
        persistent_sessions: Arc<Mutex<HashMap<String, PersistentRecord>>>,
        wait_for_clear: bool,
    ) {
        // Phase 1: optionally buffer until the screen-clear sequence.
        if wait_for_clear {
            let deadline = Instant::now() + CLEAR_WAIT_TIMEOUT;

            let mut buffer = Vec::new();

            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match tokio::time::timeout(remaining, output_rx.recv()).await {
                    Ok(Some(chunk)) => {
                        buffer.extend_from_slice(&chunk);
                        if contains_screen_clear(&buffer) {
                            break;
                        }
                    }
                    Ok(None) => {
                        // Channel closed during startup.
                        Self::emit_and_cleanup(
                            &session_id,
                            buffer,
                            &emitter,
                            &sessions,
                            &persistent_sessions,
                        )
                        .await;
                        return;
                    }
                    Err(_) => break, // Timeout
                }
            }

            // Flush the buffered output as a single event.
            if !buffer.is_empty() {
                let event = TerminalOutputEvent {
                    session_id: session_id.clone(),
                    data: buffer,
                };
                if !emitter.emit_output(&event) {
                    return;
                }
            }
        }

        // Phase 2: normal streaming with coalescing.
        let mut coalescer = OutputCoalescer::new(MAX_COALESCE_BYTES);
        while let Some(first_chunk) = output_rx.recv().await {
            coalescer.push(&first_chunk);

            // Drain any immediately available chunks.
            while coalescer.pending_len() < MAX_COALESCE_BYTES {
                match output_rx.try_recv() {
                    Ok(chunk) => {
                        coalescer.push(&chunk);
                    }
                    Err(_) => break,
                }
            }

            if let Some(data) = coalescer.flush() {
                let event = TerminalOutputEvent {
                    session_id: session_id.clone(),
                    data,
                };
                if !emitter.emit_output(&event) {
                    error!("Failed to emit terminal-output event");
                    break;
                }
            }
        }

        Self::emit_and_cleanup(
            &session_id,
            Vec::new(),
            &emitter,
            &sessions,
            &persistent_sessions,
        )
        .await;
    }

    /// Emit remaining data (if any), send the exit event, and remove the session.
    ///
    /// If the session is registered as a persistent session, also removes the
    /// persistent registry entry and emits a "stopped" state event so the
    /// frontend clears the stale green dot. This covers the case where the
    /// agent SSH connection drops while a persistent shell daemon is still
    /// running: the desktop output reader exits, which must invalidate the
    /// persistent session entry or the user can never re-attach (the next
    /// `attach_persistent_tab` call would fail with `SessionNotFound`).
    async fn emit_and_cleanup<E: EventEmitter>(
        session_id: &str,
        data: Vec<u8>,
        emitter: &E,
        sessions: &Arc<Mutex<HashMap<String, SessionEntry>>>,
        persistent_sessions: &Arc<Mutex<HashMap<String, PersistentRecord>>>,
    ) {
        if !data.is_empty() {
            let event = TerminalOutputEvent {
                session_id: session_id.to_string(),
                data,
            };
            emitter.emit_output(&event);
        }

        let exit_event = TerminalExitEvent {
            session_id: session_id.to_string(),
            exit_code: None,
        };
        emitter.emit_exit(&exit_event);

        {
            let mut sessions = sessions.lock().await;
            sessions.remove(session_id);
        }

        // If this was a persistent session, clear its registry entry and notify
        // the frontend. Without this the frontend retains a stale "running" state
        // and any subsequent attach attempt fails with SessionNotFound.
        let stale_connection_id = {
            let mut ps = persistent_sessions.lock().await;
            let conn_id = ps
                .iter()
                .find(|(_, r)| r.session_id == session_id)
                .map(|(k, _)| k.clone());
            if let Some(ref cid) = conn_id {
                ps.remove(cid);
            }
            conn_id
        };
        if let Some(connection_id) = stale_connection_id {
            emitter.emit_persistent_state(&PersistentSessionStateEvent {
                connection_id,
                session_id: Some(session_id.to_string()),
                state: "stopped".to_string(),
                attached_tab_count: 0,
                error_message: None,
            });
            info!("Persistent session stopped due to backend exit: {session_id}");
        }

        info!("Session ended: {session_id}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::Value;
    use termihub_core::connection::{Capabilities, OutputReceiver, SettingsSchema};
    use termihub_core::errors::SessionError;
    use termihub_core::files::FileBrowser;
    use termihub_core::monitoring::MonitoringProvider;

    use termihub_core::monitoring::MonitoringSender;

    use crate::connection::config::AgentSettings;
    use crate::terminal::agent_manager::{
        AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
        AgentFolderInfo, AgentRpcClient, AgentSessionInfo,
    };
    use crate::terminal::backend::{OutputSender, RemoteAgentConfig};

    /// A minimal mock connection without file browser capability.
    struct MockConnection;

    #[async_trait::async_trait]
    impl ConnectionType for MockConnection {
        fn type_id(&self) -> &str {
            "mock"
        }
        fn display_name(&self) -> &str {
            "Mock"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: vec![] }
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                monitoring: false,
                file_browser: false,
                resize: true,
                persistent: false,
            }
        }
        async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
            Ok(())
        }
        async fn disconnect(&mut self) -> Result<(), SessionError> {
            Ok(())
        }
        fn is_connected(&self) -> bool {
            true
        }
        fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
            Ok(())
        }
        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
            Ok(())
        }
        fn subscribe_output(&self) -> OutputReceiver {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }
        fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
            None
        }
        fn file_browser(&self) -> Option<&dyn FileBrowser> {
            None
        }
    }

    /// Helper to create a sessions map and insert a mock session.
    async fn sessions_with_mock(session_id: &str) -> Arc<Mutex<HashMap<String, SessionEntry>>> {
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let mut map = sessions.lock().await;
        map.insert(
            session_id.to_string(),
            SessionEntry {
                connection: Box::new(MockConnection),
                info: SessionInfo {
                    id: session_id.to_string(),
                    title: "Mock".to_string(),
                    connection_type: "mock".to_string(),
                    alive: true,
                    agent_id: None,
                },
                remote_session_id: None,
            },
        );
        drop(map);
        sessions
    }

    // ── MockEventEmitter ─────────────────────────────────────────────

    #[derive(Clone, Default)]
    struct MockEventEmitter {
        outputs: std::sync::Arc<std::sync::Mutex<Vec<TerminalOutputEvent>>>,
        exits: std::sync::Arc<std::sync::Mutex<Vec<TerminalExitEvent>>>,
        persistent_states: std::sync::Arc<std::sync::Mutex<Vec<PersistentSessionStateEvent>>>,
        fail_output: bool,
    }

    impl MockEventEmitter {
        fn new() -> Self {
            Self::default()
        }
        fn failing() -> Self {
            Self {
                fail_output: true,
                ..Self::default()
            }
        }
    }

    impl EventEmitter for MockEventEmitter {
        fn emit_output(&self, event: &TerminalOutputEvent) -> bool {
            if self.fail_output {
                return false;
            }
            self.outputs.lock().unwrap().push(event.clone());
            true
        }
        fn emit_exit(&self, event: &TerminalExitEvent) {
            self.exits.lock().unwrap().push(event.clone());
        }
        fn emit_persistent_state(&self, event: &PersistentSessionStateEvent) {
            self.persistent_states.lock().unwrap().push(event.clone());
        }
    }

    /// Test that file browser access returns an error when the connection
    /// has no file browser capability.
    #[tokio::test]
    async fn file_browser_returns_none_for_mock_connection() {
        let sessions = sessions_with_mock("sess-1").await;
        let sessions_guard = sessions.lock().await;
        let entry = sessions_guard.get("sess-1").unwrap();
        assert!(
            entry.connection.file_browser().is_none(),
            "MockConnection should not have file browser capability"
        );
    }

    /// Test that looking up a nonexistent session returns SessionNotFound.
    #[tokio::test]
    async fn nonexistent_session_returns_not_found() {
        let sessions: Arc<Mutex<HashMap<String, SessionEntry>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let sessions_guard = sessions.lock().await;
        let result = sessions_guard.get("nonexistent");
        assert!(result.is_none());
    }

    /// Test write and resize work on mock connection.
    #[tokio::test]
    async fn write_and_resize_on_mock_session() {
        let sessions = sessions_with_mock("sess-1").await;
        let sessions_guard = sessions.lock().await;
        let entry = sessions_guard.get("sess-1").unwrap();
        assert!(entry.connection.write(b"hello").is_ok());
        assert!(entry.connection.resize(80, 24).is_ok());
    }

    /// Test session removal.
    #[tokio::test]
    async fn remove_session() {
        let sessions = sessions_with_mock("sess-1").await;
        {
            let mut sessions_guard = sessions.lock().await;
            sessions_guard.remove("sess-1");
        }
        let sessions_guard = sessions.lock().await;
        assert!(!sessions_guard.contains_key("sess-1"));
    }

    #[test]
    fn build_title_docker_explicit_runtime() {
        let settings = serde_json::json!({"image": "ubuntu:22.04", "runtime": "docker"});
        let title = SessionManager::build_title("docker", &settings, None);
        assert_eq!(title, "Docker: ubuntu:22.04");
    }

    #[test]
    fn build_title_docker_podman_runtime() {
        let settings = serde_json::json!({"image": "alpine", "runtime": "podman"});
        let title = SessionManager::build_title("docker", &settings, None);
        assert_eq!(title, "Podman: alpine");
    }

    #[test]
    fn build_title_docker_auto_runtime() {
        let settings = serde_json::json!({"image": "nginx", "runtime": "auto"});
        let title = SessionManager::build_title("docker", &settings, None);
        assert_eq!(title, "Container: nginx");
    }

    #[test]
    fn build_title_docker_missing_runtime_defaults_to_container() {
        let settings = serde_json::json!({"image": "redis"});
        let title = SessionManager::build_title("docker", &settings, None);
        assert_eq!(title, "Container: redis");
    }

    #[test]
    fn build_title_docker_missing_image() {
        let settings = serde_json::json!({"runtime": "docker"});
        let title = SessionManager::build_title("docker", &settings, None);
        assert_eq!(title, "Docker: unknown");
    }

    #[test]
    fn build_title_proxy_session_uses_connection_info_not_agent_id() {
        let settings =
            serde_json::json!({"username": "alice", "host": "db-01.example.com", "port": 22});
        let title = SessionManager::build_title("ssh", &settings, Some("production-server"));
        // Proxy sessions get the same descriptive title as local sessions.
        assert_eq!(title, "SSH: alice@db-01.example.com");
    }

    // ── EventEmitter DI tests ─────────────────────────────────────────

    fn empty_persistent_sessions() -> Arc<Mutex<HashMap<String, PersistentRecord>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }

    #[tokio::test]
    async fn emit_and_cleanup_sends_exit_event() {
        let emitter = MockEventEmitter::new();
        let sessions = sessions_with_mock("sess-exit").await;

        SessionManager::emit_and_cleanup(
            "sess-exit",
            Vec::new(),
            &emitter,
            &sessions,
            &empty_persistent_sessions(),
        )
        .await;

        {
            let exits = emitter.exits.lock().unwrap();
            assert_eq!(exits.len(), 1);
            assert_eq!(exits[0].session_id, "sess-exit");
        }
        // Session should be removed after cleanup
        assert!(!sessions.lock().await.contains_key("sess-exit"));
    }

    #[tokio::test]
    async fn emit_and_cleanup_flushes_remaining_data() {
        let emitter = MockEventEmitter::new();
        let sessions = sessions_with_mock("sess-data").await;

        SessionManager::emit_and_cleanup(
            "sess-data",
            b"final bytes".to_vec(),
            &emitter,
            &sessions,
            &empty_persistent_sessions(),
        )
        .await;

        {
            let outputs = emitter.outputs.lock().unwrap();
            assert_eq!(outputs.len(), 1);
            assert_eq!(outputs[0].data, b"final bytes");
        }
    }

    #[tokio::test]
    async fn run_output_reader_emits_chunks_and_exit() {
        let emitter = MockEventEmitter::new();
        let sessions = sessions_with_mock("sess-stream").await;
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);

        tx.send(b"hello ".to_vec()).await.unwrap();
        tx.send(b"world".to_vec()).await.unwrap();
        drop(tx); // signal EOF

        SessionManager::run_output_reader(
            "sess-stream".to_string(),
            rx,
            emitter.clone(),
            sessions.clone(),
            empty_persistent_sessions(),
            false,
        )
        .await;

        {
            let outputs = emitter.outputs.lock().unwrap();
            let combined: Vec<u8> = outputs
                .iter()
                .flat_map(|e| e.data.iter().copied())
                .collect();
            assert!(
                combined.windows(5).any(|w| w == b"hello"),
                "expected 'hello' in output"
            );
        }
        {
            let exits = emitter.exits.lock().unwrap();
            assert_eq!(exits.len(), 1);
        }
    }

    #[tokio::test]
    async fn run_output_reader_stops_on_emitter_failure() {
        let emitter = MockEventEmitter::failing();
        let sessions = sessions_with_mock("sess-fail").await;
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);

        tx.send(b"data".to_vec()).await.unwrap();

        // run_output_reader should return quickly when emit_output returns false
        SessionManager::run_output_reader(
            "sess-fail".to_string(),
            rx,
            emitter.clone(),
            sessions,
            empty_persistent_sessions(),
            false,
        )
        .await;

        // No outputs recorded (emitter failed)
        let outputs = emitter.outputs.lock().unwrap();
        assert!(outputs.is_empty());
    }

    /// Regression: when a persistent session's output channel closes (e.g. agent
    /// SSH disconnect), `emit_and_cleanup` must remove the persistent registry
    /// entry and emit a "stopped" state event.  Without this the frontend retains
    /// a stale "running" green dot and any subsequent attach attempt fails with
    /// SessionNotFound.
    #[tokio::test]
    async fn emit_and_cleanup_emits_stopped_for_persistent_session() {
        let emitter = MockEventEmitter::new();
        let sessions = sessions_with_mock("sess-ps").await;
        let persistent_sessions: Arc<Mutex<HashMap<String, PersistentRecord>>> =
            Arc::new(Mutex::new(HashMap::new()));
        {
            let mut ps = persistent_sessions.lock().await;
            ps.insert(
                "conn-ps".to_string(),
                PersistentRecord {
                    connection_id: "conn-ps".to_string(),
                    session_id: "sess-ps".to_string(),
                    attached_tabs: HashSet::new(),
                },
            );
        }

        SessionManager::emit_and_cleanup(
            "sess-ps",
            Vec::new(),
            &emitter,
            &sessions,
            &persistent_sessions,
        )
        .await;

        // Persistent registry entry must be cleared.
        assert!(
            !persistent_sessions.lock().await.contains_key("conn-ps"),
            "stale persistent record must be removed"
        );

        // A "stopped" event must have been emitted.
        let ps_events = emitter.persistent_states.lock().unwrap();
        assert_eq!(ps_events.len(), 1, "exactly one persistent state event");
        assert_eq!(ps_events[0].state, "stopped");
        assert_eq!(ps_events[0].connection_id, "conn-ps");
        assert_eq!(ps_events[0].session_id.as_deref(), Some("sess-ps"));
    }

    /// Non-persistent sessions must not trigger any persistent-state events on
    /// backend exit — `emit_and_cleanup` should leave the persistent registry
    /// unchanged.
    #[tokio::test]
    async fn emit_and_cleanup_does_not_emit_stopped_for_non_persistent_session() {
        let emitter = MockEventEmitter::new();
        let sessions = sessions_with_mock("sess-local").await;

        SessionManager::emit_and_cleanup(
            "sess-local",
            Vec::new(),
            &emitter,
            &sessions,
            &empty_persistent_sessions(),
        )
        .await;

        let ps_events = emitter.persistent_states.lock().unwrap();
        assert!(
            ps_events.is_empty(),
            "no persistent state event for non-persistent session"
        );
    }

    // ── DisconnectSpy ─────────────────────────────────────────────────

    /// A connection that records whether `disconnect()` was called.
    struct DisconnectSpy {
        disconnected: Arc<AtomicBool>,
    }

    impl DisconnectSpy {
        fn new(flag: Arc<AtomicBool>) -> Self {
            Self { disconnected: flag }
        }
    }

    #[async_trait::async_trait]
    impl ConnectionType for DisconnectSpy {
        fn type_id(&self) -> &str {
            "spy"
        }
        fn display_name(&self) -> &str {
            "Spy"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: vec![] }
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                monitoring: false,
                file_browser: false,
                resize: false,
                persistent: false,
            }
        }
        async fn connect(&mut self, _: serde_json::Value) -> Result<(), SessionError> {
            Ok(())
        }
        async fn disconnect(&mut self) -> Result<(), SessionError> {
            self.disconnected.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn is_connected(&self) -> bool {
            true
        }
        fn write(&self, _: &[u8]) -> Result<(), SessionError> {
            Ok(())
        }
        fn resize(&self, _: u16, _: u16) -> Result<(), SessionError> {
            Ok(())
        }
        fn subscribe_output(&self) -> OutputReceiver {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }
        fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
            None
        }
        fn file_browser(&self) -> Option<&dyn FileBrowser> {
            None
        }
    }

    // ── NullAgent ────────────────────────────────────────────────────

    /// A no-op `AgentRpcClient` for tests that construct a full `SessionManager`.
    struct NullAgent;

    impl AgentRpcClient for NullAgent {
        fn connect_agent(
            &self,
            _: &str,
            _: &RemoteAgentConfig,
            _: Option<&AgentSettings>,
        ) -> Result<AgentConnectResult, TerminalError> {
            unimplemented!()
        }
        fn disconnect_agent(&self, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn is_connected(&self, _: &str) -> bool {
            false
        }
        fn get_capabilities(&self, _: &str) -> Option<AgentCapabilities> {
            None
        }
        fn shutdown_agent(&self, _: &str, _: Option<&str>) -> Result<u32, TerminalError> {
            unimplemented!()
        }
        fn send_request(&self, _: &str, _: &str, _: Value) -> Result<Value, TerminalError> {
            unimplemented!()
        }
        fn create_session(
            &self,
            _: &str,
            _: &str,
            _: Value,
            _: Option<&str>,
        ) -> Result<AgentSessionInfo, TerminalError> {
            unimplemented!()
        }
        fn attach_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn close_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn list_sessions(&self, _: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
            unimplemented!()
        }
        fn list_connections_and_folders(
            &self,
            _: &str,
        ) -> Result<AgentConnectionsData, TerminalError> {
            unimplemented!()
        }
        fn list_definitions(&self, _: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
            unimplemented!()
        }
        fn save_definition(&self, _: &str, _: Value) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn update_definition(
            &self,
            _: &str,
            _: Value,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_definition(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn create_folder(
            &self,
            _: &str,
            _: &str,
            _: Option<&str>,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn update_folder(&self, _: &str, _: Value) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_folder(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn register_session_output(
            &self,
            _: &str,
            _: &str,
            _: OutputSender,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn unregister_session_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn register_monitoring_output(
            &self,
            _: &str,
            _: &str,
            _: MonitoringSender,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn unregister_monitoring_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn send_session_input(&self, _: &str, _: &str, _: &[u8]) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn resize_session(&self, _: &str, _: &str, _: u16, _: u16) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn apply_agent_settings(&self, _: &str, _: &AgentSettings) -> Result<(), TerminalError> {
            unimplemented!()
        }
    }

    // ── get_remote_session_buffer tests ──────────────────────────────

    #[tokio::test]
    async fn get_remote_session_buffer_returns_error_for_nonexistent_session() {
        let registry = ConnectionTypeRegistry::new();
        let manager = SessionManager::new(registry, Arc::new(NullAgent));
        let result = manager.get_remote_session_buffer("no-such-session").await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            TerminalError::SessionNotFound(_)
        ));
    }

    #[tokio::test]
    async fn get_remote_session_buffer_returns_remote_error_for_local_session() {
        let registry = ConnectionTypeRegistry::new();
        let manager = SessionManager::new(registry, Arc::new(NullAgent));
        manager
            .insert_test_session("local-sess", Box::new(MockConnection))
            .await;
        let result = manager.get_remote_session_buffer("local-sess").await;
        assert!(result.is_err());
        // Local sessions have no agent_id → RemoteError("not a remote session")
        assert!(matches!(result.unwrap_err(), TerminalError::RemoteError(_)));
    }

    // ── Regression test: close_session must call disconnect() ─────────

    /// Regression test for the serial port cleanup bug.
    ///
    /// Before the fix, `close_session()` removed the entry without calling
    /// `disconnect()`. Serial's reader thread only stops when `disconnect()`
    /// clears `output_tx`. This test verifies that `disconnect()` is called.
    #[tokio::test]
    async fn close_session_calls_disconnect_on_connection() {
        let registry = ConnectionTypeRegistry::new();
        let manager = SessionManager::new(registry, Arc::new(NullAgent));

        let disconnected = Arc::new(AtomicBool::new(false));
        let spy = DisconnectSpy::new(disconnected.clone());

        manager.insert_test_session("spy-1", Box::new(spy)).await;

        manager.close_session("spy-1").await.unwrap();

        assert!(
            disconnected.load(Ordering::SeqCst),
            "disconnect() must be called when a session is closed"
        );
    }

    // ── MockPersistentEmitter ─────────────────────────────────────────

    #[derive(Clone, Default)]
    struct MockPersistentEmitter {
        persistent_events: std::sync::Arc<std::sync::Mutex<Vec<PersistentSessionStateEvent>>>,
    }

    impl MockPersistentEmitter {
        fn new() -> Self {
            Self::default()
        }

        fn events(&self) -> Vec<PersistentSessionStateEvent> {
            self.persistent_events.lock().unwrap().clone()
        }
    }

    impl EventEmitter for MockPersistentEmitter {
        fn emit_output(&self, _event: &TerminalOutputEvent) -> bool {
            true
        }
        fn emit_exit(&self, _event: &TerminalExitEvent) {}
        fn emit_persistent_state(&self, event: &PersistentSessionStateEvent) {
            self.persistent_events.lock().unwrap().push(event.clone());
        }
    }

    /// Build a `SessionManager` wired with a "mock" connection type for tests.
    fn make_test_manager() -> SessionManager {
        let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
        registry.register(
            "mock",
            "Mock",
            "mock",
            Box::new(|| Box::new(MockConnection)),
        );
        let agent_manager = Arc::new(NullAgent);
        SessionManager::new(registry, agent_manager)
    }

    // ── Persistent session tests ──────────────────────────────────────

    #[tokio::test]
    async fn start_persistent_session_creates_record_and_emits_running() {
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        let session_id = manager
            .start_persistent_session(
                "conn-p1",
                "mock",
                serde_json::json!({}),
                None,
                emitter.clone(),
            )
            .await
            .expect("start should succeed");

        assert!(!session_id.is_empty());

        let ps = manager.persistent_sessions.lock().await;
        assert!(ps.contains_key("conn-p1"), "record must be inserted");
        assert_eq!(ps["conn-p1"].session_id, session_id);
        drop(ps);

        let events = emitter.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].state, "running");
        assert_eq!(events[0].connection_id, "conn-p1");
        assert_eq!(events[0].session_id.as_deref(), Some(session_id.as_str()));
        assert_eq!(events[0].attached_tab_count, 0);
    }

    #[tokio::test]
    async fn start_persistent_session_is_idempotent() {
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        let first = manager
            .start_persistent_session(
                "conn-p1",
                "mock",
                serde_json::json!({}),
                None,
                emitter.clone(),
            )
            .await
            .unwrap();
        let second = manager
            .start_persistent_session(
                "conn-p1",
                "mock",
                serde_json::json!({}),
                None,
                emitter.clone(),
            )
            .await
            .unwrap();

        assert_eq!(first, second, "idempotent call must return same session ID");
        assert_eq!(
            emitter.events().len(),
            1,
            "only the first start should emit an event"
        );
    }

    #[tokio::test]
    async fn stop_persistent_session_removes_record_and_emits_stopped() {
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        manager
            .start_persistent_session(
                "conn-p1",
                "mock",
                serde_json::json!({}),
                None,
                emitter.clone(),
            )
            .await
            .unwrap();

        manager
            .stop_persistent_session("conn-p1", emitter.clone())
            .await
            .unwrap();

        let ps = manager.persistent_sessions.lock().await;
        assert!(
            !ps.contains_key("conn-p1"),
            "record must be removed on stop"
        );
        drop(ps);

        let events = emitter.events();
        let last = events.last().expect("at least one event");
        assert_eq!(last.state, "stopped");
    }

    #[tokio::test]
    async fn attach_persistent_tab_emits_attached_with_tab_count() {
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        manager
            .start_persistent_session(
                "conn-p1",
                "mock",
                serde_json::json!({}),
                None,
                emitter.clone(),
            )
            .await
            .unwrap();

        let count = manager
            .attach_persistent_tab("conn-p1", "tab-1", emitter.clone())
            .await
            .unwrap();
        assert_eq!(count, 1);

        let events = emitter.events();
        let last = events.last().unwrap();
        assert_eq!(last.state, "attached");
        assert_eq!(last.attached_tab_count, 1);
    }

    #[tokio::test]
    async fn detach_persistent_tab_emits_running_when_no_tabs_remain() {
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        manager
            .start_persistent_session(
                "conn-p1",
                "mock",
                serde_json::json!({}),
                None,
                emitter.clone(),
            )
            .await
            .unwrap();

        manager
            .attach_persistent_tab("conn-p1", "tab-1", emitter.clone())
            .await
            .unwrap();

        let session_id = {
            let ps = manager.persistent_sessions.lock().await;
            ps["conn-p1"].session_id.clone()
        };

        let count = manager
            .detach_persistent_tab(&session_id, "tab-1", emitter.clone())
            .await
            .unwrap();
        assert_eq!(count, 0);

        let events = emitter.events();
        let last = events.last().unwrap();
        assert_eq!(last.state, "running");
        assert_eq!(last.attached_tab_count, 0);
    }

    #[tokio::test]
    async fn list_persistent_sessions_returns_registered_sessions() {
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        let session_id = manager
            .start_persistent_session(
                "conn-p1",
                "mock",
                serde_json::json!({}),
                None,
                emitter.clone(),
            )
            .await
            .unwrap();

        let list = manager.list_persistent_sessions().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].connection_id, "conn-p1");
        assert_eq!(list[0].session_id, session_id);
        assert_eq!(list[0].attached_tab_count, 0);
    }

    /// Verify `PersistentSessionStateEvent` serialises with snake_case field names
    /// so the TypeScript frontend's `event.payload.connection_id` etc. resolve correctly.
    #[test]
    fn persistent_session_state_event_serialises_snake_case() {
        let event = PersistentSessionStateEvent {
            connection_id: "agent-1:def-1".to_string(),
            session_id: Some("sess-abc".to_string()),
            state: "running".to_string(),
            attached_tab_count: 2,
            error_message: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(
            json.contains("\"connection_id\""),
            "must use snake_case; got: {json}"
        );
        assert!(
            json.contains("\"session_id\""),
            "must use snake_case; got: {json}"
        );
        assert!(
            json.contains("\"attached_tab_count\""),
            "must use snake_case; got: {json}"
        );
        assert!(
            !json.contains("\"connectionId\"") && !json.contains("\"sessionId\""),
            "camelCase must not appear; got: {json}"
        );
    }

    // ── SpyAgent for attach_persistent_tab regression tests ──────────

    type AttachLog = std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>;

    /// An `AgentRpcClient` implementation that records `attach_session` calls.
    struct SpyAgent {
        attach_calls: AttachLog,
    }

    impl SpyAgent {
        fn new() -> (Self, AttachLog) {
            let calls: AttachLog = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            (
                Self {
                    attach_calls: calls.clone(),
                },
                calls,
            )
        }
    }

    impl AgentRpcClient for SpyAgent {
        fn connect_agent(
            &self,
            _: &str,
            _: &RemoteAgentConfig,
            _: Option<&AgentSettings>,
        ) -> Result<AgentConnectResult, TerminalError> {
            unimplemented!()
        }
        fn disconnect_agent(&self, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn is_connected(&self, _: &str) -> bool {
            false
        }
        fn get_capabilities(&self, _: &str) -> Option<AgentCapabilities> {
            None
        }
        fn shutdown_agent(&self, _: &str, _: Option<&str>) -> Result<u32, TerminalError> {
            unimplemented!()
        }
        fn send_request(&self, _: &str, _: &str, _: Value) -> Result<Value, TerminalError> {
            unimplemented!()
        }
        fn create_session(
            &self,
            _: &str,
            _: &str,
            _: Value,
            _: Option<&str>,
        ) -> Result<AgentSessionInfo, TerminalError> {
            unimplemented!()
        }
        fn attach_session(&self, agent_id: &str, remote_sid: &str) -> Result<(), TerminalError> {
            self.attach_calls
                .lock()
                .unwrap()
                .push((agent_id.to_string(), remote_sid.to_string()));
            Ok(())
        }
        fn close_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn list_sessions(&self, _: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
            unimplemented!()
        }
        fn list_connections_and_folders(
            &self,
            _: &str,
        ) -> Result<AgentConnectionsData, TerminalError> {
            unimplemented!()
        }
        fn list_definitions(&self, _: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
            unimplemented!()
        }
        fn save_definition(&self, _: &str, _: Value) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn update_definition(
            &self,
            _: &str,
            _: Value,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_definition(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn create_folder(
            &self,
            _: &str,
            _: &str,
            _: Option<&str>,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn update_folder(&self, _: &str, _: Value) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_folder(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn register_session_output(
            &self,
            _: &str,
            _: &str,
            _: OutputSender,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn unregister_session_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn register_monitoring_output(
            &self,
            _: &str,
            _: &str,
            _: MonitoringSender,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn unregister_monitoring_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn send_session_input(&self, _: &str, _: &str, _: &[u8]) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn resize_session(&self, _: &str, _: &str, _: u16, _: u16) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn apply_agent_settings(&self, _: &str, _: &AgentSettings) -> Result<(), TerminalError> {
            unimplemented!()
        }
    }

    /// Regression test: `attach_persistent_tab` must call `attach_session` on the
    /// agent manager for remote-agent sessions so the DaemonClient reconnects and
    /// sends a fresh buffer replay via the notification path.
    ///
    /// Without the fix, the DaemonClient could be stale and
    /// `get_remote_session_buffer` would time out, leaving the new tab blank.
    #[tokio::test]
    async fn attach_persistent_tab_triggers_daemon_reattach_for_agent_session() {
        let (spy, attach_calls) = SpyAgent::new();

        let mut registry = ConnectionTypeRegistry::new();
        registry.register(
            "mock",
            "Mock",
            "mock",
            Box::new(|| Box::new(MockConnection)),
        );
        let manager = SessionManager::new(registry, Arc::new(spy));
        let emitter = MockPersistentEmitter::new();

        let session_id = manager
            .start_persistent_session(
                "conn-1",
                "mock",
                serde_json::json!({}),
                None,
                emitter.clone(),
            )
            .await
            .unwrap();

        // Mark the session as agent-mediated.
        {
            let mut sessions = manager.sessions.lock().await;
            let entry = sessions.get_mut(&session_id).unwrap();
            entry.info.agent_id = Some("agent-1".to_string());
            entry.remote_session_id = Some("remote-1".to_string());
        }

        manager
            .attach_persistent_tab("conn-1", "tab-1", emitter.clone())
            .await
            .unwrap();

        // spawn_blocking runs in a separate thread; give it a moment.
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        let calls = attach_calls.lock().unwrap();
        assert_eq!(
            calls.len(),
            1,
            "attach_session must be called once for agent sessions"
        );
        assert_eq!(calls[0].0, "agent-1");
        assert_eq!(calls[0].1, "remote-1");
    }

    /// Regression: `attach_persistent_tab` must NOT call `attach_session` for
    /// local (non-agent) sessions where there is no agent_id or remote_session_id.
    #[tokio::test]
    async fn attach_persistent_tab_skips_daemon_reattach_for_local_session() {
        // NullAgent.attach_session panics (unimplemented!), so if it were called
        // by the local-session path this test would fail.
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        manager
            .start_persistent_session(
                "conn-local",
                "mock",
                serde_json::json!({}),
                None,
                emitter.clone(),
            )
            .await
            .unwrap();

        // Should succeed without panicking (no attach_session call).
        manager
            .attach_persistent_tab("conn-local", "tab-1", emitter.clone())
            .await
            .unwrap();

        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        // No assertion needed: if NullAgent.attach_session were called it would panic.
    }

    /// Tauri events are consumed by the TypeScript frontend which uses snake_case
    /// property names in the payload interface.  Verify that `SessionMonitoringStatsEvent`
    /// serialises `session_id` as `session_id` (not `sessionId`) so the frontend's
    /// `event.payload.session_id` receives the value.
    #[test]
    fn session_monitoring_stats_event_serialises_session_id_as_snake_case() {
        use termihub_core::monitoring::SystemStats;
        let event = SessionMonitoringStatsEvent {
            session_id: "test-session-123".to_string(),
            stats: SystemStats {
                hostname: "host".to_string(),
                uptime_seconds: 0.0,
                load_average: [0.0; 3],
                cpu_usage_percent: 0.0,
                memory_total_kb: 0,
                memory_available_kb: 0,
                memory_used_percent: 0.0,
                disk_total_kb: 0,
                disk_used_kb: 0,
                disk_used_percent: 0.0,
                os_info: String::new(),
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(
            json.contains("\"session_id\""),
            "expected snake_case key; got: {json}"
        );
        assert!(
            !json.contains("\"sessionId\""),
            "camelCase key must not appear; got: {json}"
        );
    }
}
