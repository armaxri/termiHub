//! Unified session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Replaces the legacy `TerminalManager` with a single manager that holds
//! `Box<dyn ConnectionType>` for both local and remote (agent-mediated)
//! connections. Local connections use the core backend implementations;
//! remote connections use [`RemoteProxy`](super::remote_proxy::RemoteProxy).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use termihub_core::buffer::RingBuffer;

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

/// Ring buffer size for persistent session output replay (1 MiB).
const PERSISTENT_BUFFER_SIZE: usize = 1_048_576;

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
    /// Circular output buffer — captures output even when no tab is attached.
    output_buffer: Arc<StdMutex<RingBuffer>>,
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
}

/// Internal session entry held by the manager.
struct SessionEntry {
    connection: Box<dyn ConnectionType>,
    info: SessionInfo,
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
        output_buffer: Option<Arc<StdMutex<RingBuffer>>>,
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

        let connection: Box<dyn ConnectionType> = if let Some(aid) = agent_id {
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
            Box::new(proxy)
        } else {
            // Local: instantiate from registry.
            let mut conn = self
                .registry
                .create(type_id)
                .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
            conn.connect(settings.clone())
                .await
                .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
            conn
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
        };

        // Store session.
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                session_id.clone(),
                SessionEntry {
                    connection,
                    info: info.clone(),
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
        let sid = session_id.clone();
        tokio::spawn(async move {
            Self::run_output_reader(
                sid,
                output_rx,
                emitter,
                sessions_clone,
                has_initial_command,
                output_buffer,
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
    pub async fn close_session(&self, session_id: &str) -> Result<(), TerminalError> {
        let mut sessions = self.sessions.lock().await;
        if let Some(_entry) = sessions.remove(session_id) {
            // Connection will be dropped, triggering cleanup.
            // For async disconnect, we'd need to spawn a task, but drop
            // should handle cleanup for well-behaved backends.
            info!(session_id, "Closed session");
        }
        Ok(())
    }

    /// List all active sessions.
    #[allow(dead_code)]
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

        let ring_buffer = Arc::new(StdMutex::new(RingBuffer::new(PERSISTENT_BUFFER_SIZE)));
        let session_id = self
            .create_connection(
                type_id,
                settings,
                agent_id,
                emitter.clone(),
                Some(ring_buffer.clone()),
            )
            .await?;

        {
            let mut ps = self.persistent_sessions.lock().await;
            ps.insert(
                connection_id.to_string(),
                PersistentRecord {
                    connection_id: connection_id.to_string(),
                    session_id: session_id.clone(),
                    attached_tabs: HashSet::new(),
                    output_buffer: ring_buffer,
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
        let count = {
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
            record.attached_tabs.len() as u32
        };

        let (sid, state) = {
            let ps = self.persistent_sessions.lock().await;
            let record = ps.get(connection_id).unwrap();
            (
                record.session_id.clone(),
                if count > 0 { "attached" } else { "running" }.to_string(),
            )
        };

        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.to_string(),
            session_id: Some(sid),
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

    /// Return all output buffered so far for a persistent session.
    ///
    /// Returns an empty `Vec` if the connection ID is unknown.
    /// The buffer is NOT cleared — the same bytes will be returned on the
    /// next call (only the most-recent 1 MiB is retained due to ring-buffer
    /// wrapping).
    pub async fn get_persistent_session_buffer(&self, connection_id: &str) -> Vec<u8> {
        let ps = self.persistent_sessions.lock().await;
        ps.get(connection_id)
            .and_then(|r| r.output_buffer.lock().ok().map(|rb| rb.read_all()))
            .unwrap_or_default()
    }

    // ── End persistent session management ──────────────────────────────

    /// Build a human-readable title from type and settings.
    fn build_title(type_id: &str, settings: &serde_json::Value, agent_id: Option<&str>) -> String {
        if let Some(aid) = agent_id {
            return format!("Remote: {aid}");
        }
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

    /// Read output from a connection and emit Tauri events.
    ///
    /// Coalesces pending output chunks into a single event (up to
    /// `MAX_COALESCE_BYTES`) to reduce IPC overhead.
    async fn run_output_reader<E: EventEmitter>(
        session_id: String,
        mut output_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
        emitter: E,
        sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
        wait_for_clear: bool,
        output_buffer: Option<Arc<StdMutex<RingBuffer>>>,
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
                        if let Some(ref buf) = output_buffer {
                            if let Ok(mut rb) = buf.lock() {
                                rb.write(&chunk);
                            }
                        }
                        buffer.extend_from_slice(&chunk);
                        if contains_screen_clear(&buffer) {
                            break;
                        }
                    }
                    Ok(None) => {
                        // Channel closed during startup.
                        Self::emit_and_cleanup(&session_id, buffer, &emitter, &sessions).await;
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
            if let Some(ref buf) = output_buffer {
                if let Ok(mut rb) = buf.lock() {
                    rb.write(&first_chunk);
                }
            }
            coalescer.push(&first_chunk);

            // Drain any immediately available chunks.
            while coalescer.pending_len() < MAX_COALESCE_BYTES {
                match output_rx.try_recv() {
                    Ok(chunk) => {
                        if let Some(ref buf) = output_buffer {
                            if let Ok(mut rb) = buf.lock() {
                                rb.write(&chunk);
                            }
                        }
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

        Self::emit_and_cleanup(&session_id, Vec::new(), &emitter, &sessions).await;
    }

    /// Emit remaining data (if any), send the exit event, and remove the session.
    async fn emit_and_cleanup<E: EventEmitter>(
        session_id: &str,
        data: Vec<u8>,
        emitter: &E,
        sessions: &Arc<Mutex<HashMap<String, SessionEntry>>>,
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

        info!("Session ended: {session_id}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use termihub_core::connection::{Capabilities, OutputReceiver, SettingsSchema};
    use termihub_core::errors::SessionError;
    use termihub_core::files::FileBrowser;
    use termihub_core::monitoring::MonitoringProvider;

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
                },
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

    // ── EventEmitter DI tests ─────────────────────────────────────────

    #[tokio::test]
    async fn emit_and_cleanup_sends_exit_event() {
        let emitter = MockEventEmitter::new();
        let sessions = sessions_with_mock("sess-exit").await;

        SessionManager::emit_and_cleanup("sess-exit", Vec::new(), &emitter, &sessions).await;

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

        SessionManager::emit_and_cleanup("sess-data", b"final bytes".to_vec(), &emitter, &sessions)
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
            false,
            None,
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
            false,
            None,
        )
        .await;

        // No outputs recorded (emitter failed)
        let outputs = emitter.outputs.lock().unwrap();
        assert!(outputs.is_empty());
    }

    // ── MockAgentRpcClient for persistent-session tests ──────────────

    use crate::connection::config::AgentSettings;
    use crate::terminal::agent_manager::{
        AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
        AgentFolderInfo, AgentSessionInfo,
    };
    use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
    use termihub_core::monitoring::MonitoringSender;

    /// Minimal no-op implementation — all agent methods are unreachable in
    /// persistent-session tests because `agent_id` is always `None`.
    struct MockAgentRpcClientForPersistentTests;

    impl crate::terminal::agent_manager::AgentRpcClient for MockAgentRpcClientForPersistentTests {
        fn connect_agent(
            &self,
            _: &str,
            _: &RemoteAgentConfig,
            _: Option<&AgentSettings>,
        ) -> Result<AgentConnectResult, TerminalError> {
            unreachable!()
        }
        fn disconnect_agent(&self, _: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn is_connected(&self, _: &str) -> bool {
            false
        }
        fn get_capabilities(&self, _: &str) -> Option<AgentCapabilities> {
            None
        }
        fn shutdown_agent(&self, _: &str, _: Option<&str>) -> Result<u32, TerminalError> {
            Ok(0)
        }
        fn send_request(
            &self,
            _: &str,
            _: &str,
            _: serde_json::Value,
        ) -> Result<serde_json::Value, TerminalError> {
            unreachable!()
        }
        fn create_session(
            &self,
            _: &str,
            _: &str,
            _: serde_json::Value,
            _: Option<&str>,
        ) -> Result<AgentSessionInfo, TerminalError> {
            unreachable!()
        }
        fn attach_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn close_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn list_sessions(&self, _: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
            Ok(vec![])
        }
        fn list_connections_and_folders(
            &self,
            _: &str,
        ) -> Result<AgentConnectionsData, TerminalError> {
            unreachable!()
        }
        fn list_definitions(&self, _: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
            Ok(vec![])
        }
        fn save_definition(
            &self,
            _: &str,
            _: serde_json::Value,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unreachable!()
        }
        fn update_definition(
            &self,
            _: &str,
            _: serde_json::Value,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unreachable!()
        }
        fn delete_definition(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn create_folder(
            &self,
            _: &str,
            _: &str,
            _: Option<&str>,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unreachable!()
        }
        fn update_folder(
            &self,
            _: &str,
            _: serde_json::Value,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unreachable!()
        }
        fn delete_folder(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn register_session_output(
            &self,
            _: &str,
            _: &str,
            _: OutputSender,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn unregister_session_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn register_monitoring_output(
            &self,
            _: &str,
            _: &str,
            _: MonitoringSender,
        ) -> Result<(), TerminalError> {
            Ok(())
        }
        fn unregister_monitoring_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
            Ok(())
        }
        fn send_session_input(&self, _: &str, _: &str, _: &[u8]) -> Result<(), TerminalError> {
            Ok(())
        }
        fn resize_session(&self, _: &str, _: &str, _: u16, _: u16) -> Result<(), TerminalError> {
            Ok(())
        }
        fn apply_agent_settings(&self, _: &str, _: &AgentSettings) -> Result<(), TerminalError> {
            Ok(())
        }
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
        let agent_manager = Arc::new(MockAgentRpcClientForPersistentTests);
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
