//! Generic session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Sessions are either hosted in-process (non-persistent) or in a daemon
//! subprocess (persistent). The decision is based on the connection type's
//! [`Capabilities::persistent`] flag. Daemon-backed sessions are cross-platform
//! (Unix domain socket on unix, named pipe on windows — see
//! [`crate::daemon::transport`]).

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use chrono::Utc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::io::transport::NotificationSender;
use crate::session::agent_forward::AgentForwardRelay;
use crate::session::types::{SessionBackend, SessionInfo, SessionSnapshot, SessionStatus};
use crate::transport::JsonRpcOutputSink;
use termihub_core::connection::{ConnectionTypeRegistry, OutputReceiver};
use termihub_core::session::traits::OutputSink;

use crate::daemon::client::{DaemonClient, DaemonWriterHandle};
use crate::daemon::transport::{endpoint_alive, session_endpoint};
use crate::state::persistence::{AgentState, PendingUpdate, PersistedSession};
use crate::update::{
    prune_applied_pending_update, should_apply_deferred_update, SystemUpdateApplier, UpdateApplier,
};

/// Maximum number of concurrent sessions the agent supports.
pub const MAX_SESSIONS: u32 = 20;

// ── SessionManagerApi trait ────────────────────────────────────────

/// Abstract interface over the session manager.
///
/// Implemented by [`SessionManager`] in production and by mock structs in
/// tests. The [`Dispatcher`](crate::handler::dispatch::Dispatcher) depends on
/// this trait so it can be unit-tested without real backends.
#[async_trait::async_trait]
pub trait SessionManagerApi: Send + Sync + 'static {
    /// Return the registry of available connection types.
    fn registry(&self) -> &ConnectionTypeRegistry;

    /// Create a new session.
    ///
    /// `definition_id` records which saved connection definition this session
    /// originated from, so clients can re-link an active session to its source
    /// definition after the original tab is closed or the desktop restarts.
    /// Pass `None` for ad-hoc sessions not derived from a saved definition.
    async fn create(
        &self,
        type_id: &str,
        title: String,
        settings: serde_json::Value,
        definition_id: Option<String>,
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

    /// Record a deferred agent update, applying it immediately when idle.
    async fn request_deferred_update(
        &self,
        binary_path: Option<String>,
        version: Option<String>,
    ) -> Result<DeferredUpdateOutcome, DeferredUpdateError>;

    /// Attach a client to an existing session.
    async fn attach(&self, session_id: &str) -> Result<(), String>;

    /// Detach the client from a session.
    async fn detach(&self, session_id: &str) -> Result<(), String>;

    /// Write input data to a session's backend.
    async fn write_input(&self, session_id: &str, data: &[u8]) -> Result<(), String>;

    /// Resize a session's terminal.
    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String>;

    /// Return the current scrollback buffer for a session (daemon-backed only).
    async fn get_buffer(&self, session_id: &str) -> Result<Vec<u8>, String>;

    /// Update the ring-buffer size used for future daemon spawns.
    async fn set_persistent_buffer_size_bytes(&self, bytes: usize);

    /// Route desktop-supplied ssh-agent reply bytes to a forwarded stream (the
    /// desktop→agent leg of the agent-forward relay, #1727). Unknown streams are
    /// silently ignored.
    async fn agent_forward_write(&self, stream_id: &str, data: Vec<u8>);

    /// Close a forwarded ssh-agent stream the desktop reports as ended (#1727).
    async fn agent_forward_close(&self, stream_id: &str);
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

/// Result of a deferred-update request (`agent.request_deferred_update`).
#[derive(Debug)]
pub enum DeferredUpdateOutcome {
    /// The agent was idle (0 active sessions) so the update is being applied
    /// immediately. On Unix the process re-execs and this variant is only
    /// observed in tests / on the non-Unix path.
    Applying,
    /// The update was recorded and will apply when the last of `active_sessions`
    /// sessions disconnects. Active sessions are never interrupted.
    Deferred { active_sessions: u32 },
}

/// Errors from requesting a deferred update.
#[derive(Debug)]
pub enum DeferredUpdateError {
    /// The provided binary path does not point to an existing file.
    BinaryNotFound(String),
    /// No `binary_path` was given and no update is currently staged/pending.
    NoPendingUpdate,
    /// Applying the update failed (binary swap or re-exec error, or an
    /// unsupported platform).
    ApplyFailed(anyhow::Error),
}

impl fmt::Display for DeferredUpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BinaryNotFound(path) => write!(f, "Update binary not found: {path}"),
            Self::NoPendingUpdate => write!(f, "No pending update to apply"),
            Self::ApplyFailed(e) => write!(f, "Failed to apply update: {e:#}"),
        }
    }
}

// ── DaemonLauncher trait ──────────────────────────────────────────

/// Abstracts the spawning of a daemon subprocess for persistent sessions.
///
/// The production implementation ([`SystemDaemonLauncher`]) calls
/// `std::process::Command` to launch `termihub-agent --daemon` detached and
/// connects via the transport. Tests inject a mock that returns immediately
/// without spawning a real process.
#[async_trait::async_trait]
pub trait DaemonLauncher: Send + Sync + 'static {
    /// Spawn a daemon for the given session and return the connected backend.
    ///
    /// `ssh_auth_sock`, when set, is the per-session relay endpoint exported to
    /// the daemon so its core SSH agent-forwarding bridge reaches the desktop's
    /// agent instead of the agent host's own agent — as `SSH_AUTH_SOCK` for the
    /// unix relay socket (#1727) or the dedicated pipe-name variable for the
    /// Windows relay pipe (#2038).
    async fn launch(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
        notification_tx: NotificationSender,
        buffer_size_bytes: usize,
        ssh_auth_sock: Option<String>,
    ) -> Result<SessionBackend, anyhow::Error>;
}

/// Open the per-session daemon log, where the platform provides one.
///
/// On unix the daemon logs to a per-session file in its socket dir; elsewhere it
/// is discarded to null (a Windows per-session log path is a future refinement).
/// See [`crate::daemon::spawn::configure_detached_stderr`] for why it must never
/// simply inherit the agent's stderr.
fn daemon_log(session_id: &str) -> Option<std::fs::File> {
    #[cfg(unix)]
    {
        crate::daemon::transport::open_daemon_log(session_id)
    }
    #[cfg(not(unix))]
    {
        let _ = session_id;
        None
    }
}

/// Production [`DaemonLauncher`] that spawns real `termihub-agent --daemon` processes.
pub struct SystemDaemonLauncher;

