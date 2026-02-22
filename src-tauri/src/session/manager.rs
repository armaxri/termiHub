//! Unified session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Replaces the legacy `TerminalManager` with a single manager that holds
//! `Box<dyn ConnectionType>` for both local and remote (agent-mediated)
//! connections. Local connections use the core backend implementations;
//! remote connections use [`RemoteProxy`](super::remote_proxy::RemoteProxy).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use termihub_core::connection::{ConnectionType, ConnectionTypeInfo, ConnectionTypeRegistry};
use termihub_core::output::coalescer::OutputCoalescer;
use termihub_core::output::screen_clear::contains_screen_clear;
use tracing::{error, info};

use crate::terminal::agent_manager::AgentConnectionManager;
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

/// Error event emitted when a session-level error occurs.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct TerminalErrorEvent {
    pub session_id: String,
    pub message: String,
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

/// Manages all active connection sessions.
///
/// Holds a [`ConnectionTypeRegistry`] for creating local connections and
/// an [`AgentConnectionManager`] for creating remote (agent-mediated)
/// connections via [`RemoteProxy`].
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
    registry: Arc<ConnectionTypeRegistry>,
    agent_manager: Arc<AgentConnectionManager>,
}

impl SessionManager {
    /// Create a new session manager with the given registry and agent manager.
    pub fn new(
        registry: ConnectionTypeRegistry,
        agent_manager: Arc<AgentConnectionManager>,
    ) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            registry: Arc::new(registry),
            agent_manager,
        }
    }

    /// Create a new connection session.
    ///
    /// If `agent_id` is `Some`, creates a [`RemoteProxy`] that forwards
    /// to the specified agent. Otherwise, creates a local connection from
    /// the registry.
    ///
    /// Returns the session ID on success.
    pub async fn create_connection(
        &self,
        type_id: &str,
        settings: serde_json::Value,
        agent_id: Option<&str>,
        app_handle: AppHandle,
    ) -> Result<String, TerminalError> {
        // Enforce session limit.
        {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| TerminalError::SpawnFailed(format!("Failed to lock sessions: {e}")))?;
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
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| TerminalError::SpawnFailed(format!("Failed to lock sessions: {e}")))?;
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
                app_handle,
                sessions_clone,
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
                if let Ok(sessions) = sessions.lock() {
                    if let Some(entry) = sessions.get(&sid) {
                        let input = format!("{cmd}\n");
                        let _ = entry.connection.write(input.as_bytes());
                    }
                }
            });
        }

        info!(session_id = %session_id, type_id, "Created session");
        Ok(session_id)
    }

    /// Send input data to a session.
    pub fn send_input(&self, session_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| TerminalError::WriteFailed(format!("Failed to lock sessions: {e}")))?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        entry
            .connection
            .write(data)
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))
    }

    /// Resize a session's terminal.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| TerminalError::ResizeFailed(format!("Failed to lock sessions: {e}")))?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        entry
            .connection
            .resize(cols, rows)
            .map_err(|e| TerminalError::ResizeFailed(e.to_string()))
    }

    /// Close a session.
    pub fn close_session(&self, session_id: &str) -> Result<(), TerminalError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| TerminalError::WriteFailed(format!("Failed to lock sessions: {e}")))?;
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
    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        let sessions = match self.sessions.lock() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        sessions
            .values()
            .map(|entry| {
                let mut info = entry.info.clone();
                info.alive = entry.connection.is_connected();
                info
            })
            .collect()
    }

    /// Get the list of available connection types from the registry.
    pub fn available_types(&self) -> Vec<ConnectionTypeInfo> {
        self.registry.available_types()
    }

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
                format!("Docker: {image}")
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
    async fn run_output_reader(
        session_id: String,
        mut output_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
        app_handle: AppHandle,
        sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
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
                        Self::emit_and_cleanup(&session_id, buffer, &app_handle, &sessions);
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
                if app_handle.emit("terminal-output", &event).is_err() {
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
                    Ok(chunk) => coalescer.push(&chunk),
                    Err(_) => break,
                }
            }

            if let Some(data) = coalescer.flush() {
                let event = TerminalOutputEvent {
                    session_id: session_id.clone(),
                    data,
                };
                if let Err(e) = app_handle.emit("terminal-output", &event) {
                    error!("Failed to emit terminal-output event: {e}");
                    break;
                }
            }
        }

        Self::emit_and_cleanup(&session_id, Vec::new(), &app_handle, &sessions);
    }

    /// Emit remaining data (if any), send the exit event, and remove the session.
    fn emit_and_cleanup(
        session_id: &str,
        data: Vec<u8>,
        app_handle: &AppHandle,
        sessions: &Arc<Mutex<HashMap<String, SessionEntry>>>,
    ) {
        if !data.is_empty() {
            let event = TerminalOutputEvent {
                session_id: session_id.to_string(),
                data,
            };
            let _ = app_handle.emit("terminal-output", &event);
        }

        let exit_event = TerminalExitEvent {
            session_id: session_id.to_string(),
            exit_code: None,
        };
        let _ = app_handle.emit("terminal-exit", &exit_event);

        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(session_id);
        }

        info!("Session ended: {session_id}");
    }
}
