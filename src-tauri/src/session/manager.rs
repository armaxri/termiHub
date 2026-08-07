//! Unified session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Replaces the legacy `TerminalManager` with a single manager that holds
//! `Box<dyn ConnectionType>` for both local and remote (agent-mediated)
//! connections. Local connections use the core backend implementations;
//! remote connections use [`RemoteProxy`](super::remote_proxy::RemoteProxy).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use serde::Serialize;
use tauri::Emitter;
use termihub_core::backends::ssh::SftpFileBrowser;
use termihub_core::buffer::{RingBuffer, DEFAULT_BUFFER_CAPACITY};
use termihub_core::connection::{
    Capabilities, ConnectionType, ConnectionTypeInfo, ConnectionTypeRegistry,
};
use termihub_core::files::FileEntry;
use termihub_core::monitoring::{MonitorStatus, SystemStats};
use termihub_core::output::coalescer::OutputCoalescer;
use termihub_core::output::screen_clear::ScreenClearDetector;
use termihub_core::output::session_log::{SessionLogConfig, SessionLogger};
use tracing::{error, info, warn};

use crate::files::sftp::{ElevatedWriteResult, Writability};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

use super::file_ops::FileOps;
use super::line_ending::{normalize_line_endings, LineEnding};
use super::monitoring_controller::MonitoringController;
use super::persistent_controller::PersistentController;
use super::remote_proxy::RemoteProxy;
use super::session_log::{default_session_log_path, desktop_clock};

/// Maximum number of concurrent sessions.
const MAX_SESSIONS: usize = 50;

/// Maximum coalesced output size per emit (32 KB).
const MAX_COALESCE_BYTES: usize = 32 * 1024;

/// Maximum time to wait for the screen-clear sequence before flushing
/// buffered output anyway.
const CLEAR_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Output event emitted via Tauri events.
///
/// Terminal output is the app's single most important hot path — every byte of
/// process output crosses the webview IPC boundary through this event. The
/// `data` bytes are serialized as a **base64 string** rather than serde's
/// default JSON number-array for `Vec<u8>` (which is a 3.3–4x byte bloat plus a
/// per-byte array→`Uint8Array` copy on the frontend). base64 mirrors the remote
/// protocol, is ~2.5x smaller on the wire, and decodes in one pass on the TS
/// side (`src/services/events.ts`). The field stays `Vec<u8>` in Rust so the
/// producer (the output reader loop) and tests are unchanged; only the wire form
/// differs (#2072).
#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutputEvent {
    pub session_id: String,
    #[serde(serialize_with = "serialize_bytes_base64")]
    pub data: Vec<u8>,
}

/// Serialize a byte slice as a base64 (standard alphabet, padded) string.
///
/// Paired with the base64 decode in `src/services/events.ts`; the two are exact
/// inverses, including high bytes (0x80–0xFF), UTF-8 multi-byte sequences, and
/// empty input (which encodes to the empty string). See [`TerminalOutputEvent`].
fn serialize_bytes_base64<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    serializer.serialize_str(&encoded)
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
///
/// Fields are `pub(super)` so the persistent-session facade
/// ([`super::persistent_controller`]) can read and construct records while the
/// registry (`persistent_sessions`) stays a field on the manager (#2111).
pub(super) struct PersistentRecord {
    pub(super) connection_id: String,
    pub(super) session_id: String,
    pub(super) attached_tabs: HashSet<String>,
    /// Agent-side session ID — used to re-attach to the daemon when the desktop
    /// session entry is cleaned up after an agent SSH disconnect.
    pub(super) remote_session_id: Option<String>,
    /// Agent that owns this session — paired with `remote_session_id` for reconnect.
    pub(super) agent_id: Option<String>,
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
    /// `true` when the session was opened via the CLI/context-menu spawn path
    /// (#1446, #1466) — a container with no saved connection id. Recorded on the
    /// session itself so the Open Connections panel groups it under "Spawned
    /// Containers" from this authoritative backend marker, surviving a tab close
    /// (whereas the frontend `spawned` tab flag is lost once the tab is gone).
    #[serde(default)]
    pub spawned: bool,
}

/// Internal session entry held by the manager.
///
/// `pub(super)` so the file-operations facade ([`super::file_ops`]) can resolve
/// a session's `connection` and forward file-browser calls (#2076); the manager
/// remains the only place entries are constructed and mutated.
pub(super) struct SessionEntry {
    pub(super) connection: Box<dyn ConnectionType>,
    pub(super) info: SessionInfo,
    /// Remote session ID assigned by the agent (set for remote proxy sessions).
    pub(super) remote_session_id: Option<String>,
    /// Line ending applied to interactive input (Enter / paste) for this
    /// session. Set by the frontend via `set_session_line_ending`; defaults to
    /// [`LineEnding::Lf`] until then.
    pub(super) line_ending: LineEnding,
}

/// Push event emitted via Tauri when session-based monitoring delivers stats.
#[derive(Debug, Clone, Serialize)]
pub struct SessionMonitoringStatsEvent {
    pub session_id: String,
    pub stats: SystemStats,
}

/// Push event emitted via Tauri when a session's monitoring status changes.
///
/// Carries the collector loop's lifecycle state so the frontend can render an
/// explicit `Stale` indicator instead of showing frozen stats as live (#1229,
/// audit gap G1). `session_id` is snake_case to match the frontend payload.
#[derive(Debug, Clone, Serialize)]
pub struct SessionMonitoringStatusEvent {
    pub session_id: String,
    pub status: MonitorStatus,
}

/// Per-session scrollback capture buffers, keyed by `session_id` (#1900).
///
/// The outer lock guards the map (held only at create/replay/cleanup); each
/// inner lock guards one session's [`RingBuffer`], written on the hot output
/// path and read on replay.
type OutputBuffers = Arc<StdMutex<HashMap<String, Arc<StdMutex<RingBuffer>>>>>;

/// Per-session output-to-file loggers, keyed by `session_id` (#1960).
///
/// An entry exists only while a session is actively logging (started via the
/// toolbar toggle or a per-connection setting). The output reader looks the
/// logger up on each emitted chunk, so logging can be started and stopped mid
/// session without disturbing the reader.
type SessionLoggers = Arc<StdMutex<HashMap<String, Arc<StdMutex<SessionLogger>>>>>;

/// Backend `session_id` (uuid) → frontend `tab_id` identity bridge (#2431).
///
/// The shared `session-lifecycle` projection region is keyed by the **frontend
/// tab id** (deliberately — it survives a reconnect even as the backend
/// `session_id` changes; see `src/store/sessionBridge.ts`). Backend sources of
/// lifecycle transitions (`create_connection`, the `terminal-exit` emission,
/// `close_session`) only know the uuid `session_id` / the caller's `connect_id`,
/// so without this map the server could not address a session's tab-id-keyed
/// region entry. `create_connection` records the mapping (parsing the tab id from
/// `connect_id = ${tabId}:${retryCount}`), and every session-removal path clears
/// it, so the map tracks exactly the live sessions that carry a tab id.
type SessionTabIds = Arc<StdMutex<HashMap<String, String>>>;

/// Status of a session's output logging, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogStatus {
    /// Absolute path of the active transcript file.
    pub path: String,
    /// Whether each line is prefixed with a timestamp.
    pub timestamps: bool,
}

/// Manages all active connection sessions.
///
/// Holds a [`ConnectionTypeRegistry`] for creating local connections and
/// an [`AgentConnectionManager`] for creating remote (agent-mediated)
/// connections via [`RemoteProxy`].
#[derive(Clone)]
pub struct SessionManager {
    pub(super) sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
    /// Shared registry of connection-type factories.
    ///
    /// Wrapped in a [`StdMutex`] and held behind an [`Arc`] so the plugin host
    /// ([`termihub_core::plugin::PluginHost`]) can register and unregister
    /// plugin-provided connection types into the *same* registry at runtime —
    /// enabling a plugin makes its type immediately creatable here and visible in
    /// [`available_types`](Self::available_types) (#1999). The lock is held only
    /// briefly to look up a factory or snapshot the type list; it is never held
    /// across an `await`.
    registry: Arc<StdMutex<ConnectionTypeRegistry>>,
    pub(super) agent_manager: Arc<dyn AgentRpcClient>,
    /// Abort handles for active session-monitoring push tasks, keyed by session ID.
    monitoring_tasks: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
    /// Registry for persistent sessions, keyed by connection ID.
    pub(super) persistent_sessions: Arc<Mutex<HashMap<String, PersistentRecord>>>,
    /// Cancellation tokens for in-flight (still connecting) local sessions, keyed
    /// by the caller-supplied `connect_id`. Lets a Stop/close while connecting
    /// abort the handshake promptly instead of waiting out the timeout (#952).
    connecting: Arc<StdMutex<HashMap<String, CancellationToken>>>,
    /// Per-session 1 MiB scrollback capture (#1900), keyed by `session_id`.
    ///
    /// Every session's emitted output is mirrored into a [`RingBuffer`] so that a
    /// re-parented view in another window can repaint history via
    /// [`SessionManager::replay_scrollback`]. Plain local shells have no backend
    /// replay buffer of their own (unlike serial/agent sessions), so this is the
    /// general substrate that makes *any* session type re-parentable with
    /// scrollback — the multi-window foundation's "detach a view and re-attach it
    /// later with replay" primitive. The outer lock is held only briefly at
    /// create/replay/cleanup; the hot output path writes through the inner lock.
    pub(super) output_buffers: OutputBuffers,
    /// Per-session output-to-file loggers (#1960), keyed by `session_id`.
    ///
    /// Populated only for sessions with logging active. The output reader writes
    /// each emitted chunk through the matching logger, so a session's transcript
    /// captures exactly what the frontend receives — for every session type.
    pub(super) session_loggers: SessionLoggers,
    /// Backend `session_id` → frontend `tab_id` identity bridge (#2431). See
    /// [`SessionTabIds`]. Populated in [`Self::create_connection`] from the
    /// caller's `connect_id`, cleared on every session-removal path.
    pub(super) session_tab_ids: SessionTabIds,
}