#[async_trait::async_trait]
impl DaemonLauncher for SystemDaemonLauncher {
    async fn launch(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
        notification_tx: NotificationSender,
        buffer_size_bytes: usize,
        ssh_auth_sock: Option<String>,
    ) -> Result<SessionBackend, anyhow::Error> {
        let endpoint = session_endpoint(session_id);
        let settings_json = serde_json::to_string(settings)?;
        let agent_exe = std::env::current_exe()?;

        let mut command = std::process::Command::new(&agent_exe);
        command
            .arg("--daemon")
            .arg(session_id)
            .env("TERMIHUB_SOCKET_PATH", &endpoint)
            .env("TERMIHUB_TYPE_ID", type_id)
            .env("TERMIHUB_SETTINGS", &settings_json)
            .env("TERMIHUB_BUFFER_SIZE", buffer_size_bytes.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null());
        // Point the daemon's core SSH agent-forwarding bridge at the per-session
        // relay endpoint, so it reaches the desktop's agent rather than the agent
        // host's own local agent. Overriding the inherited value is the intent:
        // over the TCP transport there is nothing useful to inherit. The channel
        // differs by platform — `SSH_AUTH_SOCK` for the unix relay socket (#1727),
        // the dedicated pipe-name variable for the Windows relay pipe (#2038,
        // kept clear of `SSH_AUTH_SOCK` so a real local OpenSSH agent is not
        // shadowed).
        if let Some(endpoint) = ssh_auth_sock {
            #[cfg(windows)]
            command.env(
                termihub_core::backends::ssh::agent_forward::AGENT_PIPE_ENV,
                endpoint,
            );
            #[cfg(not(windows))]
            command.env("SSH_AUTH_SOCK", endpoint);
        }
        crate::daemon::spawn::configure_detached_stderr(&mut command, daemon_log(session_id));
        crate::daemon::spawn::configure_detachment(&mut command);

        let mut child = command
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn daemon: {e}"))?;

        // The transport retries while the daemon binds its endpoint during slow
        // startup work. Race that connect against the daemon process exiting so
        // a daemon that dies before binding (e.g. its shell failed to spawn)
        // fails fast with its real exit status instead of retrying a phantom
        // "endpoint not found" for the whole connect timeout (#847).
        let connect = DaemonClient::connect(session_id.to_string(), endpoint, notification_tx);
        let client = match connect_or_daemon_exit(session_id, connect, || match child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            _ => None,
        })
        .await
        {
            Ok(client) => client,
            Err(e) => {
                // Don't leave a half-started daemon orphaned when connect fails.
                let _ = child.kill();
                return Err(e);
            }
        };

        info!("Daemon spawned for session {session_id} (type={type_id})");
        Ok(SessionBackend::Daemon(client))
    }
}

/// How often [`connect_or_daemon_exit`] checks whether a freshly spawned daemon
/// has exited while waiting for its endpoint to come up.
const DAEMON_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Await the daemon `connect` future, but bail out early if `daemon_exited`
/// reports the daemon process has exited.
///
/// A daemon that dies before binding its endpoint would otherwise leave the
/// transport retrying a phantom "endpoint not found" until the full connect
/// timeout, surfacing a misleading low-level OS error (on Windows, "The system
/// cannot find the file specified. (os error 2)"). Polling the child lets us
/// fail fast with the daemon's real exit status instead (issue #847).
///
/// `daemon_exited` returns `Some(status_description)` once the daemon has
/// exited, or `None` while it is still running.
async fn connect_or_daemon_exit<T, F>(
    session_id: &str,
    connect: F,
    mut daemon_exited: impl FnMut() -> Option<String>,
) -> Result<T, anyhow::Error>
where
    F: std::future::Future<Output = Result<T, anyhow::Error>>,
{
    tokio::pin!(connect);
    loop {
        tokio::select! {
            // Prefer a completed connect over the poll tick on the same wake-up.
            biased;
            result = &mut connect => return result,
            _ = tokio::time::sleep(DAEMON_EXIT_POLL_INTERVAL) => {
                if let Some(status) = daemon_exited() {
                    return Err(anyhow::anyhow!(
                        "Daemon for session {session_id} exited before its endpoint was ready ({status})"
                    ));
                }
            }
        }
    }
}

/// Default persistent session ring-buffer size (1 MiB).
const DEFAULT_PERSISTENT_BUFFER_SIZE: usize = 1_048_576;

/// In-memory session manager.
///
/// Tracks sessions in a `HashMap` protected by a `tokio::sync::Mutex`
/// so it can be shared across async tasks.
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionInfo>>,
    notification_tx: NotificationSender,
    registry: Arc<ConnectionTypeRegistry>,
    launcher: Arc<dyn DaemonLauncher>,
    state: Mutex<AgentState>,
    /// Path the persisted [`AgentState`] is read from / written to. Configurable
    /// so tests get an isolated `state.json` instead of touching the real one.
    state_path: PathBuf,
    /// Applies a deferred update by swapping the agent binary. Injected so tests
    /// can record apply requests without replacing the test process.
    update_applier: Arc<dyn UpdateApplier>,
    /// Configurable ring-buffer size for daemon-backed persistent sessions.
    persistent_buffer_size: Arc<AtomicUsize>,
    /// Relays the desktop's ssh-agent to daemons that opted into `forwardAgent`
    /// over the JSON-RPC transport (#1727). Shared with the dispatch handlers so
    /// desktop-supplied reply bytes route back to the right forwarded stream.
    agent_forward: Arc<AgentForwardRelay>,
    /// Weak self-reference, set once the manager is wrapped in its owning `Arc`
    /// via [`SessionManager::into_arc`].
    ///
    /// Lets a per-session output-forwarder task reach back into the manager when
    /// its backend exits on its own, so the deferred self-update auto-apply hook
    /// fires on a natural last-session exit — not only on an explicit
    /// [`close`](SessionManager::close) (#2378). Unset (an empty [`Weak`]) when
    /// the manager was not wrapped through `into_arc` (e.g. some unit tests); the
    /// forwarder then simply skips the hook and lazy reconciliation on the read
    /// paths still settles the session.
    self_ref: OnceLock<Weak<SessionManager>>,
}

impl SessionManager {
    pub fn new(notification_tx: NotificationSender, registry: Arc<ConnectionTypeRegistry>) -> Self {
        Self::with_deps(
            notification_tx,
            registry,
            Arc::new(SystemDaemonLauncher),
            AgentState::default_path(),
            Arc::new(SystemUpdateApplier),
        )
    }

    /// Create a session manager with a custom daemon launcher (for testing).
    #[cfg(test)]
    pub fn with_launcher(
        notification_tx: NotificationSender,
        registry: Arc<ConnectionTypeRegistry>,
        launcher: Arc<dyn DaemonLauncher>,
    ) -> Self {
        Self::with_deps(
            notification_tx,
            registry,
            launcher,
            AgentState::default_path(),
            Arc::new(SystemUpdateApplier),
        )
    }

    /// Create a session manager with a fully injected set of dependencies,
    /// including an isolated state path and a custom [`UpdateApplier`] (used by
    /// the deferred-update tests so they never touch the real `state.json` or
    /// re-exec the test process).
    #[cfg(test)]
    pub fn with_test_deps(
        notification_tx: NotificationSender,
        registry: Arc<ConnectionTypeRegistry>,
        launcher: Arc<dyn DaemonLauncher>,
        state_path: PathBuf,
        update_applier: Arc<dyn UpdateApplier>,
    ) -> Self {
        Self::with_deps(
            notification_tx,
            registry,
            launcher,
            state_path,
            update_applier,
        )
    }

    fn with_deps(
        notification_tx: NotificationSender,
        registry: Arc<ConnectionTypeRegistry>,
        launcher: Arc<dyn DaemonLauncher>,
        state_path: PathBuf,
        update_applier: Arc<dyn UpdateApplier>,
    ) -> Self {
        let mut state = AgentState::load_from(&state_path);
        // #1551: a successful Unix apply re-execs and never returns, so it can
        // never clear its own `pending_update`. Sweep an already-applied record
        // here, at startup, or it re-fires on the next last-session disconnect
        // and re-execs the agent for nothing.
        let current_exe = std::env::current_exe().ok();
        if prune_applied_pending_update(
            &mut state,
            env!("CARGO_PKG_VERSION"),
            current_exe.as_deref(),
        ) {
            info!("Cleared an already-applied pending agent update from persisted state");
            state.save_to(&state_path);
        }
        let agent_forward = AgentForwardRelay::new(notification_tx.clone());
        Self {
            sessions: Mutex::new(HashMap::new()),
            notification_tx,
            registry,
            launcher,
            state: Mutex::new(state),
            state_path,
            update_applier,
            persistent_buffer_size: Arc::new(AtomicUsize::new(DEFAULT_PERSISTENT_BUFFER_SIZE)),
            agent_forward,
            self_ref: OnceLock::new(),
        }
    }

