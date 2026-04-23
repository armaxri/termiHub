//! Unified session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Replaces the legacy `TerminalManager` with a single manager that holds
//! `Box<dyn ConnectionType>` for both local and remote (agent-mediated)
//! connections. Local connections use the core backend implementations;
//! remote connections use [`RemoteProxy`](super::remote_proxy::RemoteProxy).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use serde::Serialize;
use tauri::Emitter;
use termihub_core::connection::{ConnectionType, ConnectionTypeInfo, ConnectionTypeRegistry};
use termihub_core::files::FileEntry;
use termihub_core::output::coalescer::OutputCoalescer;
use termihub_core::output::screen_clear::contains_screen_clear;
use tracing::{error, info};

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
}

impl<R: tauri::Runtime> EventEmitter for tauri::AppHandle<R> {
    fn emit_output(&self, event: &TerminalOutputEvent) -> bool {
        self.emit("terminal-output", event).is_ok()
    }

    fn emit_exit(&self, event: &TerminalExitEvent) {
        let _ = self.emit("terminal-exit", event);
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
}

impl SessionManager {
    /// Create a new session manager with the given registry and agent manager.
    pub fn new(registry: ConnectionTypeRegistry, agent_manager: Arc<dyn AgentRpcClient>) -> Self {
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
            Self::run_output_reader(sid, output_rx, emitter, sessions_clone, has_initial_command)
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
        )
        .await;

        // No outputs recorded (emitter failed)
        let outputs = emitter.outputs.lock().unwrap();
        assert!(outputs.is_empty());
    }
}
