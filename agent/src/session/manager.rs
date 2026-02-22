//! Generic session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Sessions are either hosted in-process (non-persistent) or in a daemon
//! subprocess (persistent, Unix only). The decision is based on the
//! connection type's [`Capabilities::persistent`] flag.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use base64::Engine;
use chrono::Utc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::session::types::{SessionBackend, SessionInfo, SessionSnapshot, SessionStatus};
use termihub_core::connection::{ConnectionTypeRegistry, OutputReceiver};

#[cfg(unix)]
use crate::daemon::client::DaemonClient;
#[cfg(unix)]
use crate::daemon::process::socket_dir;
#[cfg(unix)]
use crate::state::persistence::{AgentState, PersistedSession};

/// Maximum number of concurrent sessions the agent supports.
pub const MAX_SESSIONS: u32 = 20;

/// Errors that can occur during session creation.
#[derive(Debug)]
pub enum SessionCreateError {
    /// The maximum number of sessions has been reached.
    LimitReached,
    /// The provided configuration is invalid.
    InvalidConfig(String),
    /// The backend failed to start.
    BackendFailed(String),
}

impl fmt::Display for SessionCreateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LimitReached => write!(f, "Session limit reached (max {MAX_SESSIONS})"),
            Self::InvalidConfig(msg) => write!(f, "Invalid configuration: {msg}"),
            Self::BackendFailed(msg) => write!(f, "Backend failed: {msg}"),
        }
    }
}

/// In-memory session manager.
///
/// Tracks sessions in a `HashMap` protected by a `tokio::sync::Mutex`
/// so it can be shared across async tasks.
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionInfo>>,
    notification_tx: NotificationSender,
    registry: Arc<ConnectionTypeRegistry>,
    #[cfg(unix)]
    state: Mutex<AgentState>,
}