    /// Wrap the manager in its owning [`Arc`], recording a [`Weak`] self-reference
    /// so per-session output-forwarders can reach back into the manager.
    ///
    /// Production entry points (`io::tcp`, `io::stdio`) construct the manager
    /// through this instead of a bare `Arc::new`, which is what lets a naturally
    /// exiting last session trigger the deferred self-update auto-apply (#2378).
    pub fn into_arc(self) -> Arc<Self> {
        let arc = Arc::new(self);
        // `set` only fails if already initialised, which cannot happen for a
        // freshly wrapped value — ignore the returned `Weak` in that case.
        let _ = arc.self_ref.set(Arc::downgrade(&arc));
        arc
    }

    /// Create a new session.
    ///
    /// For persistent connection types, spawns a daemon subprocess that keeps
    /// the connection alive. For non-persistent types, runs the connection
    /// in-process.
    pub async fn create(
        &self,
        type_id: &str,
        title: String,
        settings: serde_json::Value,
        definition_id: Option<String>,
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

        // Persist daemon-backed sessions for recovery after an agent restart.
        if capabilities.persistent {
            if let SessionBackend::Daemon(ref client) = backend {
                let mut state = self.state.lock().await;
                state.sessions.insert(
                    id.clone(),
                    PersistedSession {
                        type_id: type_id.to_string(),
                        title: title.clone(),
                        created_at: now.to_rfc3339(),
                        daemon_socket: Some(client.endpoint().to_string()),
                        settings: settings.clone(),
                        definition_id: definition_id.clone(),
                    },
                );
                state.save_to(&self.state_path);
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
            definition_id,
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
        if persistent {
            return self
                .spawn_daemon_backend(session_id, type_id, settings)
                .await;
        }

        self.create_in_process_backend(session_id, type_id, settings)
            .await
    }

    /// Spawn a daemon process and connect via the injected [`DaemonLauncher`].
    async fn spawn_daemon_backend(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
    ) -> Result<SessionBackend, anyhow::Error> {
        let buffer_size = self.persistent_buffer_size.load(Ordering::Relaxed);

        // For an SSH session that opted into `forwardAgent`, stand up a
        // per-session ssh-agent relay to the desktop and hand the daemon its
        // endpoint (unix socket / Windows pipe, #1727/#2038). Best-effort: if the
        // relay can't bind we still launch, and forwarding just falls back to
        // whatever the daemon inherits (the #1719 host-local behaviour).
        let ssh_auth_sock = self
            .start_agent_forward(session_id, type_id, settings)
            .await;

        let result = self
            .launcher
            .launch(
                session_id,
                type_id,
                settings,
                self.notification_tx.clone(),
                buffer_size,
                ssh_auth_sock.clone(),
            )
            .await;

        // A daemon that never launched leaves no one to talk to the relay, so
        // don't leave the socket dangling.
        if result.is_err() && ssh_auth_sock.is_some() {
            self.agent_forward.stop_listener(session_id).await;
        }
        result
    }

    /// Start the desktop ssh-agent relay for a session when it applies, returning
    /// the relay endpoint (unix socket / Windows pipe) to export to the daemon
    /// (#1727/#2038).
    async fn start_agent_forward(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
    ) -> Option<String> {
        if !AgentForwardRelay::should_relay(type_id, settings) {
            return None;
        }
        #[cfg(any(unix, windows))]
        {
            match self.agent_forward.start_listener(session_id).await {
                Ok(endpoint) => Some(endpoint),
                Err(e) => {
                    warn!("failed to start ssh-agent relay for {session_id}: {e}");
                    None
                }
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = session_id;
            None
        }
    }

    /// Return the current scrollback buffer for a session (daemon-backed only).
    pub async fn get_buffer(&self, session_id: &str) -> Result<Vec<u8>, String> {
        let mut sessions = self.sessions.lock().await;
        let info = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        match info.backend {
            SessionBackend::Daemon(ref mut client) => {
                client.query_buffer().await.map_err(|e| e.to_string())
            }
            _ => Ok(Vec::new()),
        }
    }

    /// Update the ring-buffer size used for future daemon spawns.
    pub fn set_persistent_buffer_size_bytes(&self, bytes: usize) {
        self.persistent_buffer_size.store(bytes, Ordering::Relaxed);
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
        let alive = Arc::new(AtomicBool::new(true));
        let output_task = spawn_output_forwarder(
            output_rx,
            session_id.to_string(),
            self.notification_tx.clone(),
            alive.clone(),
            self.self_ref.get().cloned().unwrap_or_default(),
        );

        info!("In-process connection for session {session_id} (type={type_id})");
        Ok(SessionBackend::InProcess {
            connection,
            output_task: Some(output_task),
            alive,
        })
    }

    /// List all sessions as read-only snapshots.
    ///
    /// Settles any session whose backend has exited on its own to
    /// [`SessionStatus::Exited`] first, so the desktop never sees a naturally
    /// dead session reported as `Running` (#2369).
    pub async fn list(&self) -> Vec<SessionSnapshot> {
        let mut sessions = self.sessions.lock().await;
        settle_exited(&mut sessions);
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
        {
            let mut sessions = self.sessions.lock().await;
            match sessions.remove(session_id) {
                Some(mut info) => close_backend(&mut info.backend).await,
                None => return false,
            }
        }

        // Tear down any ssh-agent relay this session held (#1727).
        self.agent_forward.stop_listener(session_id).await;

        {
            let mut state = self.state.lock().await;
            state.sessions.remove(session_id);
            state.save_to(&self.state_path);
        }

        // Deferred-update hook: when the last session disconnects and an update
        // is pending, apply it now. Shared with the natural-exit path (#2378)
        // so an explicit close and a self-terminating last session behave alike.
        self.apply_deferred_update_if_idle().await;

        true
    }

    /// Apply a staged deferred self-update when no active session remains.
    ///
    /// Settles any naturally-exited sessions to [`SessionStatus::Exited`] first
    /// (#2369) so the "is the agent idle?" decision reflects reality, then — when
    /// no `Running` session is left — applies the pending update (a no-op when
    /// none is staged). Shared by the explicit-close path
    /// ([`close`](SessionManager::close)) and the natural-exit path (the
    /// output-forwarder marking the last backend dead), so a staged update
    /// auto-applies the moment the agent goes idle regardless of how the last
    /// session ended (#2378). Persistent daemon sessions still counted as running
    /// keep the agent busy and defer the apply, exactly as before.
    async fn apply_deferred_update_if_idle(&self) {
        let idle = {
            let mut sessions = self.sessions.lock().await;
            settle_exited(&mut sessions);
            !sessions
                .values()
                .any(|s| s.status == SessionStatus::Running)
        };
        if idle {
            if let Err(e) = self.apply_pending_update().await {
                warn!("Deferred agent update failed to apply on last disconnect: {e:#}");
            }
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
    ///
    /// Daemon-backed sessions are detached (not killed) so they survive
    /// the agent process exit and can be recovered on the next run.
    /// In-process sessions are disconnected normally.
    pub async fn close_all(&self) {
        let mut sessions = self.sessions.lock().await;
        for (id, mut info) in sessions.drain() {
            self.agent_forward.stop_listener(&id).await;
            shutdown_backend(&mut info.backend).await;
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

    /// Recover sessions from persistent state by reconnecting to
    /// surviving daemon processes.
    pub async fn recover_sessions(&self) -> Vec<String> {
        let state = self.state.lock().await;
        let persisted = state.sessions.clone();
        drop(state);

        let mut recovered = Vec::new();

        for (id, session) in &persisted {
            let endpoint = match &session.daemon_socket {
                Some(p) => p.clone(),
                None => {
                    warn!("Session {id} has no daemon endpoint, removing");
                    let mut state = self.state.lock().await;
                    state.sessions.remove(id);
                    state.save_to(&self.state_path);
                    continue;
                }
            };

            if !endpoint_alive(&endpoint) {
                info!("Daemon endpoint gone for session {id}, removing from state");
                let mut state = self.state.lock().await;
                state.sessions.remove(id);
                state.save_to(&self.state_path);
                continue;
            }

            match DaemonClient::connect(id.clone(), endpoint, self.notification_tx.clone()).await {
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
                        definition_id: session.definition_id.clone(),
                    };

                    let mut sessions = self.sessions.lock().await;
                    sessions.insert(id.clone(), info);
                    recovered.push(id.clone());
                    info!("Recovered session {id} (type={})", session.type_id);
                }
                Err(e) => {
                    warn!("Failed to recover session {id}: {e}");
                    let mut state = self.state.lock().await;
                    state.sessions.remove(id);
                    state.save_to(&self.state_path);
                }
            }
        }

        if !recovered.is_empty() {
            info!("Recovered {} session(s)", recovered.len());
        }

        recovered
    }

    /// Return the number of sessions with status `Running`.
    ///
    /// Sessions whose backend has exited on its own are settled to
    /// [`SessionStatus::Exited`] first, so a naturally dead session is not
    /// counted as active (#2369) — this keeps the deferred-update "is idle"
    /// check and any leak detection honest.
    pub async fn active_count(&self) -> u32 {
        let mut sessions = self.sessions.lock().await;
        settle_exited(&mut sessions);
        sessions
            .values()
            .filter(|s| s.status == SessionStatus::Running)
            .count() as u32
    }

    /// Record a deferred agent update and apply it immediately if the agent is
    /// already idle (#1352).
    ///
    /// When `binary_path` is `Some`, that binary is staged as the pending update
    /// (persisted to `state.json`). When it is `None`, the already-staged pending
    /// update is used — this is the "Apply Now" path for a self-update binary the
    /// agent downloaded earlier.
    ///
    /// The update is applied immediately **only** when there are zero active
    /// sessions; otherwise it is deferred until the last session disconnects
    /// (see [`SessionManager::close`]). Active sessions are never interrupted.
    pub async fn request_deferred_update(
        &self,
        binary_path: Option<String>,
        version: Option<String>,
    ) -> Result<DeferredUpdateOutcome, DeferredUpdateError> {
        // Stage a caller-supplied binary, or fall back to an existing pending
        // update.
        if let Some(path) = binary_path {
            if !Path::new(&path).is_file() {
                return Err(DeferredUpdateError::BinaryNotFound(path));
            }
            let mut state = self.state.lock().await;
            state.update.pending_update = Some(PendingUpdate {
                version: version.unwrap_or_default(),
                binary_path: path,
                staged_at: Utc::now().to_rfc3339(),
            });
            state.save_to(&self.state_path);
        }

        let has_pending = self.state.lock().await.update.pending_update.is_some();
        if !has_pending {
            return Err(DeferredUpdateError::NoPendingUpdate);
        }

        let active = self.active_count().await;
        if should_apply_deferred_update(active, true) {
            self.apply_pending_update()
                .await
                .map_err(DeferredUpdateError::ApplyFailed)?;
            Ok(DeferredUpdateOutcome::Applying)
        } else {
            info!(
                "Deferred agent update recorded — will apply when the last of {active} \
                 active session(s) disconnects"
            );
            Ok(DeferredUpdateOutcome::Deferred {
                active_sessions: active,
            })
        }
    }

    /// Record the timestamp of the most recent self-update poll (#1401).
    ///
    /// Owned here so the self-update timer and the deferred-apply path share a
    /// single in-memory + persisted `update` state; a direct write from the
    /// timer would be clobbered by the next session-close persist.
    pub async fn record_update_check_time(&self, timestamp: String) {
        let mut state = self.state.lock().await;
        state.update.last_check_time = Some(timestamp);
        state.save_to(&self.state_path);
    }

    /// Record a staged pending update in the shared agent state **without**
    /// applying it (#1401).
    ///
    /// Used by the self-update timer when the connection's update strategy does
    /// not auto-apply on idle (coordinated), so a later coordinated apply — or
    /// an explicit `agent.request_deferred_update` — can consume it.
    pub async fn stage_pending_update(&self, binary_path: String, version: String) {
        let mut state = self.state.lock().await;
        state.update.pending_update = Some(PendingUpdate {
            version,
            binary_path,
            staged_at: Utc::now().to_rfc3339(),
        });
        state.save_to(&self.state_path);
    }

    /// Apply the pending update, clearing it from persisted state **only on
    /// success**. A no-op when nothing is pending.
    ///
    /// The update is applied first and the pending record is cleared afterwards,
    /// so a failed apply KEEPS the pending update and a later cycle (the next
    /// last-disconnect, or the next self-update poll) can retry (#1401). On a
    /// successful Unix apply the process re-execs and this never returns, so the
    /// clear only runs in tests / on the non-Unix path; there, the re-execed
    /// agent drops the already-applied record at startup instead — see
    /// [`prune_applied_pending_update`] and `with_deps` (#1551). Retaining on
    /// failure cannot cause a tight apply loop: applies fire only on discrete
    /// transitions (a session closing to zero, or a 24h poll), never in a spin.
    async fn apply_pending_update(&self) -> anyhow::Result<()> {
        let pending = { self.state.lock().await.update.pending_update.clone() };
        let Some(pending) = pending else {
            return Ok(());
        };
        info!(
            "Applying deferred agent update (version {:?}) from {}",
            pending.version, pending.binary_path
        );
        self.update_applier.apply(&pending)?;
        // Success (test / non-unix path): consume the pending update.
        let mut state = self.state.lock().await;
        state.update.pending_update = None;
        state.save_to(&self.state_path);
        Ok(())
    }
}

// ── Backend operations ─────────────────────────────────────────────

async fn close_backend(backend: &mut SessionBackend) {
    match backend {
        SessionBackend::Daemon(ref mut client) => {
            client.close().await;
        }
        SessionBackend::InProcess {
            connection,
            output_task,
            ..
        } => {
            if let Err(e) = connection.disconnect().await {
                warn!("Disconnect error: {e}");
            }
            if let Some(task) = output_task.take() {
                task.abort();
            }
        }
        #[cfg(test)]
        SessionBackend::Stub { .. } => {}
    }
}

/// Shut down a backend during agent exit.
///
/// Daemon backends are detached (not killed) so the daemon process
/// survives and can be recovered when the agent restarts. In-process
/// backends are disconnected normally.
async fn shutdown_backend(backend: &mut SessionBackend) {
    match backend {
        SessionBackend::Daemon(ref mut client) => {
            client.detach().await;
        }
        SessionBackend::InProcess {
            connection,
            output_task,
            ..
        } => {
            if let Err(e) = connection.disconnect().await {
                warn!("Disconnect error: {e}");
            }
            if let Some(task) = output_task.take() {
                task.abort();
            }
        }
        #[cfg(test)]
        SessionBackend::Stub { .. } => {}
    }
}

async fn attach_backend(backend: &mut SessionBackend) -> Result<(), anyhow::Error> {
    match backend {
        SessionBackend::Daemon(ref mut client) => {
            client.attach().await?;
        }
        SessionBackend::InProcess { .. } => {
            // In-process connections always forward output; no-op.
        }
        #[cfg(test)]
        SessionBackend::Stub { .. } => {}
    }
    Ok(())
}

async fn detach_backend(backend: &mut SessionBackend) {
    match backend {
        SessionBackend::Daemon(ref mut client) => {
            client.detach().await;
        }
        SessionBackend::InProcess { .. } => {
            // In-process connections keep forwarding; no-op.
        }
        #[cfg(test)]
        SessionBackend::Stub { .. } => {}
    }
}

// ── Output forwarding ──────────────────────────────────────────────

/// Spawn a background task that reads from the ConnectionType's output
/// channel and sends JSON-RPC notifications via [`JsonRpcOutputSink`].
fn spawn_output_forwarder(
    mut output_rx: OutputReceiver,
    session_id: String,
    notification_tx: NotificationSender,
    alive: Arc<AtomicBool>,
    manager: Weak<SessionManager>,
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
                    // The connection's output channel closed: the backend
                    // process exited / hit EOF on its own. Mark the backend dead
                    // so the manager settles the session to `Exited` (#2369),
                    // then notify the desktop.
                    alive.store(false, Ordering::SeqCst);
                    let _ = sink.send_exit(&session_id, Some(0));
                    // Natural-exit deferred-update hook (#2378): if this was the
                    // last active session, apply any staged self-update now,
                    // matching the explicit-close path. The `Weak` is empty when
                    // the manager was not built through `into_arc`; then this is
                    // skipped and the read-path reconciliation still settles the
                    // session.
                    if let Some(manager) = manager.upgrade() {
                        manager.apply_deferred_update_if_idle().await;
                    }
                    return;
                }
            }
        }
    })
}