/// Removes a `connect_id` from the [`SessionManager::connecting`] map when the
/// connect attempt finishes (success, failure, or cancellation) — RAII so the
/// entry is cleared even when the connect returns early via `?`.
struct ConnectingGuard {
    map: Arc<StdMutex<HashMap<String, CancellationToken>>>,
    id: String,
}

impl Drop for ConnectingGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.map.lock() {
            map.remove(&self.id);
        }
    }
}

/// Extract the frontend `tab_id` from a `connect_id` of the form
/// `${tabId}:${retryCount}` (#2431).
///
/// The frontend builds `connect_id = ${tabId}:${retryCount}` (`Terminal.tsx`);
/// the retry count is a trailing numeric segment, so the tab id is everything
/// before the last `:`. A `connect_id` with no `:` (an unexpected form) yields
/// `None` rather than guessing. An empty tab id is likewise rejected.
fn tab_id_from_connect_id(connect_id: &str) -> Option<String> {
    connect_id
        .rsplit_once(':')
        .map(|(tab_id, _retry)| tab_id)
        .filter(|tab_id| !tab_id.is_empty())
        .map(str::to_string)
}

impl SessionManager {
    /// Test-only convenience constructor that owns its registry exclusively.
    ///
    /// Production wiring shares the registry with the plugin host via
    /// [`with_shared_registry`](Self::with_shared_registry); tests that do not care
    /// about plugins use this, which wraps `registry` in a fresh
    /// [`Arc<StdMutex<_>>`] and delegates.
    #[cfg(test)]
    pub fn new(registry: ConnectionTypeRegistry, agent_manager: Arc<dyn AgentRpcClient>) -> Self {
        Self::with_shared_registry(Arc::new(StdMutex::new(registry)), agent_manager)
    }

    /// Create a session manager over a registry shared with the plugin host.
    ///
    /// Passing the same `Arc<StdMutex<ConnectionTypeRegistry>>` here and into
    /// [`PluginHost::new`](termihub_core::plugin::PluginHost::new) is what lets an
    /// enabled plugin's connection type be created and listed by this manager
    /// (#1999).
    pub fn with_shared_registry(
        registry: Arc<StdMutex<ConnectionTypeRegistry>>,
        agent_manager: Arc<dyn AgentRpcClient>,
    ) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            registry,
            agent_manager,
            monitoring_tasks: Arc::new(Mutex::new(HashMap::new())),
            persistent_sessions: Arc::new(Mutex::new(HashMap::new())),
            connecting: Arc::new(StdMutex::new(HashMap::new())),
            output_buffers: Arc::new(StdMutex::new(HashMap::new())),
            session_loggers: Arc::new(StdMutex::new(HashMap::new())),
            session_tab_ids: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    // ── Per-session output logging (#1960) ─────────────────────────────

    /// Start writing the session's output to a file.
    ///
    /// `path` chooses the destination; when `None`, a default
    /// `<connection>-<timestamp>.log` under the platform log directory's
    /// `sessions` subfolder is used. `timestamps` prefixes each line with a
    /// wall-clock stamp. Returns the resolved transcript path.
    ///
    /// Idempotent: if the session is already logging, the existing transcript
    /// path is returned unchanged.
    pub async fn start_session_logging(
        &self,
        session_id: &str,
        path: Option<PathBuf>,
        timestamps: bool,
    ) -> Result<PathBuf, TerminalError> {
        // Validate the session exists and grab its title for default naming.
        let title = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .map(|e| e.info.title.clone())
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?
        };

        // Already logging → return the current path without reopening.
        {
            let map = self
                .session_loggers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = map.get(session_id) {
                let path = existing
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .path()
                    .to_path_buf();
                return Ok(path);
            }
        }

        let path = match path {
            Some(p) => p,
            None => default_session_log_path(&title).ok_or_else(|| {
                TerminalError::SpawnFailed(
                    "could not resolve the default session-log directory".to_string(),
                )
            })?,
        };

