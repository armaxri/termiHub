//! Generic session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Sessions are either hosted in-process (non-persistent) or in a daemon
//! subprocess (persistent, Unix only). The decision is based on the
//! connection type's [`Capabilities::persistent`] flag.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use chrono::Utc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::io::transport::NotificationSender;
use crate::session::types::{SessionBackend, SessionInfo, SessionSnapshot, SessionStatus};
use crate::transport::JsonRpcOutputSink;
use termihub_core::connection::{ConnectionTypeRegistry, OutputReceiver};
use termihub_core::session::traits::OutputSink;

#[cfg(unix)]
use crate::daemon::client::DaemonClient;
#[cfg(unix)]
use crate::daemon::process::socket_dir;
#[cfg(unix)]
use crate::state::persistence::{AgentState, PersistedSession};

/// Maximum number of concurrent sessions the agent supports.
pub const MAX_SESSIONS: u32 = 20;

// ── SessionManagerApi trait ────────────────────────────────────────

/// Abstract interface over the session manager.
///
/// Implemented by [`SessionManager`] in production and by mock structs in
/// tests. The [`Dispatcher`](crate::handler::dispatch::Dispatcher) depends on
/// this trait so it can be unit-tested without real backends.
#[async_trait::async_trait(?Send)]
pub trait SessionManagerApi: Send + Sync + 'static {
    /// Return the registry of available connection types.
    fn registry(&self) -> &ConnectionTypeRegistry;

    /// Create a new session.
    async fn create(
        &self,
        type_id: &str,
        title: String,
        settings: serde_json::Value,
    ) -> Result<SessionSnapshot, SessionCreateError>;

    /// List all sessions as snapshots.
    async fn list(&self) -> Vec<SessionSnapshot>;

    /// Return the type ID for an active session.
    async fn get_session_type_id(&self, session_id: &str) -> Option<String>;

    /// Close a session; returns `true` if found and removed.
    async fn close(&self, session_id: &str) -> bool;

    /// Close all sessions (called during agent shutdown).
    // Called on the concrete type in io/tcp.rs and io/stdio.rs; not yet via trait.
    #[allow(dead_code)]
    async fn close_all(&self);

    /// Detach all sessions without closing them.
    // Called on the concrete type in io/tcp.rs; not yet via trait.
    #[allow(dead_code)]
    async fn detach_all(&self);

    /// Return the number of sessions with status `Running`.
    async fn active_count(&self) -> u32;

    /// Attach a client to an existing session.
    async fn attach(&self, session_id: &str) -> Result<(), String>;

    /// Detach the client from a session.
    async fn detach(&self, session_id: &str) -> Result<(), String>;

    /// Write input data to a session's backend.
    async fn write_input(&self, session_id: &str, data: &[u8]) -> Result<(), String>;

    /// Resize a session's terminal.
    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String>;
}

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

// ── DaemonLauncher trait (Unix only) ──────────────────────────────

/// Abstracts the spawning of a daemon subprocess for persistent sessions.
///
/// The production implementation ([`SystemDaemonLauncher`]) calls
/// `std::process::Command` to launch `termihub-agent --daemon` and
/// connects via a Unix socket. Tests inject a mock that returns
/// immediately without spawning a real process.
#[cfg(unix)]
#[async_trait::async_trait(?Send)]
pub trait DaemonLauncher: Send + Sync + 'static {
    /// Spawn a daemon for the given session and return the connected backend.
    async fn launch(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
        notification_tx: NotificationSender,
    ) -> Result<SessionBackend, anyhow::Error>;
}

/// Production [`DaemonLauncher`] that spawns real `termihub-agent --daemon` processes.
#[cfg(unix)]
pub struct SystemDaemonLauncher;