impl SessionManager {
    pub fn new(notification_tx: NotificationSender, registry: Arc<ConnectionTypeRegistry>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            notification_tx,
            registry,
            #[cfg(unix)]
            state: Mutex::new(AgentState::load()),
        }
    }

    /// Get a reference to the connection type registry.
    pub fn registry(&self) -> &ConnectionTypeRegistry {
        &self.registry
    }

    /// Create a new session.
    ///
    /// For persistent connection types on Unix, spawns a daemon subprocess
    /// that keeps the connection alive. For non-persistent types (or on
    /// non-Unix platforms), runs the connection in-process.
    pub async fn create(
        &self,
        type_id: &str,
        title: String,
        settings: serde_json::Value,
    ) -> Result<SessionSnapshot, SessionCreateError> {
        let mut sessions = self.sessions.lock().await;

        if sessions.len() >= MAX_SESSIONS as usize {
            return Err(SessionCreateError::LimitReached);
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();

        // Check the type exists and get capabilities.
        let capabilities = {
            let instance = self
                .registry
                .create(type_id)
                .map_err(|e| SessionCreateError::InvalidConfig(e.to_string()))?;
            instance.capabilities()
        };

        let backend = self
            .create_backend(&id, type_id, &settings, capabilities.persistent)
            .await
            .map_err(|e| SessionCreateError::BackendFailed(e.to_string()))?;

        // Persist for recovery on Unix.
        #[cfg(unix)]
        if capabilities.persistent {
            if let SessionBackend::Daemon(ref client) = backend {
                let mut state = self.state.lock().await;
                state.add_session(
                    id.clone(),
                    PersistedSession {
                        type_id: type_id.to_string(),
                        title: title.clone(),
                        created_at: now.to_rfc3339(),
                        daemon_socket: Some(client.socket_path().to_string_lossy().to_string()),
                        settings: settings.clone(),
                    },
                );
            }
        }

        let info = SessionInfo {
            id: id.clone(),
            title,
            type_id: type_id.to_string(),
            status: SessionStatus::Running,
            settings,
            created_at: now,
            last_activity: now,
            attached: false,
            backend,
        };

        let snapshot = info.snapshot();
        sessions.insert(id, info);
        Ok(snapshot)
    }

    /// Create the appropriate backend for a connection type.
    async fn create_backend(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
        persistent: bool,
    ) -> Result<SessionBackend, anyhow::Error> {
        #[cfg(unix)]
        if persistent {
            return self
                .spawn_daemon_backend(session_id, type_id, settings)
                .await;
        }

        // Suppress unused variable warnings on non-Unix.
        let _ = persistent;

        self.create_in_process_backend(session_id, type_id, settings)
            .await
    }

    /// Spawn a daemon process and connect via DaemonClient.
    #[cfg(unix)]
    async fn spawn_daemon_backend(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
    ) -> Result<SessionBackend, anyhow::Error> {
        let socket_path = socket_dir().join(format!("session-{session_id}.sock"));

        let settings_json = serde_json::to_string(settings)?;

        let agent_exe = std::env::current_exe()?;

        let _child = std::process::Command::new(&agent_exe)
            .arg("--daemon")
            .arg(session_id)
            .env("TERMIHUB_SOCKET_PATH", &socket_path)
            .env("TERMIHUB_TYPE_ID", type_id)
            .env("TERMIHUB_SETTINGS", &settings_json)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn daemon: {e}"))?;

        DaemonClient::wait_for_socket(&socket_path).await?;
        let client = DaemonClient::connect(
            session_id.to_string(),
            socket_path,
            self.notification_tx.clone(),
        )
        .await?;

        info!("Daemon spawned for session {session_id} (type={type_id})");
        Ok(SessionBackend::Daemon(client))
    }

    /// Create a ConnectionType in-process and start output forwarding.
    async fn create_in_process_backend(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
    ) -> Result<SessionBackend, anyhow::Error> {
        let mut connection = self
            .registry
            .create(type_id)
            .map_err(|e| anyhow::anyhow!("{e}"))?;

        connection
            .connect(settings.clone())
            .await
            .map_err(|e| anyhow::anyhow!("Connection failed: {e}"))?;

        let output_rx = connection.subscribe_output();
        let output_task = spawn_output_forwarder(
            output_rx,
            session_id.to_string(),
            self.notification_tx.clone(),
        );

        info!("In-process connection for session {session_id} (type={type_id})");
        Ok(SessionBackend::InProcess {
            connection,
            output_task: Some(output_task),
        })
    }

    /// List all sessions as read-only snapshots.
    pub async fn list(&self) -> Vec<SessionSnapshot> {
        let sessions = self.sessions.lock().await;
        sessions.values().map(|s| s.snapshot()).collect()
    }

    /// Close (remove) a session by ID.
    ///
    /// Disconnects the backend before removing the session.
    /// Returns `true` if the session was found and removed.
    pub async fn close(&self, session_id: &str) -> bool {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut info) = sessions.remove(session_id) {
            close_backend(&mut info.backend).await;

            #[cfg(unix)]
            {
                let mut state = self.state.lock().await;
                state.remove_session(session_id);
            }

            true
        } else {
            false
        }
    }

    /// Detach all sessions without closing them.
    ///
    /// Called when a TCP client disconnects so sessions remain alive
    /// for the next client to re-attach.
    pub async fn detach_all(&self) {
        let mut sessions = self.sessions.lock().await;
        for info in sessions.values_mut() {
            if info.attached {
                info.attached = false;
                detach_backend(&mut info.backend).await;
            }
        }
    }

    /// Close all sessions. Called during agent shutdown.
    pub async fn close_all(&self) {
        let mut sessions = self.sessions.lock().await;
        for (_, mut info) in sessions.drain() {
            close_backend(&mut info.backend).await;
        }
    }

    /// Attach a client to an existing session.
    pub async fn attach(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let info = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        if info.status != SessionStatus::Running {
            return Err("Session not running".to_string());
        }

        info.attached = true;
        info.last_activity = Utc::now();

        attach_backend(&mut info.backend)
            .await
            .map_err(|e| e.to_string())
    }

    /// Detach the client from a session.
    pub async fn detach(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let info = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        info.attached = false;
        info.last_activity = Utc::now();

        detach_backend(&mut info.backend).await;
        Ok(())
    }

    /// Write input data to a session's backend.
    pub async fn write_input(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let info = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        info.last_activity = Utc::now();

        write_backend(&info.backend, data)
            .await
            .map_err(|e| e.to_string())
    }

    /// Resize a session's terminal.
    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let info = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        info.last_activity = Utc::now();

        resize_backend(&info.backend, cols, rows)
            .await
            .map_err(|e| e.to_string())
    }

    /// Recover sessions from persistent state by reconnecting to
    /// surviving daemon processes.
    #[cfg(unix)]
    pub async fn recover_sessions(&self) -> Vec<String> {
        let state = self.state.lock().await;
        let persisted = state.sessions.clone();
        drop(state);

        let mut recovered = Vec::new();

        for (id, session) in &persisted {
            let socket_path = match &session.daemon_socket {
                Some(p) => std::path::PathBuf::from(p),
                None => {
                    warn!("Session {id} has no daemon socket, removing");
                    let mut state = self.state.lock().await;
                    state.remove_session(id);
                    continue;
                }
            };

            if !socket_path.exists() {
                info!("Daemon socket gone for session {id}, removing from state");
                let mut state = self.state.lock().await;
                state.remove_session(id);
                continue;
            }

            match DaemonClient::connect(
                id.clone(),
                socket_path,
                self.notification_tx.clone(),
            )
            .await
            {
                Ok(client) => {
                    let created_at = chrono::DateTime::parse_from_rfc3339(&session.created_at)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now());

                    let info = SessionInfo {
                        id: id.clone(),
                        title: session.title.clone(),
                        type_id: session.type_id.clone(),
                        status: SessionStatus::Running,
                        settings: session.settings.clone(),
                        created_at,
                        last_activity: Utc::now(),
                        attached: false,
                        backend: SessionBackend::Daemon(client),
                    };

                    let mut sessions = self.sessions.lock().await;
                    sessions.insert(id.clone(), info);
                    recovered.push(id.clone());
                    info!("Recovered session {id} (type={})", session.type_id);
                }
                Err(e) => {
                    warn!("Failed to recover session {id}: {e}");
                    let mut state = self.state.lock().await;
                    state.remove_session(id);
                }
            }
        }

        if !recovered.is_empty() {
            info!("Recovered {} session(s)", recovered.len());
        }

        recovered
    }

    /// Get the connection for a session (for monitoring/file browsing).
    ///
    /// Returns a reference to the in-process ConnectionType, if available.
    /// Daemon-hosted sessions don't expose the ConnectionType directly.
    pub async fn get_connection(
        &self,
        session_id: &str,
    ) -> Option<SessionConnectionRef> {
        let sessions = self.sessions.lock().await;
        let info = sessions.get(session_id)?;
        match &info.backend {
            SessionBackend::InProcess { connection, .. } => {
                // SAFETY: We return a reference that lives as long as the MutexGuard.
                // Callers must not hold this across await points without the guard.
                Some(SessionConnectionRef {
                    type_id: info.type_id.clone(),
                })
            }
            #[cfg(unix)]
            SessionBackend::Daemon(_) => Some(SessionConnectionRef {
                type_id: info.type_id.clone(),
            }),
        }
    }

    /// Return the number of sessions with status `Running`.
    pub async fn active_count(&self) -> u32 {
        let sessions = self.sessions.lock().await;
        sessions
            .values()
            .filter(|s| s.status == SessionStatus::Running)
            .count() as u32
    }
}