/// Settle any session whose backend has exited on its own to
/// [`SessionStatus::Exited`].
///
/// Natural backend exit (daemon `MSG_EXITED`/EOF, or an in-process
/// output-channel close) is detected asynchronously by the reader/forwarder
/// tasks, which flip the backend's liveness flag but cannot reach the session
/// map. This reconciles that liveness into the stored session status on the
/// read paths that report it, so a dead session no longer lingers as `Running`
/// (#2369). Exited sessions are kept in the map (not dropped) so the desktop can
/// still see and explicitly close them.
fn settle_exited(sessions: &mut HashMap<String, SessionInfo>) {
    for info in sessions.values_mut() {
        if info.status == SessionStatus::Running && !info.backend.is_alive() {
            info.status = SessionStatus::Exited;
        }
    }
}

// ── SessionManagerApi impl ─────────────────────────────────────────

#[async_trait::async_trait]
impl SessionManagerApi for SessionManager {
    fn registry(&self) -> &ConnectionTypeRegistry {
        &self.registry
    }

    async fn create(
        &self,
        type_id: &str,
        title: String,
        settings: serde_json::Value,
        definition_id: Option<String>,
    ) -> Result<SessionSnapshot, SessionCreateError> {
        SessionManager::create(self, type_id, title, settings, definition_id).await
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

    async fn request_deferred_update(
        &self,
        binary_path: Option<String>,
        version: Option<String>,
    ) -> Result<DeferredUpdateOutcome, DeferredUpdateError> {
        SessionManager::request_deferred_update(self, binary_path, version).await
    }

    async fn attach(&self, session_id: &str) -> Result<(), String> {
        SessionManager::attach(self, session_id).await
    }

    async fn detach(&self, session_id: &str) -> Result<(), String> {
        SessionManager::detach(self, session_id).await
    }

    /// The sessions lock is released before any async operation so the future
    /// is `Send` regardless of the `ConnectionType` in-process implementations.
    async fn write_input(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut daemon_handle: Option<DaemonWriterHandle> = None;
        let sync_result: Option<Result<(), String>>;

        {
            let mut sessions = self.sessions.lock().await;
            let info = sessions
                .get_mut(session_id)
                .ok_or_else(|| "Session not found".to_string())?;
            info.last_activity = Utc::now();
            match &info.backend {
                SessionBackend::Daemon(client) => {
                    daemon_handle = Some(client.writer_handle());
                    sync_result = None;
                }
                SessionBackend::InProcess { connection, .. } => {
                    sync_result = Some(connection.write(data).map_err(|e| e.to_string()));
                }
                #[cfg(test)]
                SessionBackend::Stub { .. } => {
                    sync_result = Some(Ok(()));
                }
            }
        }

        if let Some(result) = sync_result {
            return result;
        }
        if let Some(handle) = daemon_handle {
            return DaemonClient::write_via_handle(&handle, data)
                .await
                .map_err(|e| e.to_string());
        }
        Ok(())
    }

    /// The sessions lock is released before any async operation so the future
    /// is `Send` regardless of the `ConnectionType` in-process implementations.
    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut daemon_handle: Option<DaemonWriterHandle> = None;
        let sync_result: Option<Result<(), String>>;

        {
            let mut sessions = self.sessions.lock().await;
            let info = sessions
                .get_mut(session_id)
                .ok_or_else(|| "Session not found".to_string())?;
            info.last_activity = Utc::now();
            match &info.backend {
                SessionBackend::Daemon(client) => {
                    daemon_handle = Some(client.writer_handle());
                    sync_result = None;
                }
                SessionBackend::InProcess { connection, .. } => {
                    sync_result = Some(connection.resize(cols, rows).map_err(|e| e.to_string()));
                }
                #[cfg(test)]
                SessionBackend::Stub { .. } => {
                    sync_result = Some(Ok(()));
                }
            }
        }

        if let Some(result) = sync_result {
            return result;
        }
        if let Some(handle) = daemon_handle {
            return DaemonClient::resize_via_handle(&handle, cols, rows)
                .await
                .map_err(|e| e.to_string());
        }
        Ok(())
    }