#[cfg(unix)]
#[async_trait::async_trait(?Send)]
impl DaemonLauncher for SystemDaemonLauncher {
    async fn launch(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
        notification_tx: NotificationSender,
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
        let client =
            DaemonClient::connect(session_id.to_string(), socket_path, notification_tx).await?;

        info!("Daemon spawned for session {session_id} (type={type_id})");
        Ok(SessionBackend::Daemon(client))
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
    launcher: Arc<dyn DaemonLauncher>,
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
            launcher: Arc::new(SystemDaemonLauncher),
            #[cfg(unix)]
            state: Mutex::new(AgentState::load()),
        }
    }

    /// Create a session manager with a custom daemon launcher (for testing on Unix).
    #[cfg(all(unix, test))]
    pub fn with_launcher(
        notification_tx: NotificationSender,
        registry: Arc<ConnectionTypeRegistry>,
        launcher: Arc<dyn DaemonLauncher>,
    ) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            notification_tx,
            registry,
            launcher,
            state: Mutex::new(AgentState::load()),
        }
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

    /// Spawn a daemon process and connect via the injected [`DaemonLauncher`].
    #[cfg(unix)]
    async fn spawn_daemon_backend(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
    ) -> Result<SessionBackend, anyhow::Error> {
        self.launcher
            .launch(session_id, type_id, settings, self.notification_tx.clone())
            .await
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

    /// Return the `type_id` for an active session, or `None` if not found.
    pub async fn get_session_type_id(&self, session_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).map(|s| s.type_id.clone())
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

            match DaemonClient::connect(id.clone(), socket_path, self.notification_tx.clone()).await
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

    /// Return the number of sessions with status `Running`.
    pub async fn active_count(&self) -> u32 {
        let sessions = self.sessions.lock().await;
        sessions
            .values()
            .filter(|s| s.status == SessionStatus::Running)
            .count() as u32
    }
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
        #[cfg(test)]
        SessionBackend::Stub => {}
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
        #[cfg(test)]
        SessionBackend::Stub => {}
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
        #[cfg(test)]
        SessionBackend::Stub => {}
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
        #[cfg(test)]
        SessionBackend::Stub => {}
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
        #[cfg(test)]
        SessionBackend::Stub => {}
    }
    Ok(())
}

// ── Output forwarding ──────────────────────────────────────────────

/// Spawn a background task that reads from the ConnectionType's output
/// channel and sends JSON-RPC notifications via [`JsonRpcOutputSink`].
fn spawn_output_forwarder(
    mut output_rx: OutputReceiver,
    session_id: String,
    notification_tx: NotificationSender,
) -> tokio::task::JoinHandle<()> {
    let sink = JsonRpcOutputSink::new(notification_tx);
    tokio::spawn(async move {
        loop {
            match output_rx.recv().await {
                Some(data) => {
                    if sink.send_output(&session_id, data).is_err() {
                        return; // transport loop dropped
                    }
                }
                None => {
                    let _ = sink.send_exit(&session_id, Some(0));
                    return;
                }
            }
        }
    })
}

// ── SessionManagerApi impl ─────────────────────────────────────────

#[async_trait::async_trait(?Send)]
impl SessionManagerApi for SessionManager {
    fn registry(&self) -> &ConnectionTypeRegistry {
        &self.registry
    }

    async fn create(
        &self,
        type_id: &str,
        title: String,
        settings: serde_json::Value,
    ) -> Result<SessionSnapshot, SessionCreateError> {
        SessionManager::create(self, type_id, title, settings).await
    }

    async fn list(&self) -> Vec<SessionSnapshot> {
        SessionManager::list(self).await
    }

    async fn get_session_type_id(&self, session_id: &str) -> Option<String> {
        SessionManager::get_session_type_id(self, session_id).await
    }

    async fn close(&self, session_id: &str) -> bool {
        SessionManager::close(self, session_id).await
    }

    async fn close_all(&self) {
        SessionManager::close_all(self).await
    }

    async fn detach_all(&self) {
        SessionManager::detach_all(self).await
    }

    async fn active_count(&self) -> u32 {
        SessionManager::active_count(self).await
    }

    async fn attach(&self, session_id: &str) -> Result<(), String> {
        SessionManager::attach(self, session_id).await
    }

    async fn detach(&self, session_id: &str) -> Result<(), String> {
        SessionManager::detach(self, session_id).await
    }