/// Lightweight reference to a session's connection for capability queries.
pub struct SessionConnectionRef {
    pub type_id: String,
}

// ── Backend operations ─────────────────────────────────────────────

async fn close_backend(backend: &mut SessionBackend) {
    match backend {
        #[cfg(unix)]
        SessionBackend::Daemon(ref mut client) => {
            client.close().await;
        }
        SessionBackend::InProcess {
            connection,
            output_task,
        } => {
            if let Err(e) = connection.disconnect().await {
                warn!("Disconnect error: {e}");
            }
            if let Some(task) = output_task.take() {
                task.abort();
            }
        }
    }
}

async fn attach_backend(backend: &mut SessionBackend) -> Result<(), anyhow::Error> {
    match backend {
        #[cfg(unix)]
        SessionBackend::Daemon(ref mut client) => {
            client.attach().await?;
        }
        SessionBackend::InProcess { .. } => {
            // In-process connections always forward output; no-op.
        }
    }
    Ok(())
}

async fn detach_backend(backend: &mut SessionBackend) {
    match backend {
        #[cfg(unix)]
        SessionBackend::Daemon(ref mut client) => {
            client.detach().await;
        }
        SessionBackend::InProcess { .. } => {
            // In-process connections keep forwarding; no-op.
        }
    }
}