    async fn get_buffer(&self, session_id: &str) -> Result<Vec<u8>, String> {
        SessionManager::get_buffer(self, session_id).await
    }

    async fn set_persistent_buffer_size_bytes(&self, bytes: usize) {
        SessionManager::set_persistent_buffer_size_bytes(self, bytes);
    }

    async fn agent_forward_write(&self, stream_id: &str, data: Vec<u8>) {
        self.agent_forward.write(stream_id, data).await;
    }

    async fn agent_forward_close(&self, stream_id: &str) {
        self.agent_forward.close_stream(stream_id).await;
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

    // The daemon-detachment test (#995) moved to `daemon::spawn` along with the
    // helper it covers, which both daemon roles now share.

    // ── connect_or_daemon_exit (issue #847) ──────────────────────────

    #[tokio::test]
    async fn connect_or_daemon_exit_returns_connect_success() {
        // A successful connect is returned even though the daemon never exits.
        let result: Result<i32, _> = connect_or_daemon_exit("s1", async { Ok(42) }, || None).await;
        assert_eq!(result.unwrap(), 42);
    }

    #[tokio::test]
    async fn connect_or_daemon_exit_fails_fast_when_daemon_dies() {
        // Connect never completes (endpoint never appears), but the daemon has
        // exited — we must surface that, not hang until the connect timeout.
        let result: Result<i32, _> = connect_or_daemon_exit(
            "s2",
            std::future::pending::<Result<i32, anyhow::Error>>(),
            || Some("exit status: 1".to_string()),
        )
        .await;
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("exited before its endpoint was ready") && err.contains("exit status: 1"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn connect_or_daemon_exit_propagates_connect_error() {
        // When the connect itself fails while the daemon is still alive, the
        // original connect error is returned (not the "daemon exited" error).
        let result: Result<i32, _> = connect_or_daemon_exit(
            "s3",
            async { Err(anyhow::anyhow!("connect failed: handshake timeout")) },
            || None,
        )
        .await;
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("connect failed: handshake timeout"),
            "got: {err}"
        );
        assert!(!err.contains("exited before"), "got: {err}");
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
                backend: SessionBackend::Stub {
                    alive: Arc::new(AtomicBool::new(true)),
                },
                definition_id: None,
            };

            let snapshot = info.snapshot();
            sessions.insert(id, info);
            Ok(snapshot)
        }

        /// Mark a session's backend as exited (test-only), simulating the
        /// backend process dying on its own without an explicit close (#2369).
        #[cfg(test)]
        pub async fn mark_backend_exited_for_test(&self, session_id: &str) {
            let sessions = self.sessions.lock().await;
            if let Some(info) = sessions.get(session_id) {
                match &info.backend {
                    SessionBackend::Stub { alive } => alive.store(false, Ordering::SeqCst),
                    SessionBackend::InProcess { alive, .. } => alive.store(false, Ordering::SeqCst),
                    SessionBackend::Daemon(_) => {}
                }
            }
        }

        /// Seed a pending update directly into the in-memory + persisted state
        /// (test-only), so the zero-session hook has something to apply.
        #[cfg(test)]
        pub async fn seed_pending_update_for_test(
            &self,
            pending: crate::state::persistence::PendingUpdate,
        ) {
            let mut state = self.state.lock().await;
            state.update.pending_update = Some(pending);
            state.save_to(&self.state_path);
        }

        /// Read the current pending update (test-only).
        #[cfg(test)]
        pub async fn pending_update_for_test(
            &self,
        ) -> Option<crate::state::persistence::PendingUpdate> {
            self.state.lock().await.update.pending_update.clone()
        }
    }