    async fn write_input(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        SessionManager::write_input(self, session_id, data).await
    }

    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        SessionManager::resize(self, session_id, cols, rows).await
    }
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

    // ── Stub session helper (for dispatcher tests) ───────────────────

    impl SessionManager {
        /// Create a lightweight stub session for dispatcher tests.
        ///
        /// No real backend is spawned; operations like write/resize are
        /// no-ops but the session shows up in `list()` and `active_count()`.
        #[cfg(test)]
        pub async fn create_stub_session(
            &self,
            type_id: &str,
            title: String,
            _settings: serde_json::Value,
        ) -> Result<SessionSnapshot, SessionCreateError> {
            let mut sessions = self.sessions.lock().await;
            if sessions.len() >= MAX_SESSIONS as usize {
                return Err(SessionCreateError::LimitReached);
            }

            let id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now();

            let info = SessionInfo {
                id: id.clone(),
                title,
                type_id: type_id.to_string(),
                status: SessionStatus::Running,
                settings: serde_json::json!({}),
                created_at: now,
                last_activity: now,
                attached: false,
                backend: SessionBackend::Stub,
            };

            let snapshot = info.snapshot();
            sessions.insert(id, info);
            Ok(snapshot)
        }
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

    // ── DaemonLauncher unit tests (Unix only) ─────────────────────────

    #[cfg(unix)]
    mod daemon_launcher_tests {
        use super::*;
        use crate::session::types::SessionBackend;

        /// Mock launcher that returns a Stub backend (no real process spawned).
        struct MockDaemonLauncher {
            should_fail: bool,
            launched: Arc<Mutex<Vec<(String, String)>>>,
        }

        impl MockDaemonLauncher {
            fn new() -> Self {
                Self {
                    should_fail: false,
                    launched: Arc::new(Mutex::new(Vec::new())),
                }
            }
            fn failing() -> Self {
                Self {
                    should_fail: true,
                    launched: Arc::new(Mutex::new(Vec::new())),
                }
            }
        }

        #[async_trait::async_trait(?Send)]
        impl DaemonLauncher for MockDaemonLauncher {
            async fn launch(
                &self,
                session_id: &str,
                type_id: &str,
                _settings: &serde_json::Value,
                _notification_tx: NotificationSender,
            ) -> Result<SessionBackend, anyhow::Error> {
                if self.should_fail {
                    return Err(anyhow::anyhow!("mock: daemon spawn failed"));
                }
                self.launched
                    .lock()
                    .await
                    .push((session_id.to_string(), type_id.to_string()));
                Ok(SessionBackend::Stub)
            }
        }

        type LaunchedLog = Arc<Mutex<Vec<(String, String)>>>;

        fn make_manager_with_mock(launcher: MockDaemonLauncher) -> (SessionManager, LaunchedLog) {
            let launched = launcher.launched.clone();
            let mgr = SessionManager::with_launcher(
                test_notification_tx(),
                test_registry(),
                Arc::new(launcher),
            );
            (mgr, launched)
        }

        #[tokio::test]
        async fn create_persistent_session_calls_launcher() {
            let (mgr, launched) = make_manager_with_mock(MockDaemonLauncher::new());
            // "ssh" is a persistent type (Capabilities::persistent = true)
            let result = mgr
                .create(
                    "ssh",
                    "test SSH".to_string(),
                    serde_json::json!({
                        "host": "example.com",
                        "username": "user",
                        "authMethod": "password",
                    }),
                )
                .await;
            assert!(
                result.is_ok(),
                "expected session creation to succeed: {result:?}"
            );
            let log = launched.lock().await;
            assert_eq!(log.len(), 1, "expected launcher to be called once");
            assert_eq!(log[0].1, "ssh");
        }

        #[tokio::test]
        async fn create_nonpersistent_session_skips_launcher() {
            let (mgr, launched) = make_manager_with_mock(MockDaemonLauncher::new());
            // "telnet" is non-persistent — runs in-process; launcher should not be called
            // We can't actually connect, but create() will fail at backend level (not launcher)
            let _ = mgr
                .create(
                    "telnet",
                    "test".to_string(),
                    serde_json::json!({
                        "host": "127.0.0.1",
                        "port": 9999,
                    }),
                )
                .await;
            let log = launched.lock().await;
            assert_eq!(
                log.len(),
                0,
                "non-persistent session should not use launcher"
            );
        }

        #[tokio::test]
        async fn create_persistent_session_launcher_failure_propagates() {
            let (mgr, _) = make_manager_with_mock(MockDaemonLauncher::failing());
            let result = mgr
                .create(
                    "ssh",
                    "fail test".to_string(),
                    serde_json::json!({
                        "host": "example.com",
                        "username": "user",
                        "authMethod": "password",
                    }),
                )
                .await;
            assert!(
                matches!(result, Err(SessionCreateError::BackendFailed(_))),
                "expected BackendFailed, got: {result:?}"
            );
        }

        #[tokio::test]
        async fn create_session_appears_in_list_after_launch() {
            let (mgr, _) = make_manager_with_mock(MockDaemonLauncher::new());
            let snapshot = mgr
                .create(
                    "ssh",
                    "my-ssh".to_string(),
                    serde_json::json!({
                        "host": "example.com",
                        "username": "user",
                        "authMethod": "password",
                    }),
                )
                .await
                .unwrap();
            let list = mgr.list().await;
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].id, snapshot.id);
            assert_eq!(list[0].title, "my-ssh");
        }
    }
}