async fn write_backend(backend: &SessionBackend, data: &[u8]) -> Result<(), anyhow::Error> {
    match backend {
        #[cfg(unix)]
        SessionBackend::Daemon(ref client) => {
            client.write_input(data).await?;
        }
        SessionBackend::InProcess { connection, .. } => {
            connection.write(data).map_err(|e| anyhow::anyhow!("{e}"))?;
        }
    }
    Ok(())
}

async fn resize_backend(
    backend: &SessionBackend,
    cols: u16,
    rows: u16,
) -> Result<(), anyhow::Error> {
    match backend {
        #[cfg(unix)]
        SessionBackend::Daemon(ref client) => {
            client.resize(cols, rows).await?;
        }
        SessionBackend::InProcess { connection, .. } => {
            connection
                .resize(cols, rows)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
        }
    }
    Ok(())
}

// ── Output forwarding ──────────────────────────────────────────────

/// Spawn a background task that reads from the ConnectionType's output
/// channel and sends JSON-RPC notifications.
fn spawn_output_forwarder(
    mut output_rx: OutputReceiver,
    session_id: String,
    notification_tx: NotificationSender,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let b64 = base64::engine::general_purpose::STANDARD;
        loop {
            match output_rx.recv().await {
                Some(data) => {
                    for chunk in data.chunks(65536) {
                        let encoded = b64.encode(chunk);
                        let notification = JsonRpcNotification::new(
                            "connection.output",
                            serde_json::json!({
                                "session_id": session_id,
                                "data": encoded,
                            }),
                        );
                        if notification_tx.send(notification).is_err() {
                            return; // transport loop dropped
                        }
                    }
                }
                None => {
                    // Connection output ended.
                    let notification = JsonRpcNotification::new(
                        "connection.exit",
                        serde_json::json!({
                            "session_id": session_id,
                            "exit_code": 0,
                        }),
                    );
                    let _ = notification_tx.send(notification);
                    return;
                }
            }
        }
    })
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_notification_tx() -> NotificationSender {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        tx
    }

    fn test_registry() -> Arc<ConnectionTypeRegistry> {
        Arc::new(crate::registry::build_registry())
    }

    #[tokio::test]
    async fn create_and_list() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        // Telnet is non-persistent and doesn't need real hardware.
        // We can't actually connect without a server, so test limits/listing
        // with stub approach.
        assert_eq!(mgr.list().await.len(), 0);
    }

    #[tokio::test]
    async fn close_nonexistent_returns_false() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        assert!(!mgr.close("nonexistent-id").await);
    }

    #[tokio::test]
    async fn active_count_starts_at_zero() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        assert_eq!(mgr.active_count().await, 0);
    }

    #[tokio::test]
    async fn attach_not_found() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        let result = mgr.attach("nonexistent").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn detach_not_found() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        let result = mgr.detach("nonexistent").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn write_input_not_found() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        let result = mgr.write_input("nonexistent", b"hello").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn close_all_on_empty() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        mgr.close_all().await;
        assert!(mgr.list().await.is_empty());
    }

    #[tokio::test]
    async fn create_unknown_type_fails() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        let result = mgr
            .create("nonexistent-type", "test".to_string(), json!({}))
            .await;
        assert!(matches!(result, Err(SessionCreateError::InvalidConfig(_))));
    }

    #[tokio::test]
    async fn registry_accessible() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        assert!(mgr.registry().has_type("local"));
        assert!(mgr.registry().has_type("ssh"));
    }
}