    // ── Deferred update (issue #1352) ────────────────────────────────

    mod deferred_update_tests {
        use super::*;
        use crate::state::persistence::PendingUpdate;
        use crate::update::UpdateApplier;
        use std::sync::Mutex as StdMutex;

        /// [`UpdateApplier`] that records apply calls instead of swapping the
        /// binary + re-execing, so the zero-session hook can be tested without
        /// replacing the test process.
        struct RecordingApplier {
            applied: Arc<StdMutex<Vec<PendingUpdate>>>,
        }

        impl UpdateApplier for RecordingApplier {
            fn apply(&self, pending: &PendingUpdate) -> anyhow::Result<()> {
                self.applied
                    .lock()
                    .expect("recording lock")
                    .push(pending.clone());
                Ok(())
            }
        }

        /// [`UpdateApplier`] that always fails, to exercise retain-on-failure.
        struct FailingApplier {
            attempts: Arc<StdMutex<Vec<PendingUpdate>>>,
        }

        impl UpdateApplier for FailingApplier {
            fn apply(&self, pending: &PendingUpdate) -> anyhow::Result<()> {
                self.attempts
                    .lock()
                    .expect("attempts lock")
                    .push(pending.clone());
                anyhow::bail!("simulated apply failure")
            }
        }

        fn manager_with_failing_applier() -> (SessionManager, AppliedLog, tempfile::TempDir) {
            let tmp = tempfile::tempdir().unwrap();
            let state_path = tmp.path().join("state.json");
            let attempts: AppliedLog = Arc::new(StdMutex::new(Vec::new()));
            let mgr = SessionManager::with_test_deps(
                test_notification_tx(),
                test_registry(),
                Arc::new(SystemDaemonLauncher),
                state_path,
                Arc::new(FailingApplier {
                    attempts: attempts.clone(),
                }),
            );
            (mgr, attempts, tmp)
        }

        type AppliedLog = Arc<StdMutex<Vec<PendingUpdate>>>;

        fn manager_with_recording_applier() -> (SessionManager, AppliedLog, tempfile::TempDir) {
            let tmp = tempfile::tempdir().unwrap();
            let state_path = tmp.path().join("state.json");
            let applied: AppliedLog = Arc::new(StdMutex::new(Vec::new()));
            let mgr = SessionManager::with_test_deps(
                test_notification_tx(),
                test_registry(),
                Arc::new(SystemDaemonLauncher),
                state_path,
                Arc::new(RecordingApplier {
                    applied: applied.clone(),
                }),
            );
            (mgr, applied, tmp)
        }

        fn fake_pending(path: &str) -> PendingUpdate {
            PendingUpdate {
                version: "0.9.0".to_string(),
                binary_path: path.to_string(),
                staged_at: "2026-07-14T09:00:00Z".to_string(),
            }
        }