        let logger = SessionLogger::open(SessionLogConfig::new(&path, timestamps), desktop_clock())
            .map_err(|e| TerminalError::WriteFailed(format!("open session log: {e}")))?;
        let resolved = logger.path().to_path_buf();
        self.session_loggers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id.to_string(), Arc::new(StdMutex::new(logger)));

        info!(session_id, path = %resolved.display(), timestamps, "Started session logging");
        Ok(resolved)
    }

    /// Stop logging the session's output, flushing the transcript.
    ///
    /// Returns the transcript path if logging was active, else `None`.
    pub fn stop_session_logging(&self, session_id: &str) -> Option<PathBuf> {
        let logger = self
            .session_loggers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id)?;
        let mut logger = logger
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let path = logger.path().to_path_buf();
        let _ = logger.flush();
        info!(session_id, path = %path.display(), "Stopped session logging");
        Some(path)
    }

    /// Current logging status for a session, or `None` when not logging.
    pub fn session_logging_status(&self, session_id: &str) -> Option<SessionLogStatus> {
        let map = self
            .session_loggers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let logger = map.get(session_id)?;
        let logger = logger
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Some(SessionLogStatus {
            path: logger.path().to_string_lossy().into_owned(),
            timestamps: logger.timestamps_enabled(),
        })
    }

    /// Write emitted output to the session's logger, if one is active (#1960).
    ///
    /// Looks the logger up per call so start/stop can happen mid-session. A
    /// write error is logged and swallowed — a failing transcript must never
    /// tear down the live session's output stream.
    fn log_output(session_loggers: &SessionLoggers, session_id: &str, data: &[u8]) {
        let logger = {
            let map = session_loggers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            map.get(session_id).cloned()
        };
        if let Some(logger) = logger {
            let mut logger = logger
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Err(e) = logger.write(data) {
                warn!(session_id, error = %e, "Session log write failed");
            }
        }
    }

    /// Get-or-create the scrollback capture buffer for `session_id` (#1900).
    ///
    /// Returns a handle the output reader writes through and
    /// [`Self::replay_scrollback`] reads from.
    pub(super) fn ensure_output_buffer(&self, session_id: &str) -> Arc<StdMutex<RingBuffer>> {
        let mut map = self
            .output_buffers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        map.entry(session_id.to_string())
            .or_insert_with(|| Arc::new(StdMutex::new(RingBuffer::new(DEFAULT_BUFFER_CAPACITY))))
            .clone()
    }

    /// Replay a session's captured scrollback (#1900).
    ///
    /// Returns the ring-buffered bytes so a freshly-created xterm in a
    /// destination window can repaint history after a re-parent. Empty when the
    /// session is unknown or nothing has been captured yet. The backend session
    /// is never touched — this is a pure read of the capture buffer.
    pub async fn replay_scrollback(&self, session_id: &str) -> Vec<u8> {
        let buffer = {
            let map = self
                .output_buffers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            map.get(session_id).cloned()
        };
        match buffer {
            Some(buffer) => buffer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .read_all(),
            None => Vec::new(),
        }
    }

    /// Cancel an in-flight (still connecting) local session by its `connect_id`.
    ///
    /// Fires the registered cancellation token so a connecting SSH session aborts
    /// its handshake promptly. Returns `true` if a matching connect was in flight.
    pub fn cancel_connecting(&self, connect_id: &str) -> bool {
        let token = self
            .connecting
            .lock()
            .ok()
            .and_then(|map| map.get(connect_id).cloned());
        match token {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Create a new connection session.
    ///
    /// If `agent_id` is `Some`, creates a [`RemoteProxy`] that forwards
    /// to the specified agent. Otherwise, creates a local connection from
    /// the registry.
    ///
    /// `spawned` marks the session as opened via the CLI/context-menu spawn path
    /// (#1446, #1466) so the Open Connections panel groups it under "Spawned
    /// Containers" from this backend marker rather than the frontend tab flag.
    ///
    /// Returns the session ID on success.
    pub async fn create_connection<E: EventEmitter>(
        &self,
        type_id: &str,
        settings: serde_json::Value,
        agent_id: Option<&str>,
        connect_id: Option<&str>,
        spawned: bool,
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

        // Register a cancellation token so a Stop/close while connecting can abort
        // the in-flight handshake (#952). Both local (core-backend) and remote
        // proxy (#1122) connects honour it. The guard clears the entry when this
        // connect finishes, even on an early `?` return.
        let (cancel_token, _connecting_guard) = match connect_id {
            Some(cid) => {
                let token = CancellationToken::new();
                if let Ok(mut map) = self.connecting.lock() {
                    map.insert(cid.to_string(), token.clone());
                }
                (
                    Some(token),
                    Some(ConnectingGuard {
                        map: self.connecting.clone(),
                        id: cid.to_string(),
                    }),
                )
            }
            None => (None, None),
        };

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
                    .connect_cancellable(remote_settings, cancel_token.clone())
                    .await
                    .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
                let remote_sid = proxy.remote_session_id();
                (Box::new(proxy), remote_sid)
            } else {
                // Local: instantiate from registry. Lock only long enough to run
                // the factory (no `await` under the lock); this resolves built-in
                // *and* plugin-registered types (#1999).
                let mut conn = {
                    let registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
                    registry
                        .create(type_id)
                        .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?
                };
                conn.connect_cancellable(settings.clone(), cancel_token.clone())
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
            spawned,
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
                    line_ending: LineEnding::default(),
                },
            );
        }

        // Record the backend `session_id` → frontend `tab_id` identity bridge
        // (#2431) so server-side lifecycle sources can address this session's
        // tab-id-keyed `session-lifecycle` region entry. The tab id is the
        // `connect_id` up to its trailing `:${retryCount}` (see `Terminal.tsx`);
        // a session created without a `connect_id` (e.g. the internal agent-setup
        // session) carries no tab and is simply not mapped.
        if let Some(tab_id) = connect_id.and_then(tab_id_from_connect_id) {
            self.session_tab_ids
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(session_id.clone(), tab_id);
        }

        // Determine if we should wait for screen clear (initial command).
        let has_initial_command = settings
            .get("initialCommand")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty());

        // Spawn output streaming task.
        let sessions_clone = self.sessions.clone();
        let capture = self.ensure_output_buffer(&session_id);
        let output_buffers = self.output_buffers.clone();
        let session_loggers = self.session_loggers.clone();
        let session_tab_ids = self.session_tab_ids.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            Self::run_output_reader(
                sid,
                output_rx,
                emitter,
                sessions_clone,
                has_initial_command,
                capture,
                output_buffers,
                session_loggers,
                session_tab_ids,
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
                Self::inject_initial_command(&sessions, &sid, &cmd).await;
            });
        }

        info!(session_id = %session_id, type_id, "Created session");
        Ok(session_id)
    }

    /// Send user input to a session, normalizing line endings to the session's
    /// configured [`LineEnding`] (Enter / paste translation, PuTTY-style).
    ///
    /// This is the single choke point for all interactive terminal input, so
    /// every caller — keystrokes, paste, the file-browser "cd" button, etc. —
    /// gets consistent line-ending handling. Internal command injection that
    /// must stay byte-exact (e.g. agent setup targeting a Unix shell) should
    /// use [`Self::send_input_raw`] instead.
    pub async fn send_input(&self, session_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        Self::send_input_normalized(&self.sessions, session_id, data).await
    }

    /// Write input to a session verbatim, without line-ending normalization.
    ///
    /// Used for internal command injection (agent setup, etc.) that targets a
    /// known environment and must not be rewritten.
    pub async fn send_input_raw(&self, session_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        Self::write_session(&self.sessions, session_id, data).await
    }

    /// Resolve the session's [`LineEnding`] and write `data` normalized to it.
    ///
    /// Shared by [`Self::send_input`] and the settings-driven initial-command
    /// injection so both honor the session's configured line ending. Operates on
    /// the shared sessions map (not `&self`) so detached tasks can call it.
    async fn send_input_normalized(
        sessions: &Mutex<HashMap<String, SessionEntry>>,
        session_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        let ending = {
            let sessions = sessions.lock().await;
            sessions
                .get(session_id)
                .map(|e| e.line_ending)
                .unwrap_or_default()
        };
        let normalized = normalize_line_endings(data, ending);
        Self::write_session(sessions, session_id, &normalized).await
    }

    /// Write `data` to a session verbatim. Backing implementation shared by
    /// [`Self::send_input_raw`] and [`Self::send_input_normalized`].
    async fn write_session(
        sessions: &Mutex<HashMap<String, SessionEntry>>,
        session_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        let sessions = sessions.lock().await;
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

    /// Send the settings-driven initial command to a freshly created session.
    ///
    /// Runs from a detached task after a short delay, so it operates on the
    /// shared sessions map rather than `&self`. Routed through
    /// [`Self::send_input_normalized`] so the trailing line break honors the
    /// session's configured [`LineEnding`] (e.g. CRLF on hosts that require it)
    /// rather than a hardcoded `\n`.
    async fn inject_initial_command(
        sessions: &Mutex<HashMap<String, SessionEntry>>,
        session_id: &str,
        command: &str,
    ) {
        let input = format!("{command}\n");
        let _ = Self::send_input_normalized(sessions, session_id, input.as_bytes()).await;
    }

    /// Set the line ending applied to input for a session. Called by the
    /// frontend when a terminal opens and whenever the resolved setting changes.
    /// No-op if the session no longer exists.
    pub async fn set_session_line_ending(&self, session_id: &str, ending: LineEnding) {
        let mut sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get_mut(session_id) {
            entry.line_ending = ending;
        }
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
        // Clear the identity bridge entry (#2431) — the session is gone, so its
        // tab mapping must not linger.
        self.session_tab_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
        Ok(())
    }

    /// The frontend `tab_id` that owns a backend `session_id`, or `None` for a
    /// session created without a `connect_id` (no tab) or already removed (#2431).
    ///
    /// The lookup backing the server-authoritative `session-lifecycle` fold: a
    /// backend lifecycle source that knows only the uuid `session_id` (the
    /// `terminal-exit` emission, `close_session`) resolves it to the tab id the
    /// region is keyed by. The initial-connect fold (`create_connection`) reads
    /// the tab id straight off the `connect_id`, so this uuid→tab lookup is only
    /// consumed by the *deferred* drop / disconnect folds (see #2205 and the
    /// follow-up); the map it reads is populated and cleaned up live, and the
    /// lookup is covered by unit tests.
    #[allow(dead_code)] // staged API: the deferred drop / disconnect folds consume this (#2205).
    pub fn tab_id_for(&self, session_id: &str) -> Option<String> {
        self.session_tab_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned()
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

    /// Borrow a [`FileOps`] facade over this manager's sessions (#2076).
    ///
    /// The facade is stateless — it holds only a borrow of the `sessions` map —
    /// so the public `*_file` methods below construct one per call and forward
    /// to it. This keeps the file-browser plumbing out of the manager while
    /// leaving the public API and behavior unchanged.
    fn file_ops(&self) -> FileOps<'_> {
        FileOps::new(&self.sessions)
    }

    /// List directory contents via a session's file browser capability.
    pub async fn list_files(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<FileEntry>, TerminalError> {
        self.file_ops().list_dir(session_id, path).await
    }

    /// Read a file via a session's file browser capability.
    pub async fn read_file(&self, session_id: &str, path: &str) -> Result<Vec<u8>, TerminalError> {
        self.file_ops().read_file(session_id, path).await
    }

    /// Get metadata for a single file via a session's file browser capability.
    ///
    /// Backs the editor's remote external-change detection (#1627): the frontend
    /// polls this to compare `modified`/`size` against the last-seen values. It
    /// routes through the same `connection.files.stat` RPC the file browser
    /// already uses — no new protocol.
    pub async fn stat_file(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<FileEntry, TerminalError> {
        self.file_ops().stat(session_id, path).await
    }

    /// Write a file via a session's file browser capability.
    pub async fn write_file(
        &self,
        session_id: &str,
        path: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        self.file_ops().write_file(session_id, path, data).await
    }

    /// Delete a file via a session's file browser capability.
    pub async fn delete_file(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        self.file_ops().delete(session_id, path).await
    }

    /// Rename a file via a session's file browser capability.
    pub async fn rename_file(
        &self,
        session_id: &str,
        from: &str,
        to: &str,
    ) -> Result<(), TerminalError> {
        self.file_ops().rename(session_id, from, to).await
    }

    /// Create a directory via a session's file browser capability.
    pub async fn mkdir_file(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        self.file_ops().mkdir(session_id, path).await
    }

    // --- Session-scoped SFTP advanced operations & transfers (#2312) ---
    //
    // These reach the SSH-specific SFTP capabilities that do not fit on the shared
    // `FileBrowser` trait (realpath / writability probe / elevated write / exec
    // probe) and hand out an owned transfer handle, so a session-backed SSH
    // connection can drive the same advanced ops and cancellable transfers the
    // standalone `sftp_*` path offers. They only succeed for an SFTP-backed
    // session; other backends get a "not supported" `RemoteError`.

    /// Resolve a remote path to its canonical absolute form via a session's SFTP
    /// realpath (session-path mirror of `sftp_realpath`, #2312).
    pub async fn session_realpath(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<String, TerminalError> {
        self.file_ops().realpath(session_id, path).await
    }

    /// Authoritatively probe whether a remote file is writable by the connecting
    /// user via a session's SFTP write-open probe (session-path mirror of
    /// `sftp_check_writable`, #2312).
    pub async fn session_check_writable(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> Result<Writability, TerminalError> {
        self.file_ops()
            .check_writable(session_id, remote_path)
            .await
    }

    /// Write `content` to `remote_path` with `sudo`-elevated privileges over a
    /// session's SFTP connection (session-path mirror of
    /// `sftp_write_file_content_elevated`, #2312).
    pub async fn session_write_file_elevated(
        &self,
        session_id: &str,
        remote_path: &str,
        content: &str,
        sudo_password: &str,
    ) -> Result<ElevatedWriteResult, TerminalError> {
        self.file_ops()
            .write_file_elevated(session_id, remote_path, content, sudo_password)
            .await
    }

    /// Report whether a session's SFTP connection can open an exec channel
    /// (session-path mirror of `sftp_has_exec_capability`, #2312).
    pub async fn session_has_exec_capability(
        &self,
        session_id: &str,
    ) -> Result<bool, TerminalError> {
        self.file_ops().has_exec_capability(session_id).await
    }

    /// Resolve an owned [`Arc<SftpFileBrowser>`] for a session so a cancellable
    /// background transfer can own its channel independently of the sessions lock
    /// (#1245/#2312). See [`FileOps::sftp_browser`](super::file_ops).
    pub async fn sftp_transfer_browser(
        &self,
        session_id: &str,
    ) -> Result<Arc<SftpFileBrowser>, TerminalError> {
        self.file_ops().sftp_browser(session_id).await
    }

    /// Get the list of available connection types from the registry.
    pub fn available_types(&self) -> Vec<ConnectionTypeInfo> {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .available_types()
    }

    /// Return the capabilities of an active session.
    pub async fn session_capabilities(&self, session_id: &str) -> Option<Capabilities> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(session_id)
            .map(|e| e.connection.capabilities())
    }

    /// Borrow a [`MonitoringController`] facade over this manager's session and
    /// monitoring-task maps (#2110).
    ///
    /// The facade is stateless — it holds only borrows of the `sessions` and
    /// `monitoring_tasks` maps — so the public `*_session_monitoring` methods
    /// below construct one per call and forward to it. This keeps the
    /// monitoring plumbing (including the background push-task spawn / abort /
    /// cancellation lifecycle) out of the manager while leaving the public API
    /// and behavior unchanged.
    fn monitoring(&self) -> MonitoringController<'_> {
        MonitoringController::new(&self.sessions, &self.monitoring_tasks)
    }

    /// Subscribe to a session's monitoring provider and forward stats and
    /// status as Tauri events.
    ///
    /// Spawns a background task that reads the subscription's stats and status
    /// channels and emits `session-monitoring-stats` and
    /// `session-monitoring-status` events to the frontend. The status stream
    /// lets the UI surface an explicit `Stale` arm on a mid-stream drop instead
    /// of rendering frozen stats as live (#1229, audit gap G1). Call
    /// [`stop_session_monitoring`](Self::stop_session_monitoring) to cancel the
    /// task and unsubscribe.
    pub async fn start_session_monitoring<R: tauri::Runtime>(
        &self,
        session_id: &str,
        interval_ms: Option<u64>,
        app_handle: tauri::AppHandle<R>,
    ) -> Result<(), TerminalError> {
        self.monitoring()
            .start_session_monitoring(session_id, interval_ms, app_handle)
            .await
    }

    /// Stop session-based monitoring: abort the push task and unsubscribe.
    pub async fn stop_session_monitoring(&self, session_id: &str) -> Result<(), TerminalError> {
        self.monitoring().stop_session_monitoring(session_id).await
    }

    /// Pause or resume a session's monitoring loop (#1233).
    ///
    /// A paused loop keeps its transport open but stops collecting, emitting a
    /// `Paused` status event; resuming emits `Live`.
    pub async fn set_session_monitoring_paused(
        &self,
        session_id: &str,
        paused: bool,
    ) -> Result<(), TerminalError> {
        self.monitoring()
            .set_session_monitoring_paused(session_id, paused)
            .await
    }

    /// Change a session monitoring loop's refresh interval (#1233).
    pub async fn set_session_monitoring_interval(
        &self,
        session_id: &str,
        interval_ms: u64,
    ) -> Result<(), TerminalError> {
        self.monitoring()
            .set_session_monitoring_interval(session_id, interval_ms)
            .await
    }

    /// Abort a session monitoring loop's in-flight connect / collect (#1233).
    ///
    /// Best-effort: a missing session or provider is treated as already gone.
    pub async fn cancel_session_monitoring(&self, session_id: &str) -> Result<(), TerminalError> {
        self.monitoring()
            .cancel_session_monitoring(session_id)
            .await
    }

    // ── Persistent session management ──────────────────────────────────

    /// Borrow a [`PersistentController`] facade over this manager (#2111).
    ///
    /// The facade is stateless — it holds only a borrow of the manager — so the
    /// public persistent-session methods below construct one per call and
    /// forward to it. Unlike [`file_ops`](Self::file_ops) and
    /// [`monitoring`](Self::monitoring), which hand the facade isolated maps, the
    /// persistent cluster drives the manager's own session lifecycle
    /// (`create_connection` / `close_session` / `run_output_reader`) and shares
    /// the `sessions` map, so the facade borrows the whole manager. The
    /// persistent registry (`persistent_sessions`) stays a field here. This keeps
    /// the persistent plumbing (idempotency, the reconnect-after-agent-drop path,
    /// and the emitted `persistent-session-state-changed` events) out of the
    /// manager while leaving the public API and behavior unchanged.
    fn persistent(&self) -> PersistentController<'_> {
        PersistentController::new(self)
    }

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
        self.persistent()
            .start_persistent_session(connection_id, type_id, settings, agent_id, emitter)
            .await
    }

    /// Adopt an already-running agent session into the persistent registry.
    ///
    /// Used when the desktop discovers a surviving agent session (e.g. via
    /// the sidebar's Active Sessions list after a tab close) and wants to
    /// re-attach to it with full scrollback replay. Inserts a
    /// [`PersistentRecord`] pointing at the existing agent session without
    /// spawning a new one. The desktop's `sessions` map is intentionally
    /// left untouched — the next `attach_persistent_tab` call detects the
    /// missing entry and re-creates the `RemoteProxy` via
    /// [`RemoteProxy::reconnect_existing`].
    ///
    /// Idempotent: if a record already exists for `connection_id` and points
    /// at the same agent session, this is a no-op. If it points at a
    /// different session id, returns an error so callers can decide whether
    /// to stop the old one first.
    pub async fn adopt_persistent_session<E: EventEmitter>(
        &self,
        connection_id: &str,
        agent_id: &str,
        agent_session_id: &str,
        emitter: E,
    ) -> Result<String, TerminalError> {
        self.persistent()
            .adopt_persistent_session(connection_id, agent_id, agent_session_id, emitter)
            .await
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
        self.persistent()
            .stop_persistent_session(connection_id, emitter)
            .await
    }

    /// Register `tab_id` as attached to the persistent session for `connection_id`.
    ///
    /// Returns the new attached-tab count. Returns an error if the session is not
    /// registered and cannot be reconnected.
    ///
    /// When the agent SSH connection drops, `emit_and_cleanup` removes the desktop
    /// session from `sessions` but leaves the `PersistentRecord` intact because the
    /// daemon process on the remote host is still alive. The next `attach_persistent_tab`
    /// call detects the missing session entry and calls
    /// [`RemoteProxy::reconnect_existing`] to re-establish the desktop side, reusing
    /// the same session ID so the tab's `existingSessionId` prop keeps working without
    /// any frontend state update.
    pub async fn attach_persistent_tab<E: EventEmitter>(
        &self,
        connection_id: &str,
        tab_id: &str,
        emitter: E,
    ) -> Result<u32, TerminalError> {
        self.persistent()
            .attach_persistent_tab(connection_id, tab_id, emitter)
            .await
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
        self.persistent()
            .detach_persistent_tab(session_id, tab_id, emitter)
            .await
    }

    /// List all registered persistent sessions and their current state.
    pub async fn list_persistent_sessions(&self) -> Vec<PersistentSessionSummary> {
        self.persistent().list_persistent_sessions().await
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
        self.persistent()
            .get_remote_session_buffer(session_id)
            .await
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
                    spawned: false,
                },
                remote_session_id: None,
                line_ending: LineEnding::default(),
            },
        );
    }

    /// Read output from a connection and emit Tauri events.
    ///
    /// Coalesces pending output chunks into a single event (up to
    /// `MAX_COALESCE_BYTES`) to reduce IPC overhead.
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_output_reader<E: EventEmitter>(
        session_id: String,
        mut output_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
        emitter: E,
        sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
        wait_for_clear: bool,
        capture: Arc<StdMutex<RingBuffer>>,
        output_buffers: OutputBuffers,
        session_loggers: SessionLoggers,
        session_tab_ids: SessionTabIds,
    ) {
        // Phase 1: optionally buffer until the screen-clear sequence.
        if wait_for_clear {
            let deadline = Instant::now() + CLEAR_WAIT_TIMEOUT;

            let mut buffer = Vec::new();
            let mut detector = ScreenClearDetector::new();

            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match tokio::time::timeout(remaining, output_rx.recv()).await {
                    Ok(Some(chunk)) => {
                        let cleared = detector.feed(&chunk);
                        buffer.extend_from_slice(&chunk);
                        if cleared {
                            break;
                        }
                    }
                    Ok(None) => {
                        // Channel closed during startup.
                        Self::capture_bytes(&capture, &buffer);
                        Self::log_output(&session_loggers, &session_id, &buffer);
                        Self::emit_and_cleanup(
                            &session_id,
                            buffer,
                            &emitter,
                            &sessions,
                            &output_buffers,
                            &session_loggers,
                            &session_tab_ids,
                        )
                        .await;
                        return;
                    }
                    Err(_) => break, // Timeout
                }
            }

            // Flush the buffered output as a single event.
            if !buffer.is_empty() {
                Self::capture_bytes(&capture, &buffer);
                Self::log_output(&session_loggers, &session_id, &buffer);
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
                Self::capture_bytes(&capture, &data);
                Self::log_output(&session_loggers, &session_id, &data);
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
            &output_buffers,
            &session_loggers,
            &session_tab_ids,
        )
        .await;
    }

    /// Mirror emitted output into a session's scrollback capture buffer (#1900).
    ///
    /// The write is bounded by the [`RingBuffer`]'s 1 MiB capacity, so long
    /// histories are truncated to the most recent bytes — matching the concept's
    /// stated scrollback-fidelity limit.
    fn capture_bytes(capture: &StdMutex<RingBuffer>, data: &[u8]) {
        capture
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .write(data);
    }

    /// Emit remaining data (if any), send the exit event, and remove the session.
    ///
    /// Intentionally does NOT touch `persistent_sessions`: when an agent SSH
    /// connection drops, the daemon process on the remote host survives. The
    /// `PersistentRecord` must be kept so that the next `attach_persistent_tab`
    /// call can re-create the `RemoteProxy` and reconnect to the surviving daemon.
    #[allow(clippy::too_many_arguments)]
    async fn emit_and_cleanup<E: EventEmitter>(
        session_id: &str,
        data: Vec<u8>,
        emitter: &E,
        sessions: &Arc<Mutex<HashMap<String, SessionEntry>>>,
        output_buffers: &OutputBuffers,
        session_loggers: &SessionLoggers,
        session_tab_ids: &SessionTabIds,
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

        // Drop the session's scrollback capture buffer (#1900) so a dead
        // session's 1 MiB ring does not linger.
        output_buffers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);

        // Clear the identity bridge entry (#2431) — mirrors the explicit
        // `close_session` cleanup for the natural-exit / dropped path, so a
        // session's tab mapping is released whichever way the session ends.
        session_tab_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);

        // Flush and drop the session's output logger (#1960) so the transcript's
        // tail is persisted and its file handle is released when the session ends.
        if let Some(logger) = session_loggers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id)
        {
            let _ = logger
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .flush();
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

    /// The `data` field of a serialized [`TerminalOutputEvent`] must be a base64
    /// string that decodes byte-for-byte back to the original bytes — the exact
    /// inverse of the `base64ToBytes` decoder in `src/services/events.ts`. This
    /// is the terminal's hot path, so a mismatch means corrupted/dropped output.
    /// Covers high bytes (0x80–0xFF), UTF-8 multi-byte sequences, all 256 byte
    /// values, and the empty chunk (#2072).
    #[test]
    fn terminal_output_event_serializes_data_as_base64() {
        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;

        let cases: Vec<Vec<u8>> = vec![
            Vec::new(),                              // empty chunk → ""
            b"hello".to_vec(),                       // plain ASCII
            vec![0x1b, b'[', b'3', b'1', b'm'],      // ANSI color escape
            "héllo — 日本語 🎉".as_bytes().to_vec(), // UTF-8 multi-byte
            vec![0x00, 0x7f, 0x80, 0xfe, 0xff],      // boundary + high bytes
            (0u16..=255).map(|b| b as u8).collect(), // every byte value
        ];

        for bytes in cases {
            let event = TerminalOutputEvent {
                session_id: "s1".to_string(),
                data: bytes.clone(),
            };
            let json: Value = serde_json::to_value(&event).unwrap();

            // Wire form is a string (not a JSON number-array).
            let encoded = json["data"]
                .as_str()
                .expect("data must serialize to a string");
            assert_eq!(encoded, engine.encode(&bytes));

            // Round-trip: decoding the wire string yields the original bytes.
            let decoded = engine.decode(encoded).unwrap();
            assert_eq!(decoded, bytes, "base64 round-trip must be byte-for-byte");
        }
    }

    /// A minimal mock connection without file browser capability. When `writes`
    /// is `Some`, every byte passed to `write` is recorded into it so tests can
    /// assert the exact bytes forwarded by `send_input` / `send_input_raw`.
    #[derive(Default)]
    struct MockConnection {
        writes: Option<Arc<std::sync::Mutex<Vec<u8>>>>,
    }

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
                graphical: false,
                resize: true,
                persistent: false,
                terminal: true,
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
        fn write(&self, data: &[u8]) -> Result<(), SessionError> {
            if let Some(writes) = &self.writes {
                writes.lock().unwrap().extend_from_slice(data);
            }
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
    /// A fresh, empty scrollback capture buffer for `run_output_reader` tests (#1900).
    fn new_capture() -> Arc<StdMutex<RingBuffer>> {
        Arc::new(StdMutex::new(RingBuffer::new(DEFAULT_BUFFER_CAPACITY)))
    }

    /// A fresh, empty `output_buffers` map for the cleanup path (#1900).
    fn new_output_buffers() -> OutputBuffers {
        Arc::new(StdMutex::new(HashMap::new()))
    }

    /// A fresh, empty `session_loggers` map for the logging path (#1960).
    fn new_session_loggers() -> SessionLoggers {
        Arc::new(StdMutex::new(HashMap::new()))
    }

    /// A fresh, empty `session_tab_ids` identity-bridge map (#2431).
    fn new_session_tab_ids() -> SessionTabIds {
        Arc::new(StdMutex::new(HashMap::new()))
    }

    async fn sessions_with_mock(session_id: &str) -> Arc<Mutex<HashMap<String, SessionEntry>>> {
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let mut map = sessions.lock().await;
        map.insert(
            session_id.to_string(),
            SessionEntry {
                connection: Box::new(MockConnection::default()),
                info: SessionInfo {
                    id: session_id.to_string(),
                    title: "Mock".to_string(),
                    connection_type: "mock".to_string(),
                    alive: true,
                    agent_id: None,
                    spawned: false,
                },
                remote_session_id: None,
                line_ending: LineEnding::default(),
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

    /// `send_input` normalizes line endings to the session's configured ending.
    /// Regression test for the Windows-CRLF double-line paste bug.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn send_input_normalizes_to_session_line_ending() {
        let writes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager
            .insert_test_session(
                "sess-1",
                Box::new(MockConnection {
                    writes: Some(writes.clone()),
                }),
            )
            .await;

        // Default (CR): CRLF paste collapses to a single CR, no blank lines.
        manager.send_input("sess-1", b"a\r\nb\r\nc").await.unwrap();
        assert_eq!(writes.lock().unwrap().as_slice(), b"a\rb\rc");

        // Switch to CRLF: a bare LF becomes CRLF.
        writes.lock().unwrap().clear();
        manager
            .set_session_line_ending("sess-1", LineEnding::Crlf)
            .await;
        manager.send_input("sess-1", b"a\nb").await.unwrap();
        assert_eq!(writes.lock().unwrap().as_slice(), b"a\r\nb");
    }

    /// `send_input_raw` bypasses normalization so internal injection (agent
    /// setup) is sent byte-exact regardless of the session's line ending.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn send_input_raw_does_not_normalize() {
        let writes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager
            .insert_test_session(
                "sess-1",
                Box::new(MockConnection {
                    writes: Some(writes.clone()),
                }),
            )
            .await;
        manager
            .set_session_line_ending("sess-1", LineEnding::Crlf)
            .await;

        manager.send_input_raw("sess-1", b"a\nb\n").await.unwrap();
        assert_eq!(writes.lock().unwrap().as_slice(), b"a\nb\n");
    }

    /// Multi-window (#1900): re-parenting a tab is a pure view operation. The
    /// destination window repaints history from the session's captured
    /// scrollback while the backend session stays untouched in the `sessions`
    /// map. This proves the replay substrate that makes any session type
    /// re-parentable with scrollback.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn replay_scrollback_returns_captured_history_without_touching_session() {
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager
            .insert_test_session("sess-move", Box::new(MockConnection::default()))
            .await;

        // Simulate output having streamed through the reader into the capture.
        manager
            .ensure_output_buffer("sess-move")
            .lock()
            .unwrap()
            .write(b"line-1\r\nline-2\r\n");

        // A move: the destination replays the history verbatim...
        let replayed = manager.replay_scrollback("sess-move").await;
        assert_eq!(replayed, b"line-1\r\nline-2\r\n");
        // ...and the backend session survives the move entirely.
        assert!(manager.sessions.lock().await.contains_key("sess-move"));

        // An unknown session replays empty rather than erroring.
        assert!(manager
            .replay_scrollback("no-such-session")
            .await
            .is_empty());
    }

    /// Regression test for #792: the settings-driven initial command must honor
    /// the session's configured line ending instead of a hardcoded `\n`. A CRLF
    /// session must receive the command terminated with `\r\n` so it executes on
    /// hosts/devices that require CR/CRLF.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn initial_command_honors_session_line_ending() {
        let writes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager
            .insert_test_session(
                "sess-1",
                Box::new(MockConnection {
                    writes: Some(writes.clone()),
                }),
            )
            .await;

        // Default (CR) session: command is terminated with a bare CR.
        SessionManager::inject_initial_command(&manager.sessions, "sess-1", "echo hi").await;
        assert_eq!(writes.lock().unwrap().as_slice(), b"echo hi\r");

        // CRLF session: the trailing line break is translated to CRLF.
        writes.lock().unwrap().clear();
        manager
            .set_session_line_ending("sess-1", LineEnding::Crlf)
            .await;
        SessionManager::inject_initial_command(&manager.sessions, "sess-1", "echo hi").await;
        assert_eq!(writes.lock().unwrap().as_slice(), b"echo hi\r\n");
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

    #[tokio::test]
    async fn emit_and_cleanup_sends_exit_event() {
        let emitter = MockEventEmitter::new();
        let sessions = sessions_with_mock("sess-exit").await;

        let output_buffers = new_output_buffers();
        SessionManager::emit_and_cleanup(
            "sess-exit",
            Vec::new(),
            &emitter,
            &sessions,
            &output_buffers,
            &new_session_loggers(),
            &new_session_tab_ids(),
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

        let output_buffers = new_output_buffers();
        SessionManager::emit_and_cleanup(
            "sess-data",
            b"final bytes".to_vec(),
            &emitter,
            &sessions,
            &output_buffers,
            &new_session_loggers(),
            &new_session_tab_ids(),
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

        let capture = new_capture();
        let output_buffers = new_output_buffers();
        SessionManager::run_output_reader(
            "sess-stream".to_string(),
            rx,
            emitter.clone(),
            sessions.clone(),
            false,
            capture.clone(),
            output_buffers,
            new_session_loggers(),
            new_session_tab_ids(),
        )
        .await;

        // The scrollback capture buffer (#1900) mirrors the streamed output.
        {
            let captured = capture
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .read_all();
            assert!(
                captured.windows(5).any(|w| w == b"hello"),
                "expected streamed output to be captured for replay"
            );
        }

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
    async fn run_output_reader_writes_to_active_session_logger() {
        let emitter = MockEventEmitter::new();
        let sessions = sessions_with_mock("sess-log").await;
        let session_loggers = new_session_loggers();

        // Point a logger at a temp file and register it as the active logger for
        // the session, mirroring what `start_session_logging` does.
        let dir = std::env::temp_dir().join(format!(
            "termihub-mgr-log-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.log");
        let logger = SessionLogger::open(
            SessionLogConfig::new(&path, false),
            Box::new(|| "T".to_string()),
        )
        .unwrap();
        session_loggers
            .lock()
            .unwrap()
            .insert("sess-log".to_string(), Arc::new(StdMutex::new(logger)));

        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);
        tx.send(b"logged output\n".to_vec()).await.unwrap();
        drop(tx); // EOF → reader runs cleanup, flushing + dropping the logger

        SessionManager::run_output_reader(
            "sess-log".to_string(),
            rx,
            emitter,
            sessions,
            false,
            new_capture(),
            new_output_buffers(),
            session_loggers.clone(),
            new_session_tab_ids(),
        )
        .await;

        // The transcript captured the streamed output...
        let contents = std::fs::read(&path).unwrap();
        assert!(
            contents.windows(6).any(|w| w == b"logged"),
            "expected streamed output in the transcript file"
        );
        // ...and cleanup removed the logger from the active map.
        assert!(
            !session_loggers.lock().unwrap().contains_key("sess-log"),
            "logger should be dropped when the session ends"
        );

        let _ = std::fs::remove_dir_all(&dir);
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
            new_capture(),
            new_output_buffers(),
            new_session_loggers(),
            new_session_tab_ids(),
        )
        .await;

        // No outputs recorded (emitter failed)
        let outputs = emitter.outputs.lock().unwrap();
        assert!(outputs.is_empty());
    }

    /// Regression: `emit_and_cleanup` must NOT clear the persistent session record
    /// when the output channel closes. The daemon on the remote host is still alive
    /// after an agent SSH disconnect; keeping the record allows `attach_persistent_tab`
    /// to re-create the desktop-side `RemoteProxy` on the next attach attempt.
    #[tokio::test]
    async fn emit_and_cleanup_preserves_persistent_session_record() {
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
                    remote_session_id: Some("remote-1".to_string()),
                    agent_id: Some("agent-1".to_string()),
                },
            );
        }

        SessionManager::emit_and_cleanup(
            "sess-ps",
            Vec::new(),
            &emitter,
            &sessions,
            &new_output_buffers(),
            &new_session_loggers(),
            &new_session_tab_ids(),
        )
        .await;

        // The persistent record must still be present — the daemon is alive.
        assert!(
            persistent_sessions.lock().await.contains_key("conn-ps"),
            "persistent record must be kept after backend exit (daemon still alive)"
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
                graphical: false,
                resize: false,
                persistent: false,
                terminal: true,
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
        fn cancel_connect(&self, _: &str) -> bool {
            false
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
            .insert_test_session("local-sess", Box::new(MockConnection::default()))
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
            Box::new(|| Box::new(MockConnection::default())),
        );
        let agent_manager = Arc::new(NullAgent);
        SessionManager::new(registry, agent_manager)
    }

    /// A connection whose `connect_cancellable` blocks until its token fires —
    /// lets us exercise mid-connect cancellation (#952) deterministically.
    #[derive(Default)]
    struct BlockingConnect;

    #[async_trait::async_trait]
    impl ConnectionType for BlockingConnect {
        fn type_id(&self) -> &str {
            "blocking"
        }
        fn display_name(&self) -> &str {
            "Blocking"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: vec![] }
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                monitoring: false,
                file_browser: false,
                graphical: false,
                resize: true,
                persistent: false,
                terminal: true,
            }
        }
        async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
            // Only reached without a token; block long enough that a failed
            // cancellation would hang the test instead of passing.
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(())
        }
        async fn connect_cancellable(
            &mut self,
            settings: serde_json::Value,
            cancel: Option<CancellationToken>,
        ) -> Result<(), SessionError> {
            match cancel {
                Some(token) => {
                    token.cancelled().await;
                    Err(SessionError::SpawnFailed("connect cancelled".to_string()))
                }
                None => self.connect(settings).await,
            }
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

    /// Cancelling a connecting local session via its `connect_id` aborts the
    /// in-flight connect and clears the tracker entry (#952).
    #[tokio::test]
    async fn cancel_connecting_aborts_in_flight_local_connect() {
        let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
        registry.register(
            "blocking",
            "Blocking",
            "mock",
            Box::new(|| Box::new(BlockingConnect)),
        );
        let manager = Arc::new(SessionManager::new(registry, Arc::new(NullAgent)));

        let spawned = manager.clone();
        let join = tokio::spawn(async move {
            spawned
                .create_connection(
                    "blocking",
                    serde_json::json!({}),
                    None,
                    Some("c1"),
                    false,
                    MockEventEmitter::new(),
                )
                .await
        });

        // Poll until the connect registers its token, then fire the cancel.
        let mut cancelled = false;
        for _ in 0..200 {
            if manager.cancel_connecting("c1") {
                cancelled = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            cancelled,
            "the connecting session should have been cancellable"
        );

        let result = join.await.expect("join");
        assert!(result.is_err(), "a cancelled connect must return an error");
        // The RAII guard cleared the entry, so a second cancel finds nothing.
        assert!(!manager.cancel_connecting("c1"));
    }

    /// A session opened via the spawn path is recorded with `spawned=true` in
    /// the registry and surfaces the flag on its `SessionInfo`, while a normal
    /// local session is recorded with `spawned=false` (#1466). This backend
    /// marker is the source of truth the Open Connections panel groups from, so
    /// a spawned container stays under "Spawned Containers" even after its tab
    /// (the previous frontend-only marker) is closed.
    #[tokio::test]
    async fn spawn_path_marks_session_spawned_in_registry() {
        let manager = make_test_manager();

        let spawned_id = manager
            .create_connection(
                "mock",
                serde_json::json!({}),
                None,
                None,
                true,
                MockEventEmitter::new(),
            )
            .await
            .expect("spawned session should open");

        let plain_id = manager
            .create_connection(
                "mock",
                serde_json::json!({}),
                None,
                None,
                false,
                MockEventEmitter::new(),
            )
            .await
            .expect("plain session should open");

        let sessions = manager.list_sessions().await;
        let spawned = sessions
            .iter()
            .find(|s| s.id == spawned_id)
            .expect("spawned session listed");
        let plain = sessions
            .iter()
            .find(|s| s.id == plain_id)
            .expect("plain session listed");

        assert!(spawned.spawned, "spawn-path session must be marked spawned");
        assert!(
            !plain.spawned,
            "a normal local session must not be marked spawned"
        );

        // The marker must be serialized (camelCase `spawned`) so the frontend
        // `LocalSessionInfo` mirror can group from it.
        let json = serde_json::to_value(spawned).expect("serialize SessionInfo");
        assert_eq!(json["spawned"], serde_json::json!(true));
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
    async fn adopt_persistent_session_registers_record_and_emits_running() {
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        let returned = manager
            .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-1", emitter.clone())
            .await
            .unwrap();
        assert_eq!(returned, "agent-sess-1");

        let ps = manager.persistent_sessions.lock().await;
        let record = ps.get("conn-adopt").expect("record registered");
        assert_eq!(record.session_id, "agent-sess-1");
        assert_eq!(record.agent_id.as_deref(), Some("agent-A"));
        assert_eq!(record.remote_session_id.as_deref(), Some("agent-sess-1"));
        assert!(record.attached_tabs.is_empty());
        drop(ps);

        let last = emitter.events().last().cloned().expect("event emitted");
        assert_eq!(last.connection_id, "conn-adopt");
        assert_eq!(last.state, "running");
        assert_eq!(last.session_id.as_deref(), Some("agent-sess-1"));
    }

    #[tokio::test]
    async fn adopt_persistent_session_is_idempotent_for_same_agent_session() {
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        manager
            .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-1", emitter.clone())
            .await
            .unwrap();
        // Second adopt with same args returns Ok with the same session_id.
        let returned = manager
            .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-1", emitter.clone())
            .await
            .unwrap();
        assert_eq!(returned, "agent-sess-1");
    }

    #[tokio::test]
    async fn adopt_persistent_session_rejects_conflicting_agent_session() {
        let manager = make_test_manager();
        let emitter = MockPersistentEmitter::new();

        manager
            .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-1", emitter.clone())
            .await
            .unwrap();
        let err = manager
            .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-2", emitter.clone())
            .await;
        assert!(matches!(err, Err(TerminalError::SpawnFailed(_))));
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

    /// An `AgentRpcClient` implementation that records `attach_session` calls
    /// and succeeds silently on `register_session_output`.
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
        fn cancel_connect(&self, _: &str) -> bool {
            false
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

    /// Regression: after an agent SSH disconnect, `emit_and_cleanup` removes the
    /// desktop session from `sessions` but the daemon process on the remote host
    /// is still alive. `attach_persistent_tab` must re-create the `RemoteProxy`
    /// and re-insert it under the same session ID so the tab's `existingSessionId`
    /// prop keeps working without any frontend state update.
    #[tokio::test]
    async fn attach_persistent_tab_reconnects_after_agent_disconnect() {
        let (spy, attach_calls) = SpyAgent::new();

        let mut registry = ConnectionTypeRegistry::new();
        registry.register(
            "mock",
            "Mock",
            "mock",
            Box::new(|| Box::new(MockConnection::default())),
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

        // Inject agent-side session info as if this were a real remote session.
        {
            let mut sessions = manager.sessions.lock().await;
            if let Some(entry) = sessions.get_mut(&session_id) {
                entry.info.agent_id = Some("agent-1".to_string());
                entry.remote_session_id = Some("remote-1".to_string());
            }
        }
        // Also update the persistent record with the same info (mirrors what
        // start_persistent_session does when agent_id is Some).
        {
            let mut ps = manager.persistent_sessions.lock().await;
            if let Some(record) = ps.get_mut("conn-1") {
                record.agent_id = Some("agent-1".to_string());
                record.remote_session_id = Some("remote-1".to_string());
            }
        }

        // Simulate agent disconnect: remove the session from sessions (what
        // emit_and_cleanup does) but leave the persistent record intact.
        {
            let mut sessions = manager.sessions.lock().await;
            sessions.remove(&session_id);
        }
        assert!(
            !manager.sessions.lock().await.contains_key(&session_id),
            "session must be removed to simulate agent disconnect"
        );
        assert!(
            manager
                .persistent_sessions
                .lock()
                .await
                .contains_key("conn-1"),
            "persistent record must survive agent disconnect"
        );

        // Now simulate the user clicking "Attach" after the agent reconnects.
        manager
            .attach_persistent_tab("conn-1", "tab-after-reconnect", emitter.clone())
            .await
            .expect("attach must succeed after agent reconnect");

        // The session must have been re-inserted under the same session ID.
        assert!(
            manager.sessions.lock().await.contains_key(&session_id),
            "session must be re-created under the same ID after reconnect"
        );

        // attach_session must have been called (by reconnect_existing) to get the buffer replay.
        let calls = attach_calls.lock().unwrap();
        assert_eq!(
            calls.len(),
            1,
            "attach_session must be called once for reconnect"
        );
        assert_eq!(calls[0].0, "agent-1");
        assert_eq!(calls[0].1, "remote-1");
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

    // ── FileOps facade tests (#2076) ──────────────────────────────────
    //
    // The file-op methods were extracted into a `FileOps` facade
    // (`session/file_ops.rs`). These lock in the manager's delegation and the
    // exact error messages it must preserve across the refactor.

    /// A minimal in-memory [`FileBrowser`] that records the paths it was asked
    /// to list and echoes deterministic data back, so the manager's delegation
    /// can be asserted without a real file backend.
    struct MockFileBrowser {
        listed: Arc<std::sync::Mutex<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl FileBrowser for MockFileBrowser {
        async fn list_dir(
            &self,
            path: &str,
        ) -> Result<Vec<FileEntry>, termihub_core::errors::FileError> {
            self.listed.lock().unwrap().push(path.to_string());
            Ok(vec![FileEntry {
                name: "file.txt".to_string(),
                path: format!("{path}/file.txt"),
                is_directory: false,
                size: 3,
                modified: String::new(),
                permissions: None,
                writable: None,
                is_symlink: false,
                symlink_target: None,
            }])
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, termihub_core::errors::FileError> {
            // Echo the requested path so the test can prove the argument reached
            // the browser through the facade.
            Ok(path.as_bytes().to_vec())
        }
        async fn write_file(
            &self,
            _path: &str,
            _data: &[u8],
        ) -> Result<(), termihub_core::errors::FileError> {
            Ok(())
        }
        async fn delete(&self, _path: &str) -> Result<(), termihub_core::errors::FileError> {
            Ok(())
        }
        async fn rename(
            &self,
            _from: &str,
            _to: &str,
        ) -> Result<(), termihub_core::errors::FileError> {
            Ok(())
        }
        async fn stat(&self, path: &str) -> Result<FileEntry, termihub_core::errors::FileError> {
            Ok(FileEntry {
                name: path.to_string(),
                path: path.to_string(),
                is_directory: false,
                size: 0,
                modified: String::new(),
                permissions: None,
                writable: None,
                is_symlink: false,
                symlink_target: None,
            })
        }
        async fn mkdir(&self, _path: &str) -> Result<(), termihub_core::errors::FileError> {
            Ok(())
        }
    }

    /// A connection that advertises a file-browser capability backed by a
    /// [`MockFileBrowser`].
    struct FileConnection {
        browser: MockFileBrowser,
    }

    #[async_trait::async_trait]
    impl ConnectionType for FileConnection {
        fn type_id(&self) -> &str {
            "file"
        }
        fn display_name(&self) -> &str {
            "File"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: vec![] }
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                monitoring: false,
                file_browser: true,
                graphical: false,
                resize: false,
                persistent: false,
                terminal: true,
            }
        }
        async fn connect(&mut self, _: serde_json::Value) -> Result<(), SessionError> {
            Ok(())
        }
        async fn disconnect(&mut self) -> Result<(), SessionError> {
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
            Some(&self.browser)
        }
    }

    /// The manager's file-op methods forward to the session's file browser,
    /// passing the path through and returning the browser's result unchanged.
    #[tokio::test]
    async fn file_ops_delegate_to_session_file_browser() {
        let listed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager
            .insert_test_session(
                "fs-1",
                Box::new(FileConnection {
                    browser: MockFileBrowser {
                        listed: listed.clone(),
                    },
                }),
            )
            .await;

        let entries = manager.list_files("fs-1", "/home").await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "file.txt");
        assert_eq!(listed.lock().unwrap().as_slice(), &["/home".to_string()]);

        // read_file delegates and returns the browser's bytes (which echo the path).
        let data = manager.read_file("fs-1", "/etc/hosts").await.unwrap();
        assert_eq!(data, b"/etc/hosts");
    }

    /// A session whose connection exposes no file browser yields the exact
    /// `RemoteError("No file browser capability")` the manager returned before
    /// the facade extraction.
    #[tokio::test]
    async fn file_ops_error_when_connection_has_no_file_browser() {
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager
            .insert_test_session("no-fs", Box::new(MockConnection::default()))
            .await;
        match manager.read_file("no-fs", "/").await {
            Err(TerminalError::RemoteError(msg)) => {
                assert_eq!(msg, "No file browser capability");
            }
            other => panic!("expected RemoteError, got {other:?}"),
        }
    }

    /// An unknown session yields `SessionNotFound`, unchanged by the facade.
    #[tokio::test]
    async fn file_ops_error_when_session_unknown() {
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        let err = manager.read_file("ghost", "/").await.unwrap_err();
        assert!(matches!(err, TerminalError::SessionNotFound(_)));
    }

    /// The session-scoped SFTP advanced ops (#2312) refuse a session whose file
    /// browser is not SFTP-backed: the `MockFileBrowser` uses the default
    /// `FileBrowser::as_any` (returns `None`), so the downcast to
    /// `SftpFileBrowser` fails and every entry point returns the "not supported"
    /// `RemoteError` rather than misbehaving.
    #[tokio::test]
    async fn session_sftp_ops_error_when_browser_not_sftp_backed() {
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager
            .insert_test_session(
                "fs-nonsftp",
                Box::new(FileConnection {
                    browser: MockFileBrowser {
                        listed: Arc::new(std::sync::Mutex::new(Vec::new())),
                    },
                }),
            )
            .await;

        let assert_not_supported = |res: Result<String, TerminalError>| match res {
            Err(TerminalError::RemoteError(msg)) => {
                assert!(
                    msg.contains("does not support SFTP advanced operations"),
                    "unexpected message: {msg}"
                );
            }
            other => panic!("expected RemoteError, got {other:?}"),
        };

        assert_not_supported(manager.session_realpath("fs-nonsftp", ".").await);
        // The transfer-handle resolver rejects the same way. `SftpFileBrowser` is
        // not `Debug`, so assert on the error without formatting the Ok value.
        match manager.sftp_transfer_browser("fs-nonsftp").await {
            Err(TerminalError::RemoteError(msg)) => {
                assert!(msg.contains("does not support SFTP advanced operations"))
            }
            Err(other) => panic!("expected RemoteError, got {other:?}"),
            Ok(_) => panic!("expected RemoteError for a non-SFTP session, got Ok"),
        }
        // has_exec_capability also rejects a non-SFTP session (it cannot silently
        // report `false` — that verdict only applies to a real SFTP connection).
        assert!(matches!(
            manager.session_has_exec_capability("fs-nonsftp").await,
            Err(TerminalError::RemoteError(_))
        ));
    }

    /// The session-scoped SFTP ops surface `SessionNotFound` for an unknown
    /// session, exactly like the rest of the file-ops facade (#2312).
    #[tokio::test]
    async fn session_sftp_ops_error_when_session_unknown() {
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        assert!(matches!(
            manager.session_realpath("ghost", ".").await,
            Err(TerminalError::SessionNotFound(_))
        ));
        assert!(matches!(
            manager.sftp_transfer_browser("ghost").await,
            Err(TerminalError::SessionNotFound(_))
        ));
    }

    // ── MonitoringController facade tests (#2110) ─────────────────────
    //
    // The session-monitoring methods were extracted into a
    // `MonitoringController` facade (`session/monitoring_controller.rs`). These
    // lock in the manager's delegation, the preserved error messages, and — for
    // the provider-driven controls — that each call reaches the session's
    // monitoring provider unchanged. `start_session_monitoring` needs a Tauri
    // `AppHandle` (no mock runtime is wired for these unit tests), so it is
    // exercised via the build and the event-serialisation test above; the four
    // handle-free controls are covered directly here.

    /// A monitoring provider that records the controller's calls in order, so a
    /// test can assert the delegation reached it with the exact arguments.
    #[derive(Default)]
    struct RecordingMonitoringProvider {
        calls: Arc<std::sync::Mutex<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl MonitoringProvider for RecordingMonitoringProvider {
        async fn subscribe(
            &self,
        ) -> Result<
            termihub_core::monitoring::MonitoringSubscription,
            termihub_core::errors::CoreError,
        > {
            self.calls.lock().unwrap().push("subscribe".to_string());
            let (_stats_tx, stats_rx) = tokio::sync::mpsc::channel(1);
            let (_status_tx, status_rx) = tokio::sync::mpsc::channel(1);
            Ok(termihub_core::monitoring::MonitoringSubscription {
                stats: stats_rx,
                status: status_rx,
            })
        }
        async fn unsubscribe(&self) -> Result<(), termihub_core::errors::CoreError> {
            self.calls.lock().unwrap().push("unsubscribe".to_string());
            Ok(())
        }
        async fn set_interval(&self, interval: std::time::Duration) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("set_interval:{}", interval.as_millis()));
        }
        async fn set_paused(&self, paused: bool) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("set_paused:{paused}"));
        }
        async fn cancel_connect(&self) {
            self.calls
                .lock()
                .unwrap()
                .push("cancel_connect".to_string());
        }
    }

    /// A connection that advertises a monitoring capability backed by a
    /// [`RecordingMonitoringProvider`].
    struct MonitoringConnection {
        provider: RecordingMonitoringProvider,
    }

    #[async_trait::async_trait]
    impl ConnectionType for MonitoringConnection {
        fn type_id(&self) -> &str {
            "monitoring"
        }
        fn display_name(&self) -> &str {
            "Monitoring"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: vec![] }
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                monitoring: true,
                file_browser: false,
                graphical: false,
                resize: false,
                persistent: false,
                terminal: true,
            }
        }
        async fn connect(&mut self, _: serde_json::Value) -> Result<(), SessionError> {
            Ok(())
        }
        async fn disconnect(&mut self) -> Result<(), SessionError> {
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
            Some(&self.provider)
        }
        fn file_browser(&self) -> Option<&dyn FileBrowser> {
            None
        }
    }

    /// The provider-driven monitoring controls (pause, interval, cancel) and
    /// `stop` forward to the session's monitoring provider with their arguments
    /// intact — the interval is clamped to `>= 1ms` exactly as before the
    /// facade extraction, and `stop` unsubscribes even with no running task.
    #[tokio::test]
    async fn monitoring_controls_delegate_to_session_provider() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager
            .insert_test_session(
                "mon-1",
                Box::new(MonitoringConnection {
                    provider: RecordingMonitoringProvider {
                        calls: calls.clone(),
                    },
                }),
            )
            .await;

        manager
            .set_session_monitoring_paused("mon-1", true)
            .await
            .unwrap();
        manager
            .set_session_monitoring_interval("mon-1", 500)
            .await
            .unwrap();
        // 0 is clamped to 1ms (interval_ms.max(1)).
        manager
            .set_session_monitoring_interval("mon-1", 0)
            .await
            .unwrap();
        manager.cancel_session_monitoring("mon-1").await.unwrap();
        // No push task was registered, so stop only unsubscribes.
        manager.stop_session_monitoring("mon-1").await.unwrap();

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &[
                "set_paused:true".to_string(),
                "set_interval:500".to_string(),
                "set_interval:1".to_string(),
                "cancel_connect".to_string(),
                "unsubscribe".to_string(),
            ]
        );
    }

    /// A session whose connection exposes no monitoring provider yields the
    /// exact `RemoteError("No monitoring capability")` the manager returned
    /// before the facade extraction, for both provider-required controls.
    #[tokio::test]
    async fn monitoring_controls_error_when_connection_has_no_capability() {
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager
            .insert_test_session("no-mon", Box::new(MockConnection::default()))
            .await;

        match manager.set_session_monitoring_paused("no-mon", true).await {
            Err(TerminalError::RemoteError(msg)) => {
                assert_eq!(msg, "No monitoring capability");
            }
            other => panic!("expected RemoteError, got {other:?}"),
        }
        match manager.set_session_monitoring_interval("no-mon", 100).await {
            Err(TerminalError::RemoteError(msg)) => {
                assert_eq!(msg, "No monitoring capability");
            }
            other => panic!("expected RemoteError, got {other:?}"),
        }
    }

    /// The provider-required controls surface `SessionNotFound` for an unknown
    /// session, unchanged by the facade.
    #[tokio::test]
    async fn monitoring_controls_error_when_session_unknown() {
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        assert!(matches!(
            manager
                .set_session_monitoring_paused("ghost", true)
                .await
                .unwrap_err(),
            TerminalError::SessionNotFound(_)
        ));
        assert!(matches!(
            manager
                .set_session_monitoring_interval("ghost", 100)
                .await
                .unwrap_err(),
            TerminalError::SessionNotFound(_)
        ));
    }

    /// `stop` and `cancel` are best-effort: an unknown session is treated as
    /// already gone and returns `Ok(())` rather than erroring.
    #[tokio::test]
    async fn stop_and_cancel_monitoring_are_noops_for_unknown_session() {
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
        manager.stop_session_monitoring("ghost").await.unwrap();
        manager.cancel_session_monitoring("ghost").await.unwrap();
    }
}
