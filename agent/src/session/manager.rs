//! Generic session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Sessions are either hosted in-process (non-persistent) or in a daemon
//! subprocess (persistent). The decision is based on the connection type's
//! [`Capabilities::persistent`] flag. Daemon-backed sessions are cross-platform
//! (Unix domain socket on unix, named pipe on windows — see
//! [`crate::daemon::transport`]).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use chrono::Utc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::io::transport::NotificationSender;
use crate::ki_prompt::relay::{
    KiConnectFailure, KiFailureKind, KiRelaySession, KI_PROMPT_ENDPOINT_ENV,
};
use crate::ki_prompt::{KiPromptHub, PromptActivity};
use crate::session::agent_forward::AgentForwardRelay;
use crate::session::types::{
    HostSessionSnapshot, SessionBackend, SessionHolder, SessionInfo, SessionSnapshot, SessionStatus,
};
use crate::transport::JsonRpcOutputSink;
use termihub_core::buffer::DEFAULT_BUFFER_CAPACITY;
use termihub_core::connection::{ConnectionTypeRegistry, OutputReceiver};
use termihub_core::session::pump::{run_output_pump, PumpEnd, PumpOptions};
use termihub_core::session::traits::OutputSink;

use crate::daemon::client::{
    evicted_notification, DaemonClient, DaemonWriterHandle, ExitHook, ExitHookFuture,
    OwnedByLivePeer, ProbeOutcome, EVICTED_REASON_HELD_BY_PEER,
};
use crate::daemon::transport::{endpoint_alive, remove_session_files, session_endpoint};
use crate::state::persistence::{AgentState, PendingUpdate, PersistedSession};
use crate::update::{
    cleanup_stale_update_backup, confine_to_staging, prune_applied_pending_update,
    should_apply_deferred_update, StagingConfinementError, SystemUpdateApplier, UpdateApplier,
    UpdateSignatureError,
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

    /// List every session running on this host for this user — including ones
    /// another desktop holds or nobody holds — with who controls each (#3369).
    /// Defaults to [`list`](Self::list) classified by its `attached` flag so test
    /// doubles need not implement it.
    async fn list_host(&self) -> Vec<HostSessionSnapshot> {
        self.list()
            .await
            .into_iter()
            .map(|snapshot| HostSessionSnapshot {
                holder: if snapshot.attached {
                    SessionHolder::Me
                } else {
                    SessionHolder::Nobody
                },
                snapshot,
            })
            .collect()
    }

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
        expected_sha256: Option<String>,
        signature: Option<String>,
    ) -> Result<DeferredUpdateOutcome, DeferredUpdateError>;

    /// Attach a client to an existing session.
    async fn attach(&self, session_id: &str) -> Result<(), String>;

    /// Explicit **Reclaim** (SM-003, single-attach): take control of a session
    /// even when this worker does not currently hold it, evicting whichever
    /// worker (another desktop) does. Defaults to a plain [`attach`](Self::attach)
    /// so test doubles need not implement it.
    async fn reclaim(&self, session_id: &str) -> Result<(), String> {
        self.attach(session_id).await
    }

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
    /// The user cancelled an SSH keyboard-interactive prompt (#3375).
    AuthCancelled(String),
    /// A user-typed later SSH factor (one-time code) was rejected after an
    /// earlier factor was accepted (#3375, #3376).
    SecondFactorFailed(String),
}

impl SessionCreateError {
    /// Classify a backend bring-up failure, keeping the typed prompt outcomes.
    fn from_backend(e: anyhow::Error) -> Self {
        match e.downcast_ref::<KiConnectFailure>() {
            Some(KiConnectFailure(KiFailureKind::AuthCancelled)) => {
                Self::AuthCancelled(e.to_string())
            }
            Some(KiConnectFailure(KiFailureKind::SecondFactorFailed)) => {
                Self::SecondFactorFailed(e.to_string())
            }
            None => Self::BackendFailed(e.to_string()),
        }
    }
}

impl fmt::Display for SessionCreateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LimitReached => write!(f, "Session limit reached (max {MAX_SESSIONS})"),
            Self::InvalidConfig(msg) => write!(f, "Invalid configuration: {msg}"),
            Self::BackendFailed(msg) => write!(f, "Backend failed: {msg}"),
            Self::AuthCancelled(msg) | Self::SecondFactorFailed(msg) => write!(f, "{msg}"),
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
    /// The update was refused because its Ed25519 signature is missing,
    /// malformed, or does not verify against the compiled-in release key
    /// (AGT-005, #3213). Surfaced to the desktop with a dedicated error code.
    SignatureRejected(UpdateSignatureError),
}

impl fmt::Display for DeferredUpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BinaryNotFound(path) => write!(f, "Update binary not found: {path}"),
            Self::NoPendingUpdate => write!(f, "No pending update to apply"),
            Self::ApplyFailed(e) => write!(f, "Failed to apply update: {e:#}"),
            Self::SignatureRejected(e) => write!(f, "Update signature rejected: {e}"),
        }
    }
}

/// Map a staging-confinement rejection (AGT-003) onto the existing deferred
/// update error surface, without adding a new dispatch-visible variant.
///
/// A missing / non-file path is the same "bad binary path" the previous
/// `is_file` check reported (`BinaryNotFound`). A real file that resolves
/// **outside** the trusted staging dir is a refused update whose reason is named
/// explicitly, so the desktop surfaces an honest failure rather than a silent or
/// misleading one.
fn map_confinement_error(e: StagingConfinementError) -> DeferredUpdateError {
    match e {
        StagingConfinementError::Unresolvable { path, .. }
        | StagingConfinementError::NotAFile { path } => DeferredUpdateError::BinaryNotFound(path),
        StagingConfinementError::OutsideStaging { path } => DeferredUpdateError::ApplyFailed(
            anyhow::anyhow!("update binary path {path} is outside the trusted staging directory"),
        ),
    }
}