        #[tokio::test]
        async fn applies_only_on_last_disconnect() {
            let (mgr, applied, _tmp) = manager_with_recording_applier();
            mgr.create_stub_session("stub", "A".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            mgr.create_stub_session("stub", "B".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            mgr.seed_pending_update_for_test(fake_pending("/tmp/new-agent"))
                .await;

            let ids: Vec<String> = mgr.list().await.into_iter().map(|s| s.id).collect();

            // Closing the first of two sessions must NOT apply the update.
            mgr.close(&ids[0]).await;
            assert!(
                applied.lock().unwrap().is_empty(),
                "update must not apply while a session is still running"
            );

            // Closing the last session applies it exactly once.
            mgr.close(&ids[1]).await;
            {
                let log = applied.lock().unwrap();
                assert_eq!(log.len(), 1, "update applies exactly on last disconnect");
                assert_eq!(log[0].binary_path, "/tmp/new-agent");
            }
            // A successful apply clears the pending update.
            assert!(
                mgr.pending_update_for_test().await.is_none(),
                "successful apply on last disconnect clears pending_update"
            );
        }

        #[tokio::test]
        async fn failed_apply_on_last_disconnect_keeps_pending() {
            // Retain-on-failure (#1401): if the apply fails on the last
            // disconnect, the pending update is KEPT so a later cycle can retry.
            let (mgr, attempts, _tmp) = manager_with_failing_applier();
            mgr.create_stub_session("stub", "A".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            mgr.seed_pending_update_for_test(fake_pending("/tmp/new-agent"))
                .await;
            let ids: Vec<String> = mgr.list().await.into_iter().map(|s| s.id).collect();

            mgr.close(&ids[0]).await;

            assert_eq!(attempts.lock().unwrap().len(), 1, "apply was attempted");
            assert!(
                mgr.pending_update_for_test().await.is_some(),
                "a failed apply must keep pending_update for retry"
            );
        }

        /// Regression test for #1551: an already-applied `pending_update` left
        /// in `state.json` (the real Unix apply re-execs and never gets to clear
        /// it) must be swept at startup, so the next last-session disconnect
        /// does NOT re-apply it and re-exec the agent for nothing.
        #[tokio::test]
        async fn already_applied_pending_update_is_cleared_at_startup() {
            let tmp = tempfile::tempdir().unwrap();
            let state_path = tmp.path().join("state.json");

            // A record for a version the running agent is already at or past —
            // exactly what a successful apply leaves behind.
            let mut seeded = AgentState::default();
            seeded.update.pending_update = Some(PendingUpdate {
                version: "0.0.1".to_string(),
                binary_path: "/tmp/already-applied-agent".to_string(),
                staged_at: "2026-07-17T09:00:00Z".to_string(),
            });
            seeded.save_to(&state_path);

            let applied: AppliedLog = Arc::new(StdMutex::new(Vec::new()));
            let mgr = SessionManager::with_test_deps(
                test_notification_tx(),
                test_registry(),
                Arc::new(SystemDaemonLauncher),
                state_path.clone(),
                Arc::new(RecordingApplier {
                    applied: applied.clone(),
                }),
            );

            // Swept from memory and from the persisted state on startup.
            assert!(
                mgr.pending_update_for_test().await.is_none(),
                "an already-applied pending update must be cleared at startup"
            );
            assert!(
                AgentState::load_from(&state_path)
                    .update
                    .pending_update
                    .is_none(),
                "the cleared state must be persisted, not just in memory"
            );

            // The property that matters: no spurious apply/re-exec on the next
            // idle transition.
            mgr.create_stub_session("stub", "A".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            let ids: Vec<String> = mgr.list().await.into_iter().map(|s| s.id).collect();
            mgr.close(&ids[0]).await;

            assert!(
                applied.lock().unwrap().is_empty(),
                "an already-applied update must not re-apply (and re-exec) on the next idle"
            );
        }

        /// A genuinely unapplied pending update (newer version, binary not the
        /// running one) must survive startup and still apply on idle — the
        /// #1551 sweep must not eat a legitimate retry.
        #[tokio::test]
        async fn unapplied_pending_update_survives_startup_and_still_applies() {
            let tmp = tempfile::tempdir().unwrap();
            let state_path = tmp.path().join("state.json");
            let staged = tmp.path().join("staged-agent");
            std::fs::write(&staged, b"A-GENUINELY-DIFFERENT-BINARY").unwrap();

            let mut seeded = AgentState::default();
            seeded.update.pending_update = Some(PendingUpdate {
                version: "9.9.9".to_string(),
                binary_path: staged.to_string_lossy().into_owned(),
                staged_at: "2026-07-17T09:00:00Z".to_string(),
            });
            seeded.save_to(&state_path);

            let applied: AppliedLog = Arc::new(StdMutex::new(Vec::new()));
            let mgr = SessionManager::with_test_deps(
                test_notification_tx(),
                test_registry(),
                Arc::new(SystemDaemonLauncher),
                state_path,
                Arc::new(RecordingApplier {
                    applied: applied.clone(),
                }),
            );

            assert!(
                mgr.pending_update_for_test().await.is_some(),
                "an unapplied pending update must survive startup"
            );

            mgr.create_stub_session("stub", "A".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            let ids: Vec<String> = mgr.list().await.into_iter().map(|s| s.id).collect();
            mgr.close(&ids[0]).await;

            assert_eq!(
                applied.lock().unwrap().len(),
                1,
                "a retained pending update must still apply on the next idle"
            );
        }

        #[tokio::test]
        async fn last_disconnect_without_pending_does_not_apply() {
            let (mgr, applied, _tmp) = manager_with_recording_applier();
            mgr.create_stub_session("stub", "A".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            let ids: Vec<String> = mgr.list().await.into_iter().map(|s| s.id).collect();
            mgr.close(&ids[0]).await;
            assert!(
                applied.lock().unwrap().is_empty(),
                "no pending update → nothing applied on last disconnect"
            );
        }

        #[tokio::test]
        async fn request_with_active_sessions_defers_without_applying() {
            let (mgr, applied, tmp) = manager_with_recording_applier();
            mgr.create_stub_session("stub", "A".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            // A real file so path validation passes.
            let bin = tmp.path().join("staged-agent");
            std::fs::write(&bin, b"BIN").unwrap();

            let outcome = mgr
                .request_deferred_update(
                    Some(bin.to_string_lossy().into_owned()),
                    Some("1.0.0".to_string()),
                )
                .await
                .unwrap();

            assert!(
                matches!(
                    outcome,
                    DeferredUpdateOutcome::Deferred { active_sessions: 1 }
                ),
                "must defer with an active session, got {outcome:?}"
            );
            assert!(
                applied.lock().unwrap().is_empty(),
                "must not apply while a session is active"
            );
            assert!(
                mgr.pending_update_for_test().await.is_some(),
                "the pending update must be persisted for the last-disconnect apply"
            );
        }

        #[tokio::test]
        async fn request_when_idle_applies_immediately() {
            let (mgr, applied, tmp) = manager_with_recording_applier();
            let bin = tmp.path().join("staged-agent");
            std::fs::write(&bin, b"BIN").unwrap();

            let outcome = mgr
                .request_deferred_update(Some(bin.to_string_lossy().into_owned()), None)
                .await
                .unwrap();

            assert!(
                matches!(outcome, DeferredUpdateOutcome::Applying),
                "idle agent applies immediately, got {outcome:?}"
            );
            assert_eq!(applied.lock().unwrap().len(), 1);
            // Consumed on apply.
            assert!(mgr.pending_update_for_test().await.is_none());
        }

        #[tokio::test]
        async fn request_without_path_applies_existing_pending_when_idle() {
            // The "Apply Now" path for an already-staged self-update: no binary
            // path is supplied, the agent uses its recorded pending update.
            let (mgr, applied, _tmp) = manager_with_recording_applier();
            mgr.seed_pending_update_for_test(fake_pending("/tmp/staged-agent"))
                .await;

            let outcome = mgr.request_deferred_update(None, None).await.unwrap();
            assert!(matches!(outcome, DeferredUpdateOutcome::Applying));
            let log = applied.lock().unwrap();
            assert_eq!(log.len(), 1);
            assert_eq!(log[0].binary_path, "/tmp/staged-agent");
        }

        #[tokio::test]
        async fn request_without_path_and_no_pending_errors() {
            let (mgr, _applied, _tmp) = manager_with_recording_applier();
            let err = mgr.request_deferred_update(None, None).await.unwrap_err();
            assert!(matches!(err, DeferredUpdateError::NoPendingUpdate));
        }

        #[tokio::test]
        async fn request_with_missing_binary_errors() {
            let (mgr, _applied, _tmp) = manager_with_recording_applier();
            let err = mgr
                .request_deferred_update(Some("/no/such/binary".to_string()), None)
                .await
                .unwrap_err();
            assert!(matches!(err, DeferredUpdateError::BinaryNotFound(_)));
        }

        // ── Natural-exit deferred-apply (issue #2378) ────────────────────

        #[tokio::test]
        async fn natural_exit_applies_only_after_the_last_session_goes() {
            // The natural-exit twin of `applies_only_on_last_disconnect`: a
            // backend that exits on its own (no explicit close) must trigger the
            // same "reached zero → apply pending update" hook, but only once the
            // *last* running session is gone.
            let (mgr, applied, _tmp) = manager_with_recording_applier();
            let a = mgr
                .create_stub_session("stub", "A".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            let b = mgr
                .create_stub_session("stub", "B".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            mgr.seed_pending_update_for_test(fake_pending("/tmp/new-agent"))
                .await;

            // First backend exits naturally — one session still running, so the
            // idle hook must NOT apply.
            mgr.mark_backend_exited_for_test(&a.id).await;
            mgr.apply_deferred_update_if_idle().await;
            assert!(
                applied.lock().unwrap().is_empty(),
                "update must not apply while a session is still running"
            );
            assert!(
                mgr.pending_update_for_test().await.is_some(),
                "the pending update must be retained until the agent is idle"
            );

            // Last backend exits naturally — now idle, so the staged update
            // applies exactly once and is consumed.
            mgr.mark_backend_exited_for_test(&b.id).await;
            mgr.apply_deferred_update_if_idle().await;
            {
                let log = applied.lock().unwrap();
                assert_eq!(log.len(), 1, "update applies exactly once when idle");
                assert_eq!(log[0].binary_path, "/tmp/new-agent");
            }
            assert!(
                mgr.pending_update_for_test().await.is_none(),
                "a successful natural-exit apply clears pending_update"
            );
        }

        #[tokio::test]
        async fn natural_exit_without_pending_does_not_apply() {
            // No staged update → a naturally exiting last session applies nothing.
            let (mgr, applied, _tmp) = manager_with_recording_applier();
            let a = mgr
                .create_stub_session("stub", "A".to_string(), serde_json::json!({}))
                .await
                .unwrap();

            mgr.mark_backend_exited_for_test(&a.id).await;
            mgr.apply_deferred_update_if_idle().await;

            assert!(
                applied.lock().unwrap().is_empty(),
                "no pending update → nothing applied on natural exit"
            );
        }

        #[tokio::test]
        async fn output_forwarder_applies_pending_update_on_last_exit() {
            // End-to-end wiring: the output-forwarder must reach back into the
            // manager (via the `into_arc` self-reference) and run the deferred
            // apply when the last backend's output channel closes (#2378).
            let tmp = tempfile::tempdir().unwrap();
            let state_path = tmp.path().join("state.json");
            let applied: AppliedLog = Arc::new(StdMutex::new(Vec::new()));
            let mgr = SessionManager::with_test_deps(
                test_notification_tx(),
                test_registry(),
                Arc::new(SystemDaemonLauncher),
                state_path,
                Arc::new(RecordingApplier {
                    applied: applied.clone(),
                }),
            )
            .into_arc();
            mgr.seed_pending_update_for_test(fake_pending("/tmp/new-agent"))
                .await;

            // No running sessions: the manager is already idle, so the forwarder
            // detecting its backend's EOF must trigger the apply.
            let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
            let alive = Arc::new(AtomicBool::new(true));
            let handle = spawn_output_forwarder(
                rx,
                "sess".to_string(),
                test_notification_tx(),
                alive.clone(),
                Arc::downgrade(&mgr),
            );

            drop(tx); // model the backend exiting / EOF
            handle.await.expect("forwarder task joins cleanly");

            assert!(!alive.load(Ordering::SeqCst), "backend marked dead");
            assert_eq!(
                applied.lock().unwrap().len(),
                1,
                "the forwarder must apply the staged update on the last natural exit"
            );
            assert!(
                mgr.pending_update_for_test().await.is_none(),
                "a successful apply clears pending_update"
            );
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
            .create("nonexistent-type", "test".to_string(), json!({}), None)
            .await;
        assert!(matches!(result, Err(SessionCreateError::InvalidConfig(_))));
    }

    #[tokio::test]
    async fn registry_accessible() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        assert!(mgr.registry().has_type("local"));
        assert!(mgr.registry().has_type("ssh"));
    }

    #[tokio::test]
    async fn get_buffer_returns_error_for_nonexistent_session() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        let result = mgr.get_buffer("nonexistent-session-id").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Session not found"));
    }

    #[tokio::test]
    async fn get_buffer_returns_empty_for_stub_session() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        mgr.create_stub_session("stub", "Test Stub".to_string(), serde_json::json!({}))
            .await
            .unwrap();
        let sessions = mgr.list().await;
        let session_id = sessions[0].id.clone();
        // Stub sessions return empty buffer
        let result = mgr.get_buffer(&session_id).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    // ── Natural-exit status settling (issue #2369) ────────────────────

    #[tokio::test]
    async fn session_settles_to_exited_when_backend_exits() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        let snap = mgr
            .create_stub_session("stub", "A".to_string(), serde_json::json!({}))
            .await
            .unwrap();

        // Freshly created: running and counted as active.
        let listed = mgr.list().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, SessionStatus::Running);
        assert_eq!(mgr.active_count().await, 1);

        // Simulate the backend process exiting on its own (no explicit close).
        mgr.mark_backend_exited_for_test(&snap.id).await;

        // list() must now report the session as Exited (not Running), and it
        // must still be listed — settled, not silently dropped.
        let listed = mgr.list().await;
        assert_eq!(listed.len(), 1, "exited session must remain listed");
        assert_eq!(listed[0].status, SessionStatus::Exited);

        // active_count() must no longer count a naturally-dead session.
        assert_eq!(mgr.active_count().await, 0);
    }

    #[tokio::test]
    async fn output_forwarder_marks_backend_dead_on_channel_close() {
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        let alive = Arc::new(AtomicBool::new(true));
        let handle = spawn_output_forwarder(
            rx,
            "sess".to_string(),
            test_notification_tx(),
            alive.clone(),
            Weak::new(),
        );

        assert!(alive.load(Ordering::SeqCst), "alive before channel closes");

        // Closing the output channel models the backend process exiting / EOF;
        // the forwarder must flip the liveness flag so the session can settle.
        drop(tx);
        handle.await.expect("forwarder task joins cleanly");
        assert!(
            !alive.load(Ordering::SeqCst),
            "backend must be marked dead once its output channel closes"
        );
    }

    #[tokio::test]
    async fn set_persistent_buffer_size_bytes_updates_atomic() {
        let mgr = SessionManager::new(test_notification_tx(), test_registry());
        mgr.set_persistent_buffer_size_bytes(2 * 1024 * 1024);
        assert_eq!(
            mgr.persistent_buffer_size
                .load(std::sync::atomic::Ordering::Relaxed),
            2 * 1024 * 1024
        );
    }

    // ── DaemonLauncher unit tests ─────────────────────────────────────

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

        #[async_trait::async_trait]
        impl DaemonLauncher for MockDaemonLauncher {
            async fn launch(
                &self,
                session_id: &str,
                type_id: &str,
                _settings: &serde_json::Value,
                _notification_tx: NotificationSender,
                _buffer_size_bytes: usize,
                _ssh_auth_sock: Option<String>,
            ) -> Result<SessionBackend, anyhow::Error> {
                if self.should_fail {
                    return Err(anyhow::anyhow!("mock: daemon spawn failed"));
                }
                self.launched
                    .lock()
                    .await
                    .push((session_id.to_string(), type_id.to_string()));
                Ok(SessionBackend::Stub {
                    alive: Arc::new(AtomicBool::new(true)),
                })
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
                    None,
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
                    None,
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
                    None,
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
                    None,
                )
                .await
                .unwrap();
            let list = mgr.list().await;
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].id, snapshot.id);
            assert_eq!(list[0].title, "my-ssh");
        }

        /// Regression: close_all() must drain the in-memory session list
        /// even with the new shutdown_backend behaviour (detach daemons, don't kill).
        #[tokio::test]
        async fn close_all_drains_daemon_sessions() {
            let (mgr, _) = make_manager_with_mock(MockDaemonLauncher::new());
            mgr.create(
                "ssh",
                "session-a".to_string(),
                serde_json::json!({
                    "host": "example.com",
                    "username": "user",
                    "authMethod": "password",
                }),
                None,
            )
            .await
            .unwrap();
            assert_eq!(mgr.list().await.len(), 1);
            mgr.close_all().await;
            assert!(
                mgr.list().await.is_empty(),
                "close_all() must remove sessions from the in-memory list"
            );
        }
    }
}