/// Map an apply failure onto the deferred-update error surface, lifting a
/// signature refusal (AGT-005) out of the error chain into its typed variant so
/// the RPC layer can report it with its own error code.
fn map_apply_error(e: anyhow::Error) -> DeferredUpdateError {
    match e.downcast_ref::<UpdateSignatureError>() {
        Some(sig) => DeferredUpdateError::SignatureRejected(sig.clone()),
        None => DeferredUpdateError::ApplyFailed(e),
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
    /// `extras` carries the per-session relay endpoints exported to the daemon;
    /// see [`LaunchExtras`].
    async fn launch(
        &self,
        session_id: &str,
        type_id: &str,
        settings: &serde_json::Value,
        notification_tx: NotificationSender,
        buffer_size_bytes: usize,
        extras: LaunchExtras,
    ) -> Result<SessionBackend, anyhow::Error>;
}

/// Per-session relay endpoints a daemon launch exports to the daemon.
#[derive(Default, Clone)]
pub struct LaunchExtras {
    /// The per-session ssh-agent relay endpoint, so the daemon's core SSH
    /// agent-forwarding bridge reaches the desktop's agent instead of the agent
    /// host's own agent — as `SSH_AUTH_SOCK` for the unix relay socket (#1727)
    /// or the dedicated pipe-name variable for the Windows relay pipe (#2038).
    pub ssh_auth_sock: Option<String>,
    /// The per-session keyboard-interactive prompt relay (#3375): its endpoint
    /// is exported as [`KI_PROMPT_ENDPOINT_ENV`], and its activity tracker keeps
    /// the launch's connect wait from timing out while the user answers a
    /// one-time-code prompt.
    pub ki_prompt: Option<KiPromptLaunch>,
}

/// The keyboard-interactive relay half of [`LaunchExtras`].
#[derive(Clone)]
pub struct KiPromptLaunch {
    pub endpoint: String,
    pub activity: Arc<PromptActivity>,
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

/// Build the `termihub-agent --daemon <id>` command, minus the connection
/// settings.
///
/// The settings JSON is deliberately **not** placed in the environment — it
/// carries resolved plaintext secrets and is handed to the daemon over stdin
/// instead (AGT-021), so the child's stdin is configured as a pipe here. Only
/// the non-secret coordinates (endpoint, type id, buffer size, and the
/// agent-forwarding relay endpoint) travel via env vars.
fn build_daemon_command(
    agent_exe: &std::path::Path,
    session_id: &str,
    type_id: &str,
    endpoint: &str,
    buffer_size_bytes: usize,
    ssh_auth_sock: Option<&str>,
    ki_prompt_endpoint: Option<&str>,
) -> std::process::Command {
    let mut command = std::process::Command::new(agent_exe);
    command
        .arg("--daemon")
        .arg(session_id)
        .env("TERMIHUB_SOCKET_PATH", endpoint)
        .env("TERMIHUB_TYPE_ID", type_id)
        .env("TERMIHUB_BUFFER_SIZE", buffer_size_bytes.to_string())
        .stdin(std::process::Stdio::piped())
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
    // The keyboard-interactive prompt relay (#3375): a non-secret endpoint the
    // daemon's SSH auth sends OTP / 2FA rounds to. Absent → no prompter, i.e.
    // the pre-#3375 auto-answer-only behavior.
    if let Some(endpoint) = ki_prompt_endpoint {
        command.env(KI_PROMPT_ENDPOINT_ENV, endpoint);
    }
    command
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
        extras: LaunchExtras,
    ) -> Result<SessionBackend, anyhow::Error> {
        let endpoint = session_endpoint(session_id);
        let settings_json = serde_json::to_string(settings)?;
        let agent_exe = std::env::current_exe()?;

        let mut command = build_daemon_command(
            &agent_exe,
            session_id,
            type_id,
            &endpoint,
            buffer_size_bytes,
            extras.ssh_auth_sock.as_deref(),
            extras.ki_prompt.as_ref().map(|k| k.endpoint.as_str()),
        );
        crate::daemon::spawn::configure_detached_stderr(&mut command, daemon_log(session_id));
        crate::daemon::spawn::configure_detachment(&mut command);

        let mut child = command
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn daemon: {e}"))?;

        // Hand the connection settings to the daemon over its private stdin pipe
        // rather than an environment variable: the config carries resolved
        // plaintext secrets (SSH/VNC/RDP/FTP passwords, key passphrases), and an
        // env var is readable via `/proc/<pid>/environ` by the same user for the
        // daemon's whole lifetime (AGT-021). Write on a dedicated thread and let
        // the handle drop (closing the pipe → EOF): the daemon drains stdin to
        // EOF at startup, so writing off-thread avoids any deadlock even if the
        // JSON exceeds the pipe buffer while the daemon is still starting up. A
        // write failure (daemon died early) is surfaced by the connect race
        // below, not here.
        if let Some(mut stdin) = child.stdin.take() {
            std::thread::spawn(move || {
                use std::io::Write;
                let _ = stdin.write_all(settings_json.as_bytes());
            });
        }

        // The transport retries while the daemon binds its endpoint during slow
        // startup work. Race that connect against the daemon process exiting so
        // a daemon that dies before binding (e.g. its shell failed to spawn)
        // fails fast with its real exit status instead of retrying a phantom
        // "endpoint not found" for the whole connect timeout (#847).
        //
        // The daemon binds its endpoint only after its SSH connect finishes, and
        // that connect may wait on the user answering a one-time-code prompt
        // (#3375). Time spent on a prompt must not count against the connect
        // timeout (the core connect clock pauses the same way), so a timed-out
        // attempt that saw prompt activity simply waits again; a daemon that
        // gives up exits, which still fails the wait fast.
        let prompt_activity = extras.ki_prompt.as_ref().map(|k| k.activity.clone());
        let connected = loop {
            let attempt_started = std::time::Instant::now();
            let connect = DaemonClient::connect(
                session_id.to_string(),
                endpoint.clone(),
                notification_tx.clone(),
            );
            let result = connect_or_daemon_exit(session_id, connect, || match child.try_wait() {
                Ok(Some(status)) => Some(status.to_string()),
                _ => None,
            })
            .await;
            let retry = result.is_err()
                && prompt_activity
                    .as_ref()
                    .is_some_and(|a| a.active_since(attempt_started))
                && matches!(child.try_wait(), Ok(None));
            if !retry {
                break result;
            }
            debug!("Daemon for session {session_id} is waiting on a keyboard-interactive prompt; still waiting");
        };
        let client = match connected {
            Ok(client) => {
                // The daemon is detached (setsid) but not reparented to init, so
                // the worker stays its parent. Hand the child to a reaper so it
                // is `wait()`ed when it eventually exits and never lingers as a
                // zombie in a long-lived worker (AGT-018 / #2580).
                let _ = crate::daemon::spawn::reap_detached_child(child);
                client
            }
            Err(e) => {
                // Don't leave a half-started daemon orphaned when connect fails:
                // kill it AND reap it so the killed process is not left a zombie.
                let _ = child.kill();
                let _ = crate::daemon::spawn::reap_detached_child(child);
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

/// Default persistent session ring-buffer size (1 MiB); derived from the shared
/// core [`DEFAULT_BUFFER_CAPACITY`] so there is one source of truth (DUP-006).
const DEFAULT_PERSISTENT_BUFFER_SIZE: usize = DEFAULT_BUFFER_CAPACITY;

/// Error returned for input/resize on a session another desktop took over
/// (SM-003, single-attach) until the user explicitly reclaims it.
pub const SESSION_TAKEN_OVER: &str = "Session was taken over by another desktop";

/// Error returned by a plain `connection.attach` of a session another desktop
/// currently holds (#3369). Only an explicit takeover may evict that desktop.
pub const SESSION_HELD_BY_OTHER: &str = "Session is held by another desktop";

/// How often a plain (non-takeover) adoption retries a recovery connect that was
/// refused as "held by a live peer" before giving up (#3369). Another worker's
/// ownership probe ([`DaemonClient::probe_holder`]) briefly holds the daemon for
/// a few milliseconds, so a single refusal is not proof another desktop owns it.
const ADOPT_PEER_RETRIES: u32 = 3;

/// Delay between the [`ADOPT_PEER_RETRIES`] attempts.
const ADOPT_PEER_RETRY_DELAY: Duration = Duration::from_millis(150);

/// The shared per-user `state.json` path.
#[cfg(not(test))]
fn default_state_path() -> PathBuf {
    AgentState::default_path()
}

/// Under test, every manager built without an explicit state path gets its own
/// throwaway `state.json`: since #3369 listing reads and probes the shared state,
/// so tests must never see (or reclaim entries in) the developer's real one.
#[cfg(test)]
fn default_state_path() -> PathBuf {
    std::env::temp_dir()
        .join(format!("termihub-agent-test-{}", uuid::Uuid::new_v4()))
        .join("state.json")
}

/// In-memory session manager.
///
/// Tracks sessions in a `HashMap` protected by a `tokio::sync::Mutex`
/// so it can be shared across async tasks.
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionInfo>>,
    /// IDs of in-flight [`create`](SessionManager::create) calls that have
    /// reserved a slot but not yet finished their (possibly slow) backend
    /// bring-up.
    ///
    /// The expensive daemon-spawn / SSH-connect in `create` runs **without**
    /// holding the `sessions` lock (CONC-004), so it can't freeze I/O for other
    /// live sessions. To keep [`MAX_SESSIONS`] honest while a connect is in
    /// flight, each create reserves its id here (checked against `sessions.len()`
    /// under the `sessions` lock) and removes it once the session is registered
    /// or the create fails. Lock order is always `sessions → pending_creates`.
    pending_creates: Mutex<HashSet<String>>,
    /// Orphaned daemon sessions start-up recovery found running with no holder
    /// and deliberately left **unattached** (#3369): nobody owns them until a
    /// desktop explicitly opens or takes one over. They are not in `sessions`,
    /// but still count as active for the deferred self-update idle check, exactly
    /// as they did when recovery adopted them.
    unattached: Mutex<HashSet<String>>,
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
    /// Routes SSH keyboard-interactive prompts of daemon-backed sessions to the
    /// attached desktop (#3375). The process-wide hub in production; a private
    /// one in unit tests.
    ki_hub: Arc<KiPromptHub>,
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
            default_state_path(),
            Arc::new(SystemUpdateApplier),
        )
        .with_ki_prompt_hub(KiPromptHub::global())
    }

    /// Route daemon sessions' SSH keyboard-interactive prompts through `hub`
    /// (#3375). Production uses the process-wide hub; tests inject their own.
    pub fn with_ki_prompt_hub(mut self, hub: Arc<KiPromptHub>) -> Self {
        self.ki_hub = hub;
        self
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
            default_state_path(),
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
            // Reaching here means this process is the freshly re-execed new
            // binary, so the self-update backup (the previous binary, kept in
            // case the re-exec failed) is no longer needed — remove it (AGT-006).
            // A successful re-exec never returns, so this is the only place the
            // new agent can clean up its predecessor's backup.
            if let Some(exe) = current_exe.as_deref() {
                cleanup_stale_update_backup(exe);
            }
            // Persist the prune under the cross-process lock, re-pruning the
            // freshly read on-disk copy so a peer worker's concurrent write is
            // merged rather than clobbered (AGT-016).
            state = AgentState::mutate_locked(&state_path, |s| {
                prune_applied_pending_update(s, env!("CARGO_PKG_VERSION"), current_exe.as_deref());
            });
        }
        let agent_forward = AgentForwardRelay::new(notification_tx.clone());
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending_creates: Mutex::new(HashSet::new()),
            unattached: Mutex::new(HashSet::new()),
            notification_tx,
            registry,
            launcher,
            state: Mutex::new(state),
            state_path,
            update_applier,
            persistent_buffer_size: Arc::new(AtomicUsize::new(DEFAULT_PERSISTENT_BUFFER_SIZE)),
            agent_forward,
            ki_hub: KiPromptHub::new(),
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
        // Check the type exists and get capabilities up front — cheap, in-memory,
        // and done before any lock so an invalid type never reserves a slot.
        let capabilities = {
            let instance = self
                .registry
                .create(type_id)
                .map_err(|e| SessionCreateError::InvalidConfig(e.to_string()))?;
            instance.capabilities()
        };

        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();

        // Reserve a slot: enforce MAX_SESSIONS across live sessions *and* in-flight
        // creates, then release the lock. The reservation counts toward the cap so
        // concurrent creates can't overshoot it, and holding the lock only for this
        // O(1) check means the slow backend bring-up below runs without gating I/O
        // for every other session (CONC-004). Lock order: `sessions → pending_creates`.
        {
            let sessions = self.sessions.lock().await;
            let mut pending = self.pending_creates.lock().await;
            if sessions.len() + pending.len() >= MAX_SESSIONS as usize {
                return Err(SessionCreateError::LimitReached);
            }
            pending.insert(id.clone());
        }

        // Run the (possibly multi-second) daemon spawn + connect / SSH handshake
        // WITHOUT holding `sessions`, so one slow or hung connect can't freeze
        // write_input/resize/list/close for every other live session (CONC-004).
        let backend = match self
            .create_backend(&id, type_id, &settings, capabilities.persistent)
            .await
        {
            Ok(backend) => backend,
            Err(e) => {
                // Release the reservation so a failed create never leaks a slot
                // or blocks a retry.
                self.pending_creates.lock().await.remove(&id);
                return Err(SessionCreateError::from_backend(e));
            }
        };

        let info = SessionInfo {
            id: id.clone(),
            title: title.clone(),
            type_id: type_id.to_string(),
            status: SessionStatus::Running,
            settings: settings.clone(),
            created_at: now,
            last_activity: now,
            attached: false,
            backend,
            definition_id: definition_id.clone(),
        };

        let snapshot = info.snapshot();

        // Re-acquire `sessions` briefly to register the finished session, persist
        // daemon-backed sessions for recovery, and drop the reservation. Keeping the
        // state-persist nested under the `sessions` lock preserves the original
        // atomicity vs. `recover_sessions` (which inserts under the same lock).
        {
            let mut sessions = self.sessions.lock().await;

            if capabilities.persistent {
                if let SessionBackend::Daemon(ref client) = info.backend {
                    let persisted = PersistedSession {
                        type_id: type_id.to_string(),
                        title,
                        created_at: now.to_rfc3339(),
                        daemon_socket: Some(client.endpoint().to_string()),
                        // Strip plaintext secrets before they reach state.json:
                        // the daemon already holds the live settings (handed over
                        // stdin) and recovery reattaches over the socket, so the
                        // on-disk copy never needs the secret values (AGT-021).
                        settings: crate::state::persistence::redact_persisted_secrets(&settings),
                        definition_id,
                    };
                    let id_for_state = id.clone();
                    // Persist the insert under the cross-process lock so a peer
                    // worker's concurrent state write is merged, not clobbered
                    // (AGT-016).
                    self.persist_state_delta(move |s| {
                        s.sessions.insert(id_for_state, persisted);
                    })
                    .await;
                }
            }

            self.pending_creates.lock().await.remove(&id);
            sessions.insert(id, info);
        }

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

        // Relay the daemon's SSH keyboard-interactive (OTP / 2FA) prompts to the
        // desktop when it can show them (#3375). Held only for the launch: the
        // daemon's SSH auth is over once it accepts connections.
        let ki_relay = self.start_ki_relay(session_id, type_id).await;

        let mut result = self
            .launcher
            .launch(
                session_id,
                type_id,
                settings,
                self.notification_tx.clone(),
                buffer_size,
                LaunchExtras {
                    ssh_auth_sock: ssh_auth_sock.clone(),
                    ki_prompt: ki_relay.as_ref().map(|r| KiPromptLaunch {
                        endpoint: r.endpoint().to_string(),
                        activity: r.activity(),
                    }),
                },
            )
            .await;

        // A cancelled prompt or a rejected one-time code must reach the desktop
        // typed, not as an opaque "daemon exited" (#3375).
        if result.is_err() {
            if let Some(kind) = ki_relay.as_ref().and_then(|r| r.failure()) {
                result = Err(anyhow::Error::new(KiConnectFailure(kind)));
            }
        }
        drop(ki_relay);

        // Install the natural-exit deferred-update hook on the daemon client so a
        // self-terminating daemon-backed session promptly applies a staged
        // self-update, mirroring the in-process output-forwarder path (#2381).
        if let Ok(SessionBackend::Daemon(ref client)) = result {
            if let Some(hook) = self.deferred_update_exit_hook() {
                client.set_exit_hook(hook);
            }
        }

        // A daemon that never launched leaves no one to talk to the relay, so
        // don't leave the socket dangling.
        if result.is_err() && ssh_auth_sock.is_some() {
            self.agent_forward.stop_listener(session_id).await;
        }
        result
    }

    /// Start the keyboard-interactive prompt relay for an SSH session daemon
    /// when a prompt-capable desktop is attached (#3375). `None` keeps the
    /// daemon on the auto-answer-only behavior.
    async fn start_ki_relay(&self, session_id: &str, type_id: &str) -> Option<KiRelaySession> {
        if type_id != "ssh" || !self.ki_hub.is_available() {
            return None;
        }
        let endpoint = crate::daemon::transport::ki_prompt_endpoint(session_id);
        match KiRelaySession::start(self.ki_hub.clone(), session_id, endpoint).await {
            Ok(relay) => Some(relay),
            Err(e) => {
                warn!("failed to start keyboard-interactive prompt relay for {session_id}: {e}");
                None
            }
        }
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

        connection.connect(settings.clone()).await.map_err(|e| {
            // Keep a cancelled prompt / rejected one-time code typed (#3375).
            match KiFailureKind::from_session_error(&e) {
                Some(kind) => anyhow::Error::new(KiConnectFailure(kind)),
                None => anyhow::anyhow!("Connection failed: {e}"),
            }
        })?;

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
    ///
    /// Also includes orphaned daemon sessions that run **unattached** on this host
    /// (no worker holds them, #3369) as `attached: false` entries, so a returning
    /// desktop's post-reconnect check still finds the session its tab refers to
    /// and re-attaches it (which adopts it — see [`attach`](Self::attach)).
    /// Sessions another desktop holds are not listed here; see
    /// [`list_host`](Self::list_host).
    pub async fn list(&self) -> Vec<SessionSnapshot> {
        let mut out: Vec<SessionSnapshot> = {
            let mut sessions = self.sessions.lock().await;
            settle_exited(&mut sessions);
            sessions.values().map(|s| s.snapshot()).collect()
        };
        out.extend(
            self.foreign_host_sessions()
                .await
                .into_iter()
                .filter(|h| h.holder == SessionHolder::Nobody)
                .map(|h| h.snapshot),
        );
        out
    }

    /// List every session running on this host for this user with who controls
    /// it (#3369): sessions this worker holds (`Me`), ones running unattached
    /// (`Nobody`) and ones another desktop's worker holds (`Other`).
    ///
    /// Sessions not held by this worker are classified with a short ownership
    /// probe ([`DaemonClient::probe_holder`]); dead daemons found on the way are
    /// reclaimed exactly like start-up recovery does (AGT-019).
    pub async fn list_host(&self) -> Vec<HostSessionSnapshot> {
        // Snapshot this worker's map without holding the lock across a probe.
        let (mut out, to_probe) = {
            let mut sessions = self.sessions.lock().await;
            settle_exited(&mut sessions);
            let mut out = Vec::new();
            let mut to_probe = Vec::new();
            for info in sessions.values() {
                let snapshot = info.snapshot();
                match &info.backend {
                    SessionBackend::Daemon(client) if client.is_evicted() => {
                        out.push(HostSessionSnapshot {
                            snapshot,
                            holder: SessionHolder::Other,
                        });
                    }
                    SessionBackend::Daemon(client)
                        if !info.attached && info.status == SessionStatus::Running =>
                    {
                        // Detached by this desktop: another worker may have
                        // adopted it since — ask the daemon.
                        to_probe.push((snapshot, client.endpoint().to_string()));
                    }
                    _ => out.push(HostSessionSnapshot {
                        holder: if info.attached {
                            SessionHolder::Me
                        } else {
                            SessionHolder::Nobody
                        },
                        snapshot,
                    }),
                }
            }
            (out, to_probe)
        };
        for (snapshot, endpoint) in to_probe {
            let holder = match DaemonClient::probe_holder(&snapshot.id, &endpoint).await {
                Ok(ProbeOutcome::HeldByPeer) => SessionHolder::Other,
                _ => SessionHolder::Nobody,
            };
            out.push(HostSessionSnapshot { snapshot, holder });
        }
        out.extend(self.foreign_host_sessions().await);
        out
    }

    /// The persisted daemon sessions this worker does **not** hold, classified by
    /// an ownership probe as `Nobody` (running unattached) or `Other` (held by
    /// another desktop's worker). Dead entries are reclaimed and omitted.
    ///
    /// Reads the shared `state.json` fresh from disk so sessions another desktop
    /// created after this worker started are included.
    async fn foreign_host_sessions(&self) -> Vec<HostSessionSnapshot> {
        let persisted = self.fresh_persisted_sessions().await;
        let held: HashSet<String> = self.sessions.lock().await.keys().cloned().collect();
        let mut out = Vec::new();
        for (id, session) in persisted {
            if held.contains(&id) {
                continue;
            }
            let Some(holder) = self.classify_persisted(&id, &session).await else {
                continue;
            };
            out.push(HostSessionSnapshot {
                snapshot: persisted_snapshot(&id, &session),
                holder,
            });
        }
        out
    }

    /// Classify a persisted session this worker does not hold (#3369). Returns
    /// `None` — after reclaiming its files and state entry (AGT-019) — when the
    /// daemon is gone.
    async fn classify_persisted(
        &self,
        id: &str,
        session: &PersistedSession,
    ) -> Option<SessionHolder> {
        let Some(endpoint) = session
            .daemon_socket
            .as_deref()
            .filter(|e| endpoint_alive(e))
        else {
            self.forget_dead_session(id).await;
            return None;
        };
        match DaemonClient::probe_holder(id, endpoint).await {
            Ok(ProbeOutcome::Free) => Some(SessionHolder::Nobody),
            Ok(ProbeOutcome::HeldByPeer) => Some(SessionHolder::Other),
            Err(e) => {
                warn!("Session {id} daemon is not answering ({e}); reclaiming it");
                self.forget_dead_session(id).await;
                None
            }
        }
    }

    /// Reclaim a dead persisted session: its socket/relay/log files and its
    /// shared `state.json` entry (AGT-019).
    async fn forget_dead_session(&self, id: &str) {
        remove_session_files(id);
        self.unattached.lock().await.remove(id);
        self.persist_state_delta(|s| {
            s.sessions.remove(id);
        })
        .await;
    }

    /// The persisted sessions in the shared per-user `state.json`, read fresh
    /// from disk (writes are atomic, so a plain read never sees a torn file).
    async fn fresh_persisted_sessions(&self) -> HashMap<String, PersistedSession> {
        let path = self.state_path.clone();
        match tokio::task::spawn_blocking(move || AgentState::load_from(&path)).await {
            Ok(state) => state.sessions,
            Err(_) => self.state.lock().await.sessions.clone(),
        }
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
    ///
    /// A session running unattached on this host (not held by this worker,
    /// #3369) is adopted first so it can be killed; one another desktop holds is
    /// left alone (reported as not found).
    pub async fn close(&self, session_id: &str) -> bool {
        let held = self.sessions.lock().await.contains_key(session_id);
        if !held && self.adopt_persisted(session_id, false).await.is_err() {
            return false;
        }
        {
            let mut sessions = self.sessions.lock().await;
            match sessions.remove(session_id) {
                Some(mut info) => close_backend(&mut info.backend).await,
                None => return false,
            }
        }

        // Tear down any ssh-agent relay this session held (#1727).
        self.agent_forward.stop_listener(session_id).await;

        self.persist_state_delta(|s| {
            s.sessions.remove(session_id);
        })
        .await;

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
        } && self.live_unattached_count().await == 0;
        if idle {
            if let Err(e) = self.apply_pending_update().await {
                warn!("Deferred agent update failed to apply on last disconnect: {e:#}");
            }
        }
    }

    /// Build the natural-exit hook a daemon-backed session installs on its
    /// [`DaemonClient`].
    ///
    /// When the daemon reports its backend exited on its own (`MSG_EXITED`/EOF),
    /// the client runs this hook, which reaches back through the [`Weak`] self
    /// reference and runs the shared [`apply_deferred_update_if_idle`] helper —
    /// so a naturally-exiting last daemon-backed session promptly applies a
    /// staged self-update, matching the in-process output-forwarder path
    /// (#2378/#2381).
    ///
    /// Returns `None` when the manager was not wrapped through
    /// [`into_arc`](Self::into_arc) (e.g. some unit tests); the daemon client
    /// then installs no hook and read-path reconciliation still settles the
    /// session — exactly as the in-process forwarder skips its hook on an empty
    /// [`Weak`].
    fn deferred_update_exit_hook(&self) -> Option<ExitHook> {
        let weak = self.self_ref.get().cloned()?;
        Some(Arc::new(move || {
            let weak = weak.clone();
            Box::pin(async move {
                if let Some(manager) = weak.upgrade() {
                    manager.apply_deferred_update_if_idle().await;
                }
            }) as ExitHookFuture
        }))
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
    ///
    /// **A plain attach never evicts another desktop** (SM-003, single-attach —
    /// taking over is always an explicit, user-confirmed action):
    ///
    /// - A session this worker does not hold yet — an orphan left running
    ///   unattached by start-up recovery, or one another desktop detached from —
    ///   is adopted from the shared `state.json` (#3369) with a recovery-intent
    ///   connect.
    /// - A session still in this worker's map (e.g. detached when its tab closed,
    ///   or evicted by another desktop's takeover) is re-attached with a
    ///   recovery-intent reconnect too (#3395). Previously this reconnected with
    ///   takeover intent and silently evicted a desktop that had opened the
    ///   session in the meantime.
    ///
    /// Either way, if another desktop holds the session the attach fails with
    /// [`SESSION_HELD_BY_OTHER`] and the desktop is told via `connection.evicted`
    /// (`heldByPeer`) so a tab bound to it folds `Evicted` (with Reclaim / Take
    /// over); the holder is left undisturbed.
    pub async fn attach(&self, session_id: &str) -> Result<(), String> {
        if !self.sessions.lock().await.contains_key(session_id) {
            return self.adopt_persisted(session_id, false).await;
        }
        self.reattach_held(session_id, false).await
    }

    /// Explicit **Reclaim** (SM-003, single-attach): take control of a session
    /// back from whichever worker (another desktop) currently holds it.
    ///
    /// - Held by this worker (e.g. it was evicted by a takeover and is still in the
    ///   map): the daemon client reconnects with **takeover** intent, evicting the
    ///   other worker, which receives `connection.evicted` in turn.
    /// - Not held by this worker (its start-up recovery was refused because a
    ///   live peer owned it, AGT-015): adopt it from the shared per-user
    ///   `state.json` with a **takeover** connect and register it here.
    ///
    /// Never called automatically — only on an explicit user Reclaim / Take over
    /// (`connection.attach { takeover: true }`), so control cannot ping-pong
    /// between two desktops.
    pub async fn reclaim(&self, session_id: &str) -> Result<(), String> {
        if self.sessions.lock().await.contains_key(session_id) {
            return self.reattach_held(session_id, true).await;
        }
        self.adopt_persisted(session_id, true).await
    }

    /// Re-attach a session already in this worker's map.
    ///
    /// `takeover == false` (plain attach): a recovery-intent reconnect, refused
    /// while another desktop holds the session — reported as
    /// [`SESSION_HELD_BY_OTHER`] plus a `heldByPeer` eviction notice, leaving the
    /// holder undisturbed (#3395). `takeover == true` (explicit Reclaim only): a
    /// takeover reconnect that evicts the holder.
    async fn reattach_held(&self, session_id: &str, takeover: bool) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let info = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        if info.status != SessionStatus::Running {
            return Err("Session not running".to_string());
        }

        info.last_activity = Utc::now();
        match attach_backend(&mut info.backend, takeover).await {
            Ok(()) => {
                info.attached = true;
                Ok(())
            }
            Err(e) if e.downcast_ref::<OwnedByLivePeer>().is_some() => {
                info.attached = false;
                drop(sessions);
                info!(
                    "Plain attach of session {session_id} refused: another desktop holds it \
                     (explicit takeover required, #3395)"
                );
                // SM-003: a tab bound to this session folds `Evicted` (with
                // Reclaim) instead of an unexplained failure.
                let _ = self.notification_tx.send(evicted_notification(
                    session_id,
                    EVICTED_REASON_HELD_BY_PEER,
                ));
                Err(SESSION_HELD_BY_OTHER.to_string())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    /// Adopt a daemon session this worker does not hold from the shared
    /// per-user `state.json` and register it here, attached (#3369).
    ///
    /// - `takeover == true` (explicit Take over / Reclaim, SM-003): a takeover
    ///   connect; the daemon evicts whichever worker holds it, which is notified
    ///   with `connection.evicted` in turn.
    /// - `takeover == false` (plain open / re-attach): a recovery-intent connect
    ///   that the daemon refuses while another live worker holds the session
    ///   (AGT-015). A refusal is retried briefly — another worker's ownership
    ///   probe holds the daemon for a moment — then reported as
    ///   [`SESSION_HELD_BY_OTHER`] together with a `heldByPeer` eviction notice.
    async fn adopt_persisted(&self, session_id: &str, takeover: bool) -> Result<(), String> {
        let persisted = match self.fresh_persisted_sessions().await.remove(session_id) {
            Some(p) => p,
            None => self
                .state
                .lock()
                .await
                .sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| "Session not found".to_string())?,
        };
        let endpoint = persisted
            .daemon_socket
            .clone()
            .ok_or_else(|| "Session not found".to_string())?;
        if !endpoint_alive(&endpoint) {
            return Err("Session not found".to_string());
        }

        let client = if takeover {
            // A takeover connect (not the recovery intent): the daemon evicts the
            // worker that currently holds the session.
            DaemonClient::connect(
                session_id.to_string(),
                endpoint,
                self.notification_tx.clone(),
            )
            .await
            .map_err(|e| e.to_string())?
        } else {
            self.connect_unless_held(session_id, &endpoint).await?
        };
        if let Some(hook) = self.deferred_update_exit_hook() {
            client.set_exit_hook(hook);
        }

        let created_at = chrono::DateTime::parse_from_rfc3339(&persisted.created_at)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        let info = SessionInfo {
            id: session_id.to_string(),
            title: persisted.title.clone(),
            type_id: persisted.type_id.clone(),
            status: SessionStatus::Running,
            settings: persisted.settings.clone(),
            created_at,
            last_activity: Utc::now(),
            attached: true,
            backend: SessionBackend::Daemon(client),
            definition_id: persisted.definition_id.clone(),
        };
        let replaced = {
            let mut sessions = self.sessions.lock().await;
            // A concurrent adoption of the same id may have registered it
            // meanwhile. This connect is the later one (current on the daemon), so
            // it replaces that entry.
            sessions.insert(session_id.to_string(), info)
        };
        if let Some(mut old) = replaced {
            // Stop the superseded connection's reader; the daemon already moved on.
            detach_backend(&mut old.backend).await;
        }
        self.unattached.lock().await.remove(session_id);
        if takeover {
            info!("Took over session {session_id} from another connection (SM-003)");
        } else {
            info!("Adopted unattached session {session_id} (#3369)");
        }
        Ok(())
    }

    /// Recovery-intent connect for a plain adoption, retrying a transient
    /// "held by a live peer" refusal (see [`ADOPT_PEER_RETRIES`]).
    async fn connect_unless_held(
        &self,
        session_id: &str,
        endpoint: &str,
    ) -> Result<DaemonClient, String> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            match DaemonClient::connect_for_recovery(
                session_id.to_string(),
                endpoint.to_string(),
                self.notification_tx.clone(),
            )
            .await
            {
                Ok(client) => return Ok(client),
                Err(e) if e.downcast_ref::<OwnedByLivePeer>().is_some() => {
                    if attempt < ADOPT_PEER_RETRIES {
                        tokio::time::sleep(ADOPT_PEER_RETRY_DELAY).await;
                        continue;
                    }
                    // SM-003: a tab bound to this session folds `Evicted` (with
                    // Take over) instead of an unexplained failure.
                    let _ = self.notification_tx.send(evicted_notification(
                        session_id,
                        EVICTED_REASON_HELD_BY_PEER,
                    ));
                    return Err(SESSION_HELD_BY_OTHER.to_string());
                }
                Err(e) => return Err(e.to_string()),
            }
        }
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

    /// Start-up recovery: reconcile the shared `state.json` with the daemons
    /// still running on this host.
    ///
    /// **Tab-less recovery policy (#3369, maintainer decision 2026-09-26):** a
    /// worker no longer adopts orphaned sessions. A surviving daemon that nobody
    /// holds is left running **unattached** — it keeps running under its usual
    /// lifetime/exit rules, is listed (`connection.list` /
    /// `connection.list_host_sessions`) and is adopted only when a desktop
    /// actually attaches to it (a returning desktop re-attaching its tab, or a
    /// user opening / taking it over). Previously every worker adopted every
    /// orphan, so desktop B silently became the owner of desktop A's session
    /// while A was offline.
    ///
    /// Each surviving daemon is classified with an ownership probe:
    /// - free → left unattached (returned);
    /// - held by a live peer (AGT-015) → left alone and reported to the desktop
    ///   as `connection.evicted` (`heldByPeer`, SM-003) so a tab bound to it folds
    ///   `Evicted` rather than "session lost";
    /// - dead (missing endpoint, or a socket file that merely lingers) → its
    ///   files and state entry are reclaimed (AGT-019).
    ///
    /// Returns the ids of the sessions left running unattached.
    pub async fn recover_sessions(&self) -> Vec<String> {
        let persisted = self.state.lock().await.sessions.clone();

        let mut unattached = Vec::new();

        for (id, session) in &persisted {
            match self.classify_persisted(id, session).await {
                Some(SessionHolder::Nobody) => {
                    info!(
                        "Session {id} (type={}) is running unattached; leaving it for a \
                         desktop to open (#3369)",
                        session.type_id
                    );
                    unattached.push(id.clone());
                }
                Some(_) => {
                    // AGT-015: another live worker (another attached desktop) still
                    // owns this session. Leave it — and its shared `state.json`
                    // entry — for its live owner.
                    info!(
                        "Session {id} is held by a live connection on this host; \
                         leaving it for its owner (AGT-015)"
                    );
                    // SM-003: tell the desktop the session is controlled elsewhere
                    // so a tab that was attached to it folds an explicit `Evicted`
                    // state (with Reclaim) rather than "session lost". A desktop
                    // with no tab for this session ignores it.
                    let _ = self
                        .notification_tx
                        .send(evicted_notification(id, EVICTED_REASON_HELD_BY_PEER));
                }
                None => {
                    info!("Session {id} is gone; reclaimed its state and files");
                }
            }
        }

        if !unattached.is_empty() {
            info!(
                "{} orphaned session(s) left running unattached",
                unattached.len()
            );
            self.unattached
                .lock()
                .await
                .extend(unattached.iter().cloned());
        }

        unattached
    }

    /// Return the number of sessions with status `Running`.
    ///
    /// Sessions whose backend has exited on its own are settled to
    /// [`SessionStatus::Exited`] first, so a naturally dead session is not
    /// counted as active (#2369) — this keeps the deferred-update "is idle"
    /// check and any leak detection honest.
    ///
    /// Orphans start-up recovery left running unattached (#3369) whose daemon is
    /// still up also count, exactly as they did when recovery adopted them — so a
    /// staged self-update keeps deferring while they run.
    pub async fn active_count(&self) -> u32 {
        let held = {
            let mut sessions = self.sessions.lock().await;
            settle_exited(&mut sessions);
            sessions
                .values()
                .filter(|s| s.status == SessionStatus::Running)
                .count() as u32
        };
        held + self.live_unattached_count().await
    }

    /// Number of recovery-found unattached orphans (#3369) whose daemon endpoint
    /// is still present and that this worker has not since adopted.
    async fn live_unattached_count(&self) -> u32 {
        let ids: Vec<String> = self.unattached.lock().await.iter().cloned().collect();
        if ids.is_empty() {
            return 0;
        }
        let held: HashSet<String> = self.sessions.lock().await.keys().cloned().collect();
        let state = self.state.lock().await;
        ids.iter()
            .filter(|id| !held.contains(*id))
            .filter(|id| {
                state
                    .sessions
                    .get(*id)
                    .and_then(|p| p.daemon_socket.as_deref())
                    .is_some_and(endpoint_alive)
            })
            .count() as u32
    }

    /// The agent-owned staging locations a caller-supplied update `binaryPath`
    /// may legitimately live in (AGT-003).
    ///
    /// Derived from the agent state dir so it is `<config>/updates` in production
    /// — matching the self-update download dir — and the per-test temp dir under
    /// test. On Unix the fixed desktop coordinated-push upload path is trusted
    /// alongside it (the desktop uploads a staged binary there over its
    /// authenticated SFTP channel before calling `agent.request_update`).
    fn trusted_staging_roots(&self) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if let Some(parent) = self.state_path.parent() {
            roots.push(parent.join("updates"));
        }
        #[cfg(unix)]
        roots.push(PathBuf::from(crate::update::POSIX_COORDINATED_UPLOAD_PATH));
        roots
    }

    /// Record a deferred agent update and apply it immediately if the agent is
    /// already idle (#1352).
    ///
    /// When `binary_path` is `Some`, that binary is staged as the pending update
    /// (persisted to `state.json`) with the caller-supplied `expected_sha256`,
    /// which the apply path re-verifies against before the swap (AGT-004). When
    /// it is `None`, the already-staged pending update — with the digest it was
    /// staged with — is used; this is the "Apply Now" path for a self-update
    /// binary the agent downloaded earlier (`expected_sha256` is ignored there).
    ///
    /// `signature` is the detached Ed25519 signature over `expected_sha256`
    /// (AGT-005, #3213). A caller-supplied binary's signature is checked
    /// **before** it is staged, so a refused update is reported immediately
    /// rather than persisted as a deferred update that could never apply; the
    /// apply path verifies it again immediately before the swap.
    ///
    /// The update is applied immediately **only** when there are zero active
    /// sessions; otherwise it is deferred until the last session disconnects
    /// (see [`SessionManager::close`]). Active sessions are never interrupted.
    pub async fn request_deferred_update(
        &self,
        binary_path: Option<String>,
        version: Option<String>,
        expected_sha256: Option<String>,
        signature: Option<String>,
    ) -> Result<DeferredUpdateOutcome, DeferredUpdateError> {
        // Stage a caller-supplied binary, or fall back to an existing pending
        // update.
        if let Some(path) = binary_path {
            // AGT-003: confine the caller-supplied path to the agent-owned
            // staging locations before it can ever be staged/applied. An
            // arbitrary readable path must not become the new agent binary.
            // Fails closed — a rejection returns before anything is persisted.
            let confined = confine_to_staging(&self.trusted_staging_roots(), Path::new(&path))
                .map_err(map_confinement_error)?;
            // AGT-005: refuse an unsigned / badly signed update up front, before
            // it is persisted. (A missing digest is left to the apply path's
            // AGT-004 fail-closed check.)
            if let Some(digest) = expected_sha256.as_deref() {
                self.update_applier
                    .check_signature(digest, signature.as_deref())
                    .map_err(DeferredUpdateError::SignatureRejected)?;
            }
            let pending = PendingUpdate {
                version: version.unwrap_or_default(),
                binary_path: confined.to_string_lossy().into_owned(),
                staged_at: Utc::now().to_rfc3339(),
                // AGT-004: carry the initiator's expected digest so the apply
                // path can re-verify the staged bytes before the swap. A missing
                // digest here is persisted as `None` and fails closed at apply.
                expected_sha256,
                // AGT-005: carried so the apply path re-verifies it before the
                // swap (a deferred apply may run much later).
                signature,
            };
            self.persist_state_delta(move |s| {
                s.update.pending_update = Some(pending);
            })
            .await;
        }

        let has_pending = self.state.lock().await.update.pending_update.is_some();
        if !has_pending {
            return Err(DeferredUpdateError::NoPendingUpdate);
        }

        let active = self.active_count().await;
        if should_apply_deferred_update(active, true) {
            self.apply_pending_update().await.map_err(map_apply_error)?;
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
        self.persist_state_delta(move |s| {
            s.update.last_check_time = Some(timestamp);
        })
        .await;
    }

    /// Record a staged pending update in the shared agent state **without**
    /// applying it (#1401).
    ///
    /// Used by the self-update timer when the connection's update strategy does
    /// not auto-apply on idle (coordinated), so a later coordinated apply — or
    /// an explicit `agent.request_deferred_update` — can consume it.
    ///
    /// `expected_sha256` is the digest the download path verified the binary
    /// against; it is recorded so the eventual apply re-verifies the staged
    /// bytes before the swap (AGT-004). `signature` is the downloaded `.sig`
    /// sidecar, re-verified at apply time (AGT-005).
    pub async fn stage_pending_update(
        &self,
        binary_path: String,
        version: String,
        expected_sha256: Option<String>,
        signature: Option<String>,
    ) {
        let pending = PendingUpdate {
            version,
            binary_path,
            staged_at: Utc::now().to_rfc3339(),
            expected_sha256,
            signature,
        };
        self.persist_state_delta(move |s| {
            s.update.pending_update = Some(pending);
        })
        .await;
    }

    /// Persist a mutation to the shared `state.json` under the cross-process
    /// advisory lock, then refresh the in-memory copy to the merged on-disk
    /// truth (AGT-016).
    ///
    /// The lock + re-read + atomic write closes the multi-worker lost-update
    /// window: a peer worker's concurrent insert/remove is merged in rather than
    /// clobbered by this worker's stale whole-struct save. The in-memory `state`
    /// mutex is held only for the (fast, blocking) file operation, and no file
    /// lock is ever nested within another, so no cross-worker deadlock is
    /// possible — the file lock is the only cross-process resource and a peer
    /// waiting on it never also needs this worker's in-memory mutex.
    async fn persist_state_delta(&self, delta: impl FnOnce(&mut AgentState)) {
        let mut state = self.state.lock().await;
        *state = AgentState::mutate_locked(&self.state_path, delta);
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
        self.persist_state_delta(|s| {
            s.update.pending_update = None;
        })
        .await;
        Ok(())
    }
}

/// A [`SessionSnapshot`] for a persisted session this worker does not hold
/// (#3369). `state.json` records no activity time, so `last_activity` is the
/// creation time.
fn persisted_snapshot(id: &str, session: &PersistedSession) -> SessionSnapshot {
    let created_at = chrono::DateTime::parse_from_rfc3339(&session.created_at)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    SessionSnapshot {
        id: id.to_string(),
        title: session.title.clone(),
        type_id: session.type_id.clone(),
        status: SessionStatus::Running,
        created_at,
        last_activity: created_at,
        attached: false,
        definition_id: session.definition_id.clone(),
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

/// Re-attach `backend`. A daemon session reconnects with takeover intent only
/// when `takeover` is set (explicit Reclaim); otherwise it is a plain,
/// never-evicting re-attach (#3395).
async fn attach_backend(backend: &mut SessionBackend, takeover: bool) -> Result<(), anyhow::Error> {
    match backend {
        SessionBackend::Daemon(ref mut client) => {
            if takeover {
                client.take_over().await?;
            } else {
                client.attach().await?;
            }
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
    // The mechanical recv→send_output loop now lives in the shared core pump
    // (finding DUP-011). The agent forwards each received chunk as its own
    // `connection.output` notification, so `coalesce: false` keeps exactly one
    // `send_output` per received chunk — the on-wire framing must mirror the
    // chunk boundaries (`JsonRpcOutputSink` re-chunks at 64 KiB). The agent has
    // no `ScreenClearDetector` (`wait_for_clear: false`) and no cancellation
    // token (`cancel: None`).
    let opts = PumpOptions {
        wait_for_clear: false,
        coalesce: false,
        // Ignored when `coalesce` is false; mirror the desktop batch cap.
        max_coalesce_bytes: 32 * 1024,
        // Ignored when `wait_for_clear` is false.
        clear_wait_timeout: Duration::from_secs(0),
    };
    tokio::spawn(async move {
        match run_output_pump(&session_id, &mut output_rx, &sink, None, &opts).await {
            // The output channel closed: the backend process exited / hit EOF on
            // its own. Mark the backend dead so the manager settles the session
            // to `Exited` (#2369), then notify the desktop.
            PumpEnd::Eof => {
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
            }
            // A JSON-RPC sink error means the transport loop was dropped; the
            // old loop simply returned on a send failure — no `alive` flip, no
            // exit event, no deferred-update hook. `Cancelled`/`ClearFlushSinkClosed`
            // are unreachable with `cancel: None`/`wait_for_clear: false`, but
            // share that no-settle semantics, so they fall through identically.
            PumpEnd::StreamSinkClosed | PumpEnd::Cancelled | PumpEnd::ClearFlushSinkClosed => {}
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

    async fn list_host(&self) -> Vec<HostSessionSnapshot> {
        SessionManager::list_host(self).await
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
        expected_sha256: Option<String>,
        signature: Option<String>,
    ) -> Result<DeferredUpdateOutcome, DeferredUpdateError> {
        SessionManager::request_deferred_update(
            self,
            binary_path,
            version,
            expected_sha256,
            signature,
        )
        .await
    }

    async fn attach(&self, session_id: &str) -> Result<(), String> {
        SessionManager::attach(self, session_id).await
    }

    async fn reclaim(&self, session_id: &str) -> Result<(), String> {
        SessionManager::reclaim(self, session_id).await
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
                // SM-003: never write to a session another desktop took over — its
                // control belongs to the other side until an explicit Reclaim.
                SessionBackend::Daemon(client) if client.is_evicted() => {
                    return Err(SESSION_TAKEN_OVER.to_string());
                }
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
                // SM-003: never write to a session another desktop took over — its
                // control belongs to the other side until an explicit Reclaim.
                SessionBackend::Daemon(client) if client.is_evicted() => {
                    return Err(SESSION_TAKEN_OVER.to_string());
                }
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

    /// The production (non-test) part of a Rust source file.
    fn production_source(src: &str) -> &str {
        src.split("#[cfg(test)]\nmod tests {").next().unwrap_or(src)
    }

    /// Name of the function enclosing byte offset `at` in `src`.
    fn enclosing_fn(src: &str, at: usize) -> String {
        let head = &src[..at];
        let start = head.rfind("fn ").expect("occurrence inside a function") + 3;
        head[start..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect()
    }

    /// Enclosing function names of every occurrence of `needle` in `src`.
    fn call_sites(src: &str, needle: &str) -> Vec<String> {
        src.match_indices(needle)
            .map(|(at, _)| enclosing_fn(src, at))
            .collect()
    }

    /// #3395 audit (SM-003 single-attach, maintainer decision 2026-09-26): taking
    /// over another desktop's session must always be explicit. Every path that
    /// connects to a daemon with **takeover** intent must originate from the
    /// explicit `reclaim` (`connection.attach { takeover: true }`) — or from
    /// spawning a brand-new daemon nobody else can hold yet.
    #[test]
    fn takeover_intent_originates_only_from_explicit_reclaim() {
        let manager = production_source(include_str!("manager.rs"));
        // A takeover re-attach of an in-map session: only via `attach_backend`
        // with `takeover`, which only `reclaim` requests.
        assert_eq!(call_sites(manager, ".take_over()"), vec!["attach_backend"]);
        assert_eq!(
            call_sites(manager, "reattach_held(session_id, true)"),
            vec!["reclaim"]
        );
        assert_eq!(
            call_sites(manager, "reattach_held(session_id, false)"),
            vec!["attach"]
        );
        // A takeover adoption of a session this worker does not hold: only
        // `reclaim` asks `adopt_persisted` for one.
        assert_eq!(
            call_sites(manager, "adopt_persisted(session_id, true)"),
            vec!["reclaim"]
        );
        // `DaemonClient::connect` declares takeover intent: used only to connect
        // to a daemon just spawned (`launch`) and by `adopt_persisted`'s explicit
        // takeover branch.
        assert_eq!(
            call_sites(manager, "DaemonClient::connect("),
            vec!["launch", "adopt_persisted"]
        );

        // The daemon client: a plain `attach` never declares takeover intent.
        let client = production_source(include_str!("../daemon/client.rs"));
        let plain = client
            .split("pub async fn attach(&mut self)")
            .nth(1)
            .and_then(|rest| rest.split("pub async fn take_over").next())
            .expect("DaemonClient::attach present");
        assert!(plain.contains("self.reconnect(false)"));
        assert_eq!(
            call_sites(client, "self.reconnect(true)"),
            vec!["take_over"]
        );

        // The RPC: only `takeover: true` routes to `reclaim`.
        let dispatch = production_source(include_str!("../handler/dispatch.rs"));
        assert_eq!(
            call_sites(dispatch, "session_manager.reclaim("),
            vec!["register_connection_attach"]
        );
        assert!(dispatch
            .contains("if p.takeover {\n            session_manager.reclaim(&p.session_id).await"));
    }

    /// AGT-021: the spawned daemon command must never carry the connection
    /// settings — and thus its plaintext secrets — in an environment variable
    /// (readable via `/proc/<pid>/environ`). Settings travel over stdin instead,
    /// so the built command exposes only the non-secret coordinates in its env.
    #[test]
    fn build_daemon_command_never_puts_settings_or_secrets_in_env() {
        let secret = "sup3r-s3cret-pw";
        let command = build_daemon_command(
            std::path::Path::new("/usr/bin/termihub-agent"),
            "sess-1",
            "ssh",
            "/tmp/sess-1.sock",
            65536,
            Some("/tmp/agent.sock"),
            Some("/tmp/ki.sock"),
        );
        assert!(
            command
                .get_envs()
                .any(|(k, v)| k == KI_PROMPT_ENDPOINT_ENV && v == Some("/tmp/ki.sock".as_ref())),
            "the prompt-relay endpoint is exported to the daemon (#3375)"
        );

        for (key, value) in command.get_envs() {
            assert_ne!(
                key, "TERMIHUB_SETTINGS",
                "the settings env var must be gone (AGT-021)"
            );
            if let Some(value) = value {
                assert!(
                    !value.to_string_lossy().contains(secret),
                    "no daemon env value may carry a connection secret"
                );
            }
        }

        // The non-secret coordinates are still present.
        let keys: Vec<String> = command
            .get_envs()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert!(keys.iter().any(|k| k == "TERMIHUB_SOCKET_PATH"));
        assert!(keys.iter().any(|k| k == "TERMIHUB_TYPE_ID"));
        assert!(keys.iter().any(|k| k == "TERMIHUB_BUFFER_SIZE"));
    }

    fn test_notification_tx() -> NotificationSender {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        tx
    }

    fn test_registry() -> Arc<ConnectionTypeRegistry> {
        Arc::new(crate::registry::build_registry())
    }

    /// SM-003 (single-attach): eviction + explicit Reclaim through the manager,
    /// against a real session-daemon loop.
    mod single_attach {
        use super::*;
        use crate::daemon::process::tests::recovery_guard::spawn_daemon;
        use crate::protocol::methods::CONNECTION_EVICTED;
        use std::sync::atomic::{AtomicU32, Ordering};

        struct NoopApplier;
        impl UpdateApplier for NoopApplier {
            fn apply(&self, _pending: &PendingUpdate) -> anyhow::Result<()> {
                Ok(())
            }
        }

        type Rx =
            tokio::sync::mpsc::UnboundedReceiver<crate::protocol::messages::JsonRpcNotification>;

        fn unique(tag: &str) -> String {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            format!(
                "sm003-{tag}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            )
        }

        /// A manager whose shared `state.json` lists `id` at `endpoint`, plus the
        /// receiver for its desktop-bound notifications.
        fn manager_with_session(
            dir: &std::path::Path,
            id: &str,
            endpoint: &str,
        ) -> (SessionManager, Rx) {
            let state_path = dir.join("state.json");
            let mut seeded = AgentState::default();
            seeded.sessions.insert(
                id.to_string(),
                PersistedSession {
                    type_id: "local".to_string(),
                    title: "t".to_string(),
                    created_at: Utc::now().to_rfc3339(),
                    daemon_socket: Some(endpoint.to_string()),
                    settings: serde_json::json!({}),
                    definition_id: None,
                },
            );
            seeded.save_to(&state_path);
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let mgr = SessionManager::with_test_deps(
                tx,
                test_registry(),
                Arc::new(SystemDaemonLauncher),
                state_path,
                Arc::new(NoopApplier),
            );
            (mgr, rx)
        }

        async fn next_evicted(rx: &mut Rx) -> serde_json::Value {
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    let n = rx.recv().await.expect("notification channel open");
                    if n.method == CONNECTION_EVICTED {
                        return n.params;
                    }
                }
            })
            .await
            .expect("connection.evicted must be reported")
        }

        async fn eventually(mut pred: impl FnMut() -> bool) -> bool {
            for _ in 0..200 {
                if pred() {
                    return true;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            pred()
        }

        /// A worker whose start-up recovery finds the session held by a live peer
        /// reports `connection.evicted` (`heldByPeer`) rather than silently dropping
        /// it, and an explicit Reclaim adopts it — evicting the peer.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn held_by_peer_is_reported_and_reclaim_adopts_it() {
            let id = unique("held");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;

            // Another desktop's worker holds the session.
            let peer = DaemonClient::connect(id.clone(), endpoint.clone(), test_notification_tx())
                .await
                .expect("peer attaches");

            let tmp = tempfile::tempdir().unwrap();
            let (mgr, mut rx) = manager_with_session(tmp.path(), &id, &endpoint);
            let recovered = mgr.recover_sessions().await;
            assert!(
                !recovered.contains(&id),
                "a peer-held session is not recovered"
            );
            let params = next_evicted(&mut rx).await;
            assert_eq!(params["session_id"], id.as_str());
            assert_eq!(params["reason"], "heldByPeer");

            // A plain attach cannot take it (this worker does not hold it)...
            assert!(mgr.attach(&id).await.is_err());
            // ...but an explicit Reclaim does, evicting the peer.
            mgr.reclaim(&id).await.expect("reclaim adopts the session");
            assert!(mgr.list().await.iter().any(|s| s.id == id));
            assert!(
                eventually(|| peer.is_evicted()).await,
                "the peer is evicted by the reclaim"
            );
            SessionManagerApi::write_input(&mgr, &id, b"echo\n")
                .await
                .expect("the reclaiming worker controls the session");
        }

        /// While evicted, the worker refuses input (it never writes to a session
        /// another desktop controls) and keeps the session registered; Reclaim
        /// restores control.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn evicted_worker_refuses_input_until_reclaim() {
            let id = unique("evict");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;

            let tmp = tempfile::tempdir().unwrap();
            let (mgr, mut rx) = manager_with_session(tmp.path(), &id, &endpoint);
            mgr.reclaim(&id).await.expect("worker A takes the session");

            // Another desktop takes over.
            let other = DaemonClient::connect(id.clone(), endpoint.clone(), test_notification_tx())
                .await
                .expect("worker B takes over");
            let params = next_evicted(&mut rx).await;
            assert_eq!(params["reason"], "takeover");

            let err = SessionManagerApi::write_input(&mgr, &id, b"x")
                .await
                .expect_err("an evicted worker must refuse input");
            assert_eq!(err, SESSION_TAKEN_OVER);
            let listed = mgr.list().await;
            let entry = listed
                .iter()
                .find(|s| s.id == id)
                .expect("still registered");
            assert_eq!(
                entry.status,
                SessionStatus::Running,
                "an eviction is not an exit"
            );

            mgr.reclaim(&id).await.expect("Reclaim");
            assert!(eventually(|| other.is_evicted()).await);
            SessionManagerApi::write_input(&mgr, &id, b"x")
                .await
                .expect("control restored after Reclaim");
        }

        // ── #3369: tab-less recovery leaves orphans unattached + listable ──

        fn holder_of(listed: &[HostSessionSnapshot], id: &str) -> Option<SessionHolder> {
            listed
                .iter()
                .find(|h| h.snapshot.id == id)
                .map(|h| h.holder)
        }

        /// Maintainer decision 2026-09-26: start-up recovery does NOT adopt an
        /// orphan. It stays running with no holder (another desktop can still
        /// recover-connect it), is listed as unattached, counts as active for the
        /// deferred-update check, and is adopted only when a desktop attaches.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn recovery_leaves_orphan_unattached_until_a_desktop_attaches() {
            let id = unique("orphan");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;

            let tmp = tempfile::tempdir().unwrap();
            let (mgr, _rx) = manager_with_session(tmp.path(), &id, &endpoint);
            let unattached = mgr.recover_sessions().await;
            assert_eq!(unattached, vec![id.clone()]);

            // Not adopted: nobody holds the daemon writer.
            assert_eq!(
                DaemonClient::probe_holder(&id, &endpoint).await.unwrap(),
                ProbeOutcome::Free,
                "recovery must not hold an orphan's daemon"
            );
            let listed = mgr.list().await;
            let entry = listed.iter().find(|s| s.id == id).expect("orphan listed");
            assert!(!entry.attached);
            assert_eq!(entry.status, SessionStatus::Running);
            assert_eq!(
                holder_of(&mgr.list_host().await, &id),
                Some(SessionHolder::Nobody)
            );
            assert_eq!(
                mgr.active_count().await,
                1,
                "an orphan still defers updates"
            );

            // A desktop opening it (plain attach) adopts it.
            mgr.attach(&id).await.expect("open adopts the orphan");
            assert_eq!(
                holder_of(&mgr.list_host().await, &id),
                Some(SessionHolder::Me)
            );
            assert_eq!(
                DaemonClient::probe_holder(&id, &endpoint).await.unwrap(),
                ProbeOutcome::HeldByPeer,
                "the opening worker now holds the daemon"
            );
            SessionManagerApi::write_input(&mgr, &id, b"echo\n")
                .await
                .expect("the opening worker controls the session");
            assert_eq!(mgr.active_count().await, 1, "no double count once adopted");
        }

        /// `list_host` reports a session another desktop holds as `Other`; plain
        /// `list` (the returning-desktop reattach check) does not include it.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn list_host_reports_sessions_held_by_another_desktop() {
            let id = unique("other");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;
            let _peer = DaemonClient::connect(id.clone(), endpoint.clone(), test_notification_tx())
                .await
                .expect("peer attaches");

            let tmp = tempfile::tempdir().unwrap();
            let (mgr, _rx) = manager_with_session(tmp.path(), &id, &endpoint);
            assert_eq!(
                holder_of(&mgr.list_host().await, &id),
                Some(SessionHolder::Other)
            );
            assert!(
                !mgr.list().await.iter().any(|s| s.id == id),
                "connection.list only lists sessions this desktop can attach"
            );
            // The probe did not disturb the holder.
            assert_eq!(
                DaemonClient::probe_holder(&id, &endpoint).await.unwrap(),
                ProbeOutcome::HeldByPeer
            );
        }

        /// Take over from the list: an explicit takeover attach evicts the holder
        /// and flips the listing to `Me`.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn take_over_from_list_evicts_the_holder() {
            let id = unique("takeover");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;
            let peer = DaemonClient::connect(id.clone(), endpoint.clone(), test_notification_tx())
                .await
                .expect("peer attaches");

            let tmp = tempfile::tempdir().unwrap();
            let (mgr, _rx) = manager_with_session(tmp.path(), &id, &endpoint);
            assert_eq!(
                holder_of(&mgr.list_host().await, &id),
                Some(SessionHolder::Other)
            );
            mgr.reclaim(&id).await.expect("take over");
            assert!(eventually(|| peer.is_evicted()).await, "holder evicted");
            assert_eq!(
                holder_of(&mgr.list_host().await, &id),
                Some(SessionHolder::Me)
            );
        }

        /// A dead daemon whose state entry lingers is dropped from the listing
        /// and reclaimed rather than offered to the user.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn list_host_omits_and_reclaims_dead_sessions() {
            let id = unique("dead");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let tmp = tempfile::tempdir().unwrap();
            let (mgr, _rx) = manager_with_session(tmp.path(), &id, &endpoint);
            assert!(holder_of(&mgr.list_host().await, &id).is_none());
            assert!(!mgr.fresh_persisted_sessions().await.contains_key(&id));
        }

        /// Closing an unattached orphan (e.g. Stop from the sidebar) adopts and
        /// kills it; one another desktop holds is left alone.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn close_adopts_an_orphan_but_not_a_held_session() {
            let id = unique("close-held");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;
            let peer = DaemonClient::connect(id.clone(), endpoint.clone(), test_notification_tx())
                .await
                .expect("peer attaches");
            let tmp = tempfile::tempdir().unwrap();
            let (mgr, _rx) = manager_with_session(tmp.path(), &id, &endpoint);
            assert!(!mgr.close(&id).await, "a held session is not closed");
            assert!(!peer.is_evicted());

            let id2 = unique("close-orphan");
            let endpoint2 = crate::daemon::transport::session_endpoint(&id2);
            let _daemon2 = spawn_daemon(&endpoint2).await;
            let tmp2 = tempfile::tempdir().unwrap();
            let (mgr2, _rx2) = manager_with_session(tmp2.path(), &id2, &endpoint2);
            assert!(mgr2.close(&id2).await, "an orphan can be stopped");
            assert!(!mgr2.fresh_persisted_sessions().await.contains_key(&id2));
        }

        // ── #3395: a plain re-attach never silently evicts another desktop ──

        /// Assert no `connection.evicted` notification is (or becomes) pending on
        /// `rx` within a short window — i.e. this worker was not evicted.
        async fn assert_no_takeover_notice(rx: &mut Rx) {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(300);
            while let Ok(Some(n)) = tokio::time::timeout_at(deadline, rx.recv()).await {
                assert!(
                    !(n.method == CONNECTION_EVICTED && n.params["reason"] == "takeover"),
                    "the holder must not be evicted: {:?}",
                    n.params
                );
            }
        }

        /// The #3395 bug: a session this worker detached from (tab closed) but
        /// still tracks is opened by another desktop meanwhile. Re-opening it here
        /// (a plain attach) must be refused with `heldByPeer` — the other desktop
        /// keeps it undisturbed — and only an explicit Reclaim takes it over.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn plain_reattach_of_detached_session_held_by_peer_is_refused() {
            let id = unique("reopen-held");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;

            let tmp = tempfile::tempdir().unwrap();
            let (mgr, mut rx) = manager_with_session(tmp.path(), &id, &endpoint);
            mgr.attach(&id)
                .await
                .expect("this desktop opens the session");
            mgr.detach(&id).await.expect("tab closed: detach");
            assert!(
                mgr.sessions.lock().await.contains_key(&id),
                "the detached session is still tracked by this worker"
            );

            // Another desktop opens it (its own plain, recovery-intent adoption).
            // No retry: `detach` returns only once the daemon has released this
            // worker's connection (#3410), so the session is free right now.
            let (peer_tx, mut peer_rx) = tokio::sync::mpsc::unbounded_channel();
            let peer = DaemonClient::connect_for_recovery(id.clone(), endpoint.clone(), peer_tx)
                .await
                .expect("the other desktop opens the unheld session");

            // Re-opening it here is refused rather than a silent takeover.
            let err = mgr
                .attach(&id)
                .await
                .expect_err("a plain re-attach must not take a held session");
            assert_eq!(err, SESSION_HELD_BY_OTHER);
            let params = next_evicted(&mut rx).await;
            assert_eq!(params["session_id"], id.as_str());
            assert_eq!(params["reason"], "heldByPeer");

            // The peer is undisturbed and still controls the session.
            assert_no_takeover_notice(&mut peer_rx).await;
            assert!(!peer.is_evicted(), "the other desktop must not be evicted");
            peer.query_buffer()
                .await
                .expect("the other desktop still controls the session");
            assert_eq!(
                holder_of(&mgr.list_host().await, &id),
                Some(SessionHolder::Other)
            );
            assert_eq!(
                SessionManagerApi::write_input(&mgr, &id, b"x")
                    .await
                    .expect_err("this desktop must not write to a held session"),
                SESSION_TAKEN_OVER
            );

            // Only the explicit Reclaim takes it over.
            mgr.reclaim(&id).await.expect("explicit Reclaim takes over");
            assert!(
                eventually(|| peer.is_evicted()).await,
                "the explicit Reclaim evicts the other desktop"
            );
            SessionManagerApi::write_input(&mgr, &id, b"echo\n")
                .await
                .expect("control restored after the explicit Reclaim");
        }

        /// A detached session nobody else opened re-attaches normally.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn plain_reattach_of_detached_unheld_session_attaches() {
            let id = unique("reopen-free");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;

            let tmp = tempfile::tempdir().unwrap();
            let (mgr, _rx) = manager_with_session(tmp.path(), &id, &endpoint);
            mgr.attach(&id).await.expect("open");
            // Repeated so a detach that returns before the daemon processed it
            // (#3410: the probe then still sees this worker as the holder) cannot
            // slip through on a lucky schedule.
            for round in 0..5 {
                mgr.detach(&id).await.expect("detach");
                assert_eq!(
                    DaemonClient::probe_holder(&id, &endpoint).await.unwrap(),
                    ProbeOutcome::Free,
                    "a detached session is held by nobody (round {round})"
                );
                mgr.attach(&id).await.expect("re-open re-attaches");
            }
            mgr.detach(&id).await.expect("detach");

            mgr.attach(&id).await.expect("re-open re-attaches");
            assert_eq!(
                holder_of(&mgr.list_host().await, &id),
                Some(SessionHolder::Me)
            );
            SessionManagerApi::write_input(&mgr, &id, b"echo\n")
                .await
                .expect("the re-attached worker controls the session");
        }

        /// A plain attach of a session this worker already holds live (e.g. a
        /// returning tab re-attaching for a fresh replay) keeps control: releasing
        /// its own connection first means the recovery-intent reconnect is not
        /// refused on account of itself.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn plain_reattach_while_holding_keeps_control() {
            let id = unique("reopen-self");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;

            let tmp = tempfile::tempdir().unwrap();
            let (mgr, _rx) = manager_with_session(tmp.path(), &id, &endpoint);
            mgr.attach(&id).await.expect("open");
            mgr.attach(&id).await.expect("re-attach while holding");
            assert_eq!(
                holder_of(&mgr.list_host().await, &id),
                Some(SessionHolder::Me)
            );
            SessionManagerApi::write_input(&mgr, &id, b"echo\n")
                .await
                .expect("still in control");
        }

        /// After another desktop took the session over, a plain attach here does
        /// not take it back (no ping-pong); only an explicit Reclaim does.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn plain_attach_of_evicted_session_does_not_take_it_back() {
            let id = unique("evicted-plain");
            let endpoint = crate::daemon::transport::session_endpoint(&id);
            let _daemon = spawn_daemon(&endpoint).await;

            let tmp = tempfile::tempdir().unwrap();
            let (mgr, mut rx) = manager_with_session(tmp.path(), &id, &endpoint);
            mgr.attach(&id).await.expect("open");
            let (other_tx, mut other_rx) = tokio::sync::mpsc::unbounded_channel();
            let other = DaemonClient::connect(id.clone(), endpoint.clone(), other_tx)
                .await
                .expect("another desktop takes over (explicitly)");
            assert_eq!(next_evicted(&mut rx).await["reason"], "takeover");

            let err = mgr
                .attach(&id)
                .await
                .expect_err("a plain attach must not take the session back");
            assert_eq!(err, SESSION_HELD_BY_OTHER);
            assert_eq!(next_evicted(&mut rx).await["reason"], "heldByPeer");
            assert_no_takeover_notice(&mut other_rx).await;
            assert!(!other.is_evicted());

            mgr.reclaim(&id).await.expect("explicit Reclaim");
            assert!(eventually(|| other.is_evicted()).await);
        }
    }

    // ── AGT-019: dead-session socket/log reclaim during recovery ─────────
    //
    // A daemon killed with SIGKILL never runs `cleanup()`, so its `.sock`/`.log`
    // files linger. Recovery used to remove only the `state.json` entry, leaking
    // the on-disk files forever. These drive the real `recover_sessions` and
    // prove a *dead* session's files are reclaimed while a *live* one's are not.
    #[cfg(unix)]
    mod recovery_file_reclaim {
        use super::*;
        use crate::daemon::protocol;
        use crate::daemon::transport::{
            agent_forward_endpoint, ensure_agent_forward_dir, session_endpoint,
        };
        use std::io::Write;
        use std::path::Path;
        use std::sync::atomic::{AtomicU32, Ordering};

        struct NoopApplier;
        impl UpdateApplier for NoopApplier {
            fn apply(&self, _pending: &PendingUpdate) -> anyhow::Result<()> {
                Ok(())
            }
        }

        fn unique(tag: &str) -> String {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            format!(
                "agt019-{tag}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            )
        }

        fn persisted(endpoint: &str) -> PersistedSession {
            PersistedSession {
                type_id: "local".to_string(),
                title: "t".to_string(),
                created_at: Utc::now().to_rfc3339(),
                daemon_socket: Some(endpoint.to_string()),
                settings: serde_json::json!({}),
                definition_id: None,
            }
        }

        fn touch(path: &str) {
            std::fs::File::create(path)
                .expect("create session file")
                .write_all(b"x")
                .expect("write session file");
        }

        /// A minimal live daemon: binds the endpoint, completes the recovery
        /// handshake (read the client's attach-intent frame, send `MSG_READY`),
        /// and keeps the connection open so the session reads as alive. Loops so
        /// a stray probe can never starve the real recovery connect.
        async fn spawn_min_live_daemon(endpoint: &str) -> tokio::task::JoinHandle<()> {
            let mut listener = crate::daemon::transport::DaemonListener::bind(endpoint)
                .await
                .expect("bind live daemon");
            tokio::spawn(async move {
                while let Ok((mut r, mut w)) = listener.accept().await {
                    let _ = protocol::read_frame_async(&mut r).await;
                    if protocol::write_frame_async(&mut w, protocol::MSG_READY, &[])
                        .await
                        .is_err()
                    {
                        continue;
                    }
                    tokio::spawn(async move {
                        let _ = protocol::read_frame_async(&mut r).await;
                        let _ = &mut w;
                    });
                }
            })
        }

        #[tokio::test]
        async fn recover_reclaims_dead_session_files_but_keeps_live() {
            ensure_agent_forward_dir().expect("ensure socket dir");

            let live_id = unique("live");
            let dead_id = unique("dead");
            let live_ep = session_endpoint(&live_id);
            let dead_ep = session_endpoint(&dead_id);
            let live_log = live_ep.replace(".sock", ".log");
            let dead_log = dead_ep.replace(".sock", ".log");
            let dead_relay = agent_forward_endpoint(&dead_id);

            // Live session: a real (minimal) daemon owns the endpoint; give it a
            // sibling log too.
            let _live = spawn_min_live_daemon(&live_ep).await;
            touch(&live_log);

            // Dead session: a lingering *regular file* at the socket path (a
            // connect fails fast and deterministically, unlike a just-closed
            // in-process socket which stays transiently connectable on macOS),
            // plus its relay socket and log — exactly what a SIGKILL leaves.
            touch(&dead_ep);
            touch(&dead_relay);
            touch(&dead_log);

            let tmp = tempfile::tempdir().unwrap();
            let state_path = tmp.path().join("state.json");
            let mut seeded = AgentState::default();
            seeded.sessions.insert(live_id.clone(), persisted(&live_ep));
            seeded.sessions.insert(dead_id.clone(), persisted(&dead_ep));
            seeded.save_to(&state_path);

            let mgr = SessionManager::with_test_deps(
                test_notification_tx(),
                test_registry(),
                Arc::new(SystemDaemonLauncher),
                state_path.clone(),
                Arc::new(NoopApplier),
            );

            let recovered = mgr.recover_sessions().await;

            // Live: recovered, files untouched.
            assert!(
                recovered.contains(&live_id),
                "live session must be recovered, got {recovered:?}"
            );
            assert!(Path::new(&live_ep).exists(), "live socket must survive");
            assert!(Path::new(&live_log).exists(), "live log must survive");

            // Dead: not recovered; socket, relay and log all reclaimed (AGT-019).
            assert!(
                !recovered.contains(&dead_id),
                "dead session must not be recovered"
            );
            assert!(
                !Path::new(&dead_ep).exists(),
                "dead socket must be reclaimed (AGT-019)"
            );
            assert!(
                !Path::new(&dead_relay).exists(),
                "dead relay socket must be reclaimed (AGT-019)"
            );
            assert!(
                !Path::new(&dead_log).exists(),
                "dead log must be reclaimed (AGT-019)"
            );

            // State reflects the same: dead entry gone, live entry kept.
            let remaining = AgentState::load_from(&state_path);
            assert!(
                !remaining.sessions.contains_key(&dead_id),
                "dead entry must be removed from state"
            );
            assert!(
                remaining.sessions.contains_key(&live_id),
                "live entry must remain in state"
            );

            // Cleanup the live files we created (the daemon task is detached).
            let _ = std::fs::remove_file(&live_ep);
            let _ = std::fs::remove_file(&live_log);
        }
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

        /// Number of in-flight create reservations (test-only), so tests can
        /// assert a failed or finished create leaves no leaked slot reservation.
        #[cfg(test)]
        pub async fn pending_creates_len_for_test(&self) -> usize {
            self.pending_creates.lock().await.len()
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
                expected_sha256: None,
                signature: None,
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
                expected_sha256: None,
                signature: None,
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
                expected_sha256: None,
                signature: None,
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
            // A real file inside the trusted staging dir so path confinement
            // passes (AGT-003).
            let staging = tmp.path().join("updates");
            std::fs::create_dir_all(&staging).unwrap();
            let bin = staging.join("staged-agent");
            std::fs::write(&bin, b"BIN").unwrap();

            let outcome = mgr
                .request_deferred_update(
                    Some(bin.to_string_lossy().into_owned()),
                    Some("1.0.0".to_string()),
                    Some("a".repeat(64)),
                    None,
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
            // AGT-004: the caller-supplied expected digest is persisted on the
            // pending update so the last-disconnect apply can re-verify it.
            let pending = mgr
                .pending_update_for_test()
                .await
                .expect("the pending update must be persisted for the last-disconnect apply");
            assert_eq!(
                pending.expected_sha256.as_deref(),
                Some("a".repeat(64).as_str())
            );
        }

        #[tokio::test]
        async fn request_when_idle_applies_immediately() {
            let (mgr, applied, tmp) = manager_with_recording_applier();
            // Stage inside the trusted staging dir so path confinement passes.
            let staging = tmp.path().join("updates");
            std::fs::create_dir_all(&staging).unwrap();
            let bin = staging.join("staged-agent");
            std::fs::write(&bin, b"BIN").unwrap();

            let outcome = mgr
                .request_deferred_update(Some(bin.to_string_lossy().into_owned()), None, None, None)
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

            let outcome = mgr
                .request_deferred_update(None, None, None, None)
                .await
                .unwrap();
            assert!(matches!(outcome, DeferredUpdateOutcome::Applying));
            let log = applied.lock().unwrap();
            assert_eq!(log.len(), 1);
            assert_eq!(log[0].binary_path, "/tmp/staged-agent");
        }

        #[tokio::test]
        async fn request_without_path_and_no_pending_errors() {
            let (mgr, _applied, _tmp) = manager_with_recording_applier();
            let err = mgr
                .request_deferred_update(None, None, None, None)
                .await
                .unwrap_err();
            assert!(matches!(err, DeferredUpdateError::NoPendingUpdate));
        }

        #[tokio::test]
        async fn request_with_missing_binary_errors() {
            let (mgr, _applied, _tmp) = manager_with_recording_applier();
            let err = mgr
                .request_deferred_update(Some("/no/such/binary".to_string()), None, None, None)
                .await
                .unwrap_err();
            assert!(matches!(err, DeferredUpdateError::BinaryNotFound(_)));
        }

        #[tokio::test]
        async fn rejects_binary_outside_the_staging_dir() {
            // AGT-003: an existing file OUTSIDE the trusted staging dir must be
            // refused — an arbitrary readable path can no longer be swapped in as
            // the agent binary. Fail closed: nothing staged, nothing applied.
            let (mgr, applied, tmp) = manager_with_recording_applier();
            let outside = tmp.path().join("evil-agent");
            std::fs::write(&outside, b"EVIL").unwrap();

            let err = mgr
                .request_deferred_update(
                    Some(outside.to_string_lossy().into_owned()),
                    None,
                    None,
                    None,
                )
                .await
                .expect_err("a binary outside the staging dir must be rejected");
            assert!(
                format!("{err}").contains("staging"),
                "the error must name the staging-confinement reason, got: {err}"
            );
            assert!(
                applied.lock().unwrap().is_empty(),
                "a rejected update must never be applied"
            );
            assert!(
                mgr.pending_update_for_test().await.is_none(),
                "a rejected update must never be staged as pending"
            );
        }

        // ── AGT-005: signature refusal surfaces as a typed error (#3213) ──

        /// Applier enforcing the release-build signature rule (no unsigned
        /// allowance, no trusted key) at staging time, and failing any apply
        /// with a typed signature error — the shape the real gate produces.
        struct StrictSignatureApplier {
            applied: AppliedLog,
        }

        impl UpdateApplier for StrictSignatureApplier {
            fn apply(&self, pending: &PendingUpdate) -> anyhow::Result<()> {
                self.applied
                    .lock()
                    .expect("applied lock")
                    .push(pending.clone());
                Err(anyhow::Error::from(UpdateSignatureError::Missing).context(
                    "refuse to apply an agent update binary that failed signature verification",
                ))
            }

            fn check_signature(
                &self,
                _digest_hex: &str,
                signature: Option<&str>,
            ) -> Result<(), UpdateSignatureError> {
                match signature {
                    None => Err(UpdateSignatureError::Missing),
                    Some(_) => Err(UpdateSignatureError::Invalid),
                }
            }
        }

        fn manager_with_strict_signature_applier() -> (SessionManager, AppliedLog, tempfile::TempDir)
        {
            let tmp = tempfile::tempdir().unwrap();
            let applied: AppliedLog = Arc::new(StdMutex::new(Vec::new()));
            let mgr = SessionManager::with_test_deps(
                test_notification_tx(),
                test_registry(),
                Arc::new(SystemDaemonLauncher),
                tmp.path().join("state.json"),
                Arc::new(StrictSignatureApplier {
                    applied: applied.clone(),
                }),
            );
            (mgr, applied, tmp)
        }

        #[tokio::test]
        async fn unsigned_pushed_update_is_refused_before_staging() {
            let (mgr, applied, tmp) = manager_with_strict_signature_applier();
            let staging = tmp.path().join("updates");
            std::fs::create_dir_all(&staging).unwrap();
            let bin = staging.join("staged-agent");
            std::fs::write(&bin, b"UNSIGNED").unwrap();

            let err = mgr
                .request_deferred_update(
                    Some(bin.to_string_lossy().into_owned()),
                    Some("9.9.9".to_string()),
                    Some("a".repeat(64)),
                    None,
                )
                .await
                .expect_err("an unsigned update must be refused");
            assert!(
                matches!(
                    err,
                    DeferredUpdateError::SignatureRejected(UpdateSignatureError::Missing)
                ),
                "got {err}"
            );
            assert!(applied.lock().unwrap().is_empty());
            assert!(
                mgr.pending_update_for_test().await.is_none(),
                "a refused update must never be persisted as pending"
            );
        }

        #[tokio::test]
        async fn signature_failure_at_apply_maps_to_the_typed_variant() {
            // "Apply Now" of an already-staged update: the signature refusal comes
            // back from the applier inside an anyhow chain and must still surface
            // as `SignatureRejected`, not a generic apply failure.
            let (mgr, applied, _tmp) = manager_with_strict_signature_applier();
            mgr.stage_pending_update(
                "/tmp/staged".to_string(),
                "9.9.9".to_string(),
                Some("a".repeat(64)),
                None,
            )
            .await;

            let err = mgr
                .request_deferred_update(None, None, None, None)
                .await
                .expect_err("the apply must fail");
            assert!(
                matches!(
                    err,
                    DeferredUpdateError::SignatureRejected(UpdateSignatureError::Missing)
                ),
                "got {err}"
            );
            assert_eq!(applied.lock().unwrap().len(), 1);
            assert!(
                mgr.pending_update_for_test().await.is_some(),
                "a failed apply keeps the pending update"
            );
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

        // ── Daemon-backed natural-exit deferred-apply (issue #2381) ──────

        /// Build an `into_arc` manager with a recording applier so the daemon
        /// exit hook (which reaches back through the `Weak` self-reference) can be
        /// exercised end to end.
        fn arc_manager_with_recording_applier(
        ) -> (Arc<SessionManager>, AppliedLog, tempfile::TempDir) {
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
            (mgr, applied, tmp)
        }

        #[tokio::test]
        async fn daemon_exit_hook_applies_pending_update_when_idle() {
            // The daemon-backed twin of the in-process forwarder test: when the
            // last daemon-backed session exits on its own, the client runs the
            // installed exit hook, which must drive the deferred apply through the
            // manager's `Weak` self-reference (#2381).
            let (mgr, applied, _tmp) = arc_manager_with_recording_applier();
            mgr.seed_pending_update_for_test(fake_pending("/tmp/new-agent"))
                .await;

            // No running sessions → the manager is idle. Running the hook the
            // daemon client would install must apply the staged update once.
            let hook = mgr
                .deferred_update_exit_hook()
                .expect("an into_arc manager installs a daemon exit hook");
            hook().await;

            {
                let log = applied.lock().unwrap();
                assert_eq!(log.len(), 1, "update applies exactly once when idle");
                assert_eq!(log[0].binary_path, "/tmp/new-agent");
            }
            assert!(
                mgr.pending_update_for_test().await.is_none(),
                "a successful daemon-exit apply clears pending_update"
            );
        }

        #[tokio::test]
        async fn daemon_exit_hook_defers_while_a_session_still_runs() {
            // A daemon-backed session exiting while another session is still
            // running must NOT apply the staged update — the agent is still busy.
            let (mgr, applied, _tmp) = arc_manager_with_recording_applier();
            mgr.create_stub_session("stub", "still-running".to_string(), serde_json::json!({}))
                .await
                .unwrap();
            mgr.seed_pending_update_for_test(fake_pending("/tmp/new-agent"))
                .await;

            let hook = mgr.deferred_update_exit_hook().expect("hook present");
            hook().await;

            assert!(
                applied.lock().unwrap().is_empty(),
                "update must not apply while a session is still running"
            );
            assert!(
                mgr.pending_update_for_test().await.is_some(),
                "the pending update is retained until the agent is idle"
            );
        }

        #[tokio::test]
        async fn deferred_update_exit_hook_absent_without_into_arc() {
            // A manager not built through `into_arc` has no self-reference, so no
            // daemon exit hook is installed — read-path reconciliation still
            // settles the session, exactly as the in-process forwarder skips its
            // hook on an empty `Weak`.
            let (mgr, _applied, _tmp) = manager_with_recording_applier();
            assert!(
                mgr.deferred_update_exit_hook().is_none(),
                "no self-reference ⇒ no daemon exit hook"
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
    async fn output_forwarder_sends_one_notification_per_chunk_then_exit() {
        use base64::Engine;

        use crate::protocol::methods::{CONNECTION_EXIT, CONNECTION_OUTPUT};

        // The agent must not coalesce: each received output chunk maps to exactly
        // one `connection.output` notification so the on-wire framing mirrors the
        // chunk boundaries. On channel close a single `connection.exit` follows.
        let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
        let (notif_tx, mut notif_rx) = tokio::sync::mpsc::unbounded_channel();
        let alive = Arc::new(AtomicBool::new(true));

        // Three distinct sub-64-KiB chunks; each must survive as its own send.
        out_tx.send(b"aaa".to_vec()).await.unwrap();
        out_tx.send(b"bbb".to_vec()).await.unwrap();
        out_tx.send(b"ccc".to_vec()).await.unwrap();
        drop(out_tx); // model backend EOF

        let handle = spawn_output_forwarder(
            out_rx,
            "sess".to_string(),
            notif_tx,
            alive.clone(),
            Weak::new(),
        );
        handle.await.expect("forwarder task joins cleanly");

        assert!(!alive.load(Ordering::SeqCst), "backend marked dead on EOF");

        let b64 = base64::engine::general_purpose::STANDARD;
        let mut outputs: Vec<Vec<u8>> = Vec::new();
        let mut exits = 0;
        while let Ok(n) = notif_rx.try_recv() {
            if n.method == CONNECTION_OUTPUT {
                let decoded = b64
                    .decode(n.params["data"].as_str().unwrap())
                    .expect("output payload is base64");
                outputs.push(decoded);
            } else if n.method == CONNECTION_EXIT {
                exits += 1;
                assert_eq!(n.params["exit_code"], 0);
            }
        }

        assert_eq!(
            outputs,
            vec![b"aaa".to_vec(), b"bbb".to_vec(), b"ccc".to_vec()],
            "each chunk must be forwarded as its own output notification (no coalescing)"
        );
        assert_eq!(exits, 1, "exactly one connection.exit on channel close");
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
                _extras: LaunchExtras,
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

        // ── CONC-004: create must not hold `sessions` across the connect ──

        /// A launcher whose `launch` blocks until released, signalling on entry.
        ///
        /// Lets a test drive `create` to the exact point where the (formerly
        /// lock-holding) backend connect would run, and hold it there while
        /// exercising I/O on other sessions.
        struct BlockingLauncher {
            entered_tx: tokio::sync::mpsc::UnboundedSender<()>,
            release: Arc<tokio::sync::Notify>,
        }

        #[async_trait::async_trait]
        impl DaemonLauncher for BlockingLauncher {
            async fn launch(
                &self,
                _session_id: &str,
                _type_id: &str,
                _settings: &serde_json::Value,
                _notification_tx: NotificationSender,
                _buffer_size_bytes: usize,
                _extras: LaunchExtras,
            ) -> Result<SessionBackend, anyhow::Error> {
                let _ = self.entered_tx.send(());
                self.release.notified().await;
                Ok(SessionBackend::Stub {
                    alive: Arc::new(AtomicBool::new(true)),
                })
            }
        }

        const SSH_SETTINGS: fn() -> serde_json::Value = || {
            serde_json::json!({
                "host": "example.com",
                "username": "user",
                "authMethod": "password",
            })
        };

        /// A slow/blocked backend connect in one `create` must NOT delay
        /// `write_input`/`list`/`resize` on an already-existing session — the
        /// whole point of CONC-004. Without the fix these ops would block on the
        /// `sessions` lock the slow create is holding.
        #[tokio::test]
        async fn slow_create_does_not_block_other_session_io() {
            let release = Arc::new(tokio::sync::Notify::new());
            let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
            let mgr = Arc::new(SessionManager::with_launcher(
                test_notification_tx(),
                test_registry(),
                Arc::new(BlockingLauncher {
                    entered_tx,
                    release: release.clone(),
                }),
            ));

            // An existing, already-connected session.
            let existing = mgr
                .create_stub_session("stub", "existing".to_string(), json!({}))
                .await
                .unwrap();
            let existing_id = existing.id.clone();

            // Kick off a create that will block inside the launcher's connect.
            let mgr2 = mgr.clone();
            let create_task = tokio::spawn(async move {
                mgr2.create("ssh", "slow".to_string(), SSH_SETTINGS(), None)
                    .await
            });

            // Wait until the create is actually inside `launch` — i.e. it has
            // released `sessions` and is stuck on the (blocked) connect.
            entered_rx
                .recv()
                .await
                .expect("create never reached launch");

            // I/O on the existing session must complete promptly, not wait for
            // the blocked connect. A tight timeout is the assertion: with the old
            // lock-held-across-connect code these would hang until `release`.
            let d = std::time::Duration::from_secs(2);
            tokio::time::timeout(d, mgr.write_input(&existing_id, b"x"))
                .await
                .expect("write_input blocked behind slow create")
                .expect("write_input failed");
            tokio::time::timeout(d, mgr.resize(&existing_id, 80, 24))
                .await
                .expect("resize blocked behind slow create")
                .expect("resize failed");
            tokio::time::timeout(d, mgr.list())
                .await
                .expect("list blocked behind slow create");

            // Let the create finish and confirm it lands normally.
            release.notify_one();
            let snapshot = create_task
                .await
                .expect("create task panicked")
                .expect("create failed");
            assert_eq!(snapshot.title, "slow");
            assert_eq!(mgr.active_count().await, 2);
            assert_eq!(
                mgr.pending_creates_len_for_test().await,
                0,
                "reservation must be dropped after a successful create"
            );
        }

        /// A failed connect must release the reserved slot, so a run of failing
        /// creates never exhausts MAX_SESSIONS with phantom reservations.
        #[tokio::test]
        async fn failed_create_releases_reserved_slot() {
            let (mgr, _) = make_manager_with_mock(MockDaemonLauncher::failing());

            // Far more failing creates than the cap: if a failed create leaked its
            // reservation, we'd start seeing LimitReached instead of BackendFailed.
            for _ in 0..(MAX_SESSIONS as usize + 5) {
                let result = mgr
                    .create("ssh", "fail".to_string(), SSH_SETTINGS(), None)
                    .await;
                assert!(
                    matches!(result, Err(SessionCreateError::BackendFailed(_))),
                    "expected BackendFailed (no leaked reservation), got: {result:?}"
                );
            }
            assert_eq!(
                mgr.pending_creates_len_for_test().await,
                0,
                "a failed create must not leak its slot reservation"
            );
            assert_eq!(mgr.list().await.len(), 0);
        }

        /// MAX_SESSIONS must stay enforced even when several creates race with
        /// their connects still in flight: a reservation counts toward the cap, so
        /// concurrent creates can't overshoot it.
        #[tokio::test]
        async fn concurrent_creates_respect_max_sessions_via_reservations() {
            let release = Arc::new(tokio::sync::Notify::new());
            let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
            let mgr = Arc::new(SessionManager::with_launcher(
                test_notification_tx(),
                test_registry(),
                Arc::new(BlockingLauncher {
                    entered_tx,
                    release: release.clone(),
                }),
            ));

            // Fill to one below the cap with already-live sessions.
            for i in 0..(MAX_SESSIONS as usize - 1) {
                mgr.create_stub_session("stub", format!("s{i}"), json!({}))
                    .await
                    .unwrap();
            }

            // Three creates race for the single remaining slot. Only one can
            // reserve it; the other two must fail fast with LimitReached (before
            // ever reaching the blocking launcher).
            let mut tasks = Vec::new();
            for _ in 0..3 {
                let m = mgr.clone();
                tasks.push(tokio::spawn(async move {
                    m.create("ssh", "race".to_string(), SSH_SETTINGS(), None)
                        .await
                }));
            }

            // Exactly one create wins the reservation and blocks in the launcher;
            // the other two fail their reservation and return LimitReached without
            // ever reaching `launch`, so this recv sees exactly one signal.
            entered_rx
                .recv()
                .await
                .expect("no create won the last slot");

            // Release the winner; the losers have already returned (their
            // reservation failed synchronously, before any await point).
            release.notify_one();

            let mut ok = 0;
            let mut limit_reached = 0;
            for t in tasks {
                match t.await.expect("create task panicked") {
                    Ok(_) => ok += 1,
                    Err(SessionCreateError::LimitReached) => limit_reached += 1,
                    Err(other) => panic!("unexpected create error: {other:?}"),
                }
            }
            assert_eq!(ok, 1, "exactly one create should take the last slot");
            assert_eq!(limit_reached, 2, "the other two must hit LimitReached");
            assert_eq!(mgr.active_count().await, MAX_SESSIONS);
            assert_eq!(mgr.pending_creates_len_for_test().await, 0);
        }
    }

    /// Keyboard-interactive prompt relay through daemon launches (#3375).
    mod ki_prompt_tests;
}
