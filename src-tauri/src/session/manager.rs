//! Unified session manager using [`ConnectionType`] from `termihub_core`.
//!
//! Replaces the legacy `TerminalManager` with a single manager that holds
//! `Box<dyn ConnectionType>` for both local and remote (agent-mediated)
//! connections. Local connections use the core backend implementations;
//! remote connections use [`RemoteProxy`](super::remote_proxy::RemoteProxy).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use serde::Serialize;
use tauri::Emitter;
use termihub_core::buffer::{RingBuffer, DEFAULT_BUFFER_CAPACITY};
use termihub_core::connection::{
    Capabilities, ConnectionType, ConnectionTypeInfo, ConnectionTypeRegistry,
};
use termihub_core::output::session_log::{SessionLogConfig, SessionLogger};
use termihub_core::session::pump::{run_output_pump, PumpEnd, PumpOptions};
use tracing::{info, warn};

use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

// Re-exported into the `tests` submodule via its `use super::*` (the file-op
// mock browsers construct `FileEntry`); the file-op prod code that used it now
// lives in the `file_ops` submodule, so gate it to test builds.
#[cfg(test)]
use termihub_core::files::FileEntry;

use super::line_ending::{normalize_line_endings, LineEnding};
use super::output_sink::TerminalOutputSink;
use super::persistent_controller::PersistentController;
use super::remote_proxy::RemoteProxy;
use super::retained_request::{RetainedConnectionRequest, RetainedRequestStore};
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct TerminalOutputEvent {
    pub session_id: String,
    /// Terminal output bytes as a base64 (standard alphabet, padded) string.
    ///
    /// The field is `Vec<u8>` in Rust but serialized as a base64 string on the
    /// wire (see the type-level docs and `serialize_bytes_base64`); the TS side
    /// receives a `string` and decodes it with `base64ToBytes`
    /// (`src/services/events.ts`), so the generated type is overridden to
    /// `string` to match the wire form rather than serde's default byte array.
    #[serde(serialize_with = "serialize_bytes_base64")]
    #[cfg_attr(test, ts(type = "string"))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<i32>,
}

/// State change event emitted when a persistent session transitions state.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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

    /// Fold a genuine-drop session-lifecycle transition **server-side** (#2439).
    ///
    /// Called from the `terminal-exit` source ([`SessionManager::emit_and_cleanup`])
    /// for a genuine drop, keyed by the frontend `tab_id`. Default no-op for test
    /// emitters (no projection store); the production `AppHandle` folds into the
    /// managed `session-lifecycle` store — a benign convergent double-write with
    /// the client's `setTerminalExited` mirror (like the connect/kill folds).
    fn fold_session_drop(&self, _tab_id: &str, _fold: DropFold) {}

    /// Fold an **initial** connect failure server-side (#2439, part of #2205).
    ///
    /// Called from the [`SessionManager::create_connection`] source for a
    /// **genuine** (non-cancelled), **initial** (`retryCount == 0`), **direct**
    /// (non-agent) connect failure, keyed by the frontend `tab_id`. It is the
    /// symmetric third arm of the command's connect/connected fold: a failed
    /// initial direct connect settles the tab-keyed region entry `Failed`. Default
    /// no-op for test emitters (no projection store); the production `AppHandle`
    /// folds `session.connectFailed` into the managed `session-lifecycle` store.
    ///
    /// Deliberately **not** folded here (each still owned by the client, so folding
    /// would diverge): a **cancellation** (a Stop, not a failure — gated on the
    /// connect token by the caller); a **reconnect attempt** (`retryCount > 0`,
    /// owned by the client reconnect loop + the backend timer #2203, whose
    /// give-up is not yet source-foldable); and an **agent** connect (the frontend
    /// silently auto-retries it without an intent).
    ///
    /// `auth_failed` classifies the failure at the source from the typed core error
    /// (`SessionError::AuthFailed`) **before** it is stringified (SM-005): a genuine
    /// auth rejection folds the distinct, non-retryable terminal `AuthFailed` state
    /// instead of the transient `Failed`, so the frontend surfaces "fix credentials
    /// & reconnect" rather than a generic connect error.
    fn fold_connect_failed(&self, _tab_id: &str, _error: &str, _auth_failed: bool) {}
}

impl<R: tauri::Runtime> EventEmitter for tauri::AppHandle<R> {
    fn emit_output(&self, event: &TerminalOutputEvent) -> bool {
        use crate::window::{OutputEmitTarget, WindowManager};
        use tauri::Manager;
        // PERF-004: narrow this hot-path emit to the window that hosts the
        // session, instead of broadcasting every byte to every window (each of
        // which would then deserialize and discard output for sessions it does
        // not render). The `session_id → window` ownership map (#1900/#1939) is
        // the authoritative source of which window renders a session — the same
        // map that gates `resize` via `may_resize`. An **unclaimed** session
        // (background/spawned, or the brief pre-claim moment on open/move) has no
        // owner and falls back to the legacy broadcast, so output is never routed
        // away from the window actually showing it. The scrollback a
        // (re)attaching tab renders is authoritative from the backend ring-buffer
        // replay, not this live tail, so a narrowed stream cannot lose bytes when
        // a tab moves between windows.
        let target = self
            .try_state::<WindowManager>()
            .map(|wm| wm.output_target(&event.session_id))
            .unwrap_or(OutputEmitTarget::Broadcast);
        match target {
            OutputEmitTarget::Window(label) => self
                .emit_to(tauri::EventTarget::labeled(label), "terminal-output", event)
                .is_ok(),
            OutputEmitTarget::Broadcast => self.emit("terminal-output", event).is_ok(),
        }
    }

    fn emit_exit(&self, event: &TerminalExitEvent) {
        let _ = self.emit("terminal-exit", event);
    }

    fn emit_persistent_state(&self, event: &PersistentSessionStateEvent) {
        let _ = self.emit("persistent-session-state-changed", event);
    }

    fn fold_session_drop(&self, tab_id: &str, fold: DropFold) {
        use crate::session_projection::projection::fold_session_transition;
        use crate::session_projection::ReconnectTimerDriver;
        use tauri::Manager;
        match fold {
            DropFold::Reconnect => fold_session_transition(self, |store| store.reconnect(tab_id)),
            DropFold::Dropped => fold_session_transition(self, |store| store.dropped(tab_id, None)),
        }
        // Reconcile the backend reconnect timer at the **authoritative source**
        // fold (#2476): a resilient drop (`Reconnect` → `Waiting`) must ARM the
        // backend timer so the backend redrive drives the reconnect itself — it
        // is the sole driver of an agent reconnect and must not depend on the
        // client's `session.reconnect` mirror to start its own loop. Without this
        // the source fold set the store to `Reconnecting` but left the timer
        // unarmed (every `session.*` intent route calls `sync`, this fold did
        // not), so if the client mirror did not fire/reach the backend the tab
        // sat in `Reconnecting` forever with no attempt ever driven. `Dropped`
        // (terminal) cancels any pending timer. Idempotent with the client
        // mirror's own `sync` — a convergent double-arm. Off-path no-op when the
        // driver is not managed (headless projection unit tests).
        if let Some(driver) = self.try_state::<Arc<ReconnectTimerDriver>>() {
            (*driver).sync(tab_id);
        }
    }

    fn fold_connect_failed(&self, tab_id: &str, error: &str, auth_failed: bool) {
        use crate::session_projection::projection::fold_session_transition;
        fold_session_transition(self, |store| {
            if auth_failed {
                store.connect_auth_failed(tab_id, Some(error.to_string()))
            } else {
                store.connect_failed(tab_id, Some(error.to_string()))
            }
        });
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

/// One agent-hosted session's identity, for server-side `session-lifecycle`
/// region folds on a transient agent-transport break (#2556). Returned by
/// [`SessionManager::agent_hosted_sessions`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentHostedSession {
    /// The agent's session id (its `remote_session_id`); matched against
    /// `list_recovered_session_ids` to decide whether the session survived the
    /// transient break in place.
    pub remote_session_id: String,
    /// The desktop backend session id (uuid) that hosts this agent session.
    pub session_id: String,
    /// The frontend tab id the shared `session-lifecycle` region is keyed by.
    pub tab_id: String,
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
    /// Cancellation handle for this session's detached output-reader task
    /// (CONC-011). The reader is spawned with [`tokio::spawn`] and its
    /// `JoinHandle` is dropped, so without this the task can only stop once it
    /// happens to observe the output channel reaching EOF — which relies on the
    /// backend's `disconnect()` promptly dropping the sender. Holding this token
    /// lets teardown ([`SessionManager::close_session`]) stop the reader
    /// deterministically: cancelling it breaks the reader's recv loop and it
    /// still runs its normal end-of-stream cleanup (`emit_and_cleanup`), so no
    /// output-buffer / logger state is leaked and no reader lingers.
    pub(super) reader_cancel: CancellationToken,
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
pub(super) type SessionLoggers = Arc<StdMutex<HashMap<String, Arc<StdMutex<SessionLogger>>>>>;

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
///
/// The value is a [`TabBinding`], not a bare tab id: it also carries the tab's
/// **resilient-reconnect** determination (#2439), so a genuine drop observed at
/// the `terminal-exit` source can be folded as `reconnect` (resilient) vs
/// `dropped` (non-resilient) server-side, converging with the client.
type SessionTabIds = Arc<StdMutex<HashMap<String, TabBinding>>>;

/// A live session's frontend identity + drop classification (#2431, #2439).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TabBinding {
    /// The frontend tab id the `session-lifecycle` region is keyed by.
    pub(super) tab_id: String,
    /// Whether the owning tab is a resilient-reconnect tab — the client's
    /// `isResilientReconnectTab` computed at connect time and passed to the
    /// backend (#2439). Decides a genuine drop's server-side fold:
    /// `reconnect` when `true`, `dropped` when `false`.
    pub(super) resilient: bool,
}

/// The session-lifecycle transition to fold for a **genuine** (non-killed) exit
/// observed at the `terminal-exit` source, mirroring the client's
/// `setTerminalExited` classification exactly (#2439). Returned by
/// [`drop_fold_for`]; `None` means fold nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DropFold {
    /// A resilient-reconnect tab's drop → `session.reconnect` (→ Reconnecting).
    Reconnect,
    /// A non-resilient tab's drop → `session.dropped` (→ Disconnected).
    Dropped,
}

/// The server-side fold for a genuine (non-killed) terminal exit, mirroring the
/// client's `setTerminalExited` reason classification (#2439).
///
/// The client computes `reason = exitCode === 0 ? "clean" : "dropped"` for a
/// non-killed exit, then folds `session.reconnect` for a resilient-reconnect
/// tab's drop, `session.dropped` for a non-resilient drop, and **nothing** for a
/// clean exit. This reproduces that: `Some(0)` → `None` (clean folds neither);
/// any other code (or an unknown `None`, which the desktop `terminal-exit`
/// currently always emits) → a drop, resilient-gated. The *killed* case never
/// reaches here — a deliberate close clears the tab binding before the exit
/// fires (see `close_session`), so this is only called for genuine drops.
pub(super) fn drop_fold_for(exit_code: Option<i32>, resilient: bool) -> Option<DropFold> {
    match exit_code {
        Some(0) => None,
        _ if resilient => Some(DropFold::Reconnect),
        _ => Some(DropFold::Dropped),
    }
}

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
    /// Standalone agent-self monitoring providers for session monitors whose
    /// run-location resolved to an agent (#2593), keyed by session ID. These are
    /// not owned by the session's connection, so the monitoring controls consult
    /// this map before the session provider.
    monitoring_overrides: Arc<
        Mutex<
            HashMap<String, Arc<dyn termihub_core::monitoring::MonitoringProvider + Send + Sync>>,
        >,
    >,
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
    /// Per-tab retained connection requests for the resilient-reconnect loop
    /// (#2454, retention Model A). Populated in [`Self::create_connection`] for a
    /// resilient **direct** session, and dropped + zeroized on every
    /// terminal-loop / session-end path (the mandatory secret-lifetime
    /// mitigation). See [`super::retained_request`].
    pub(super) retained_requests: RetainedRequestStore,
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

/// The frontend `tab_id` to fold a `session.connectFailed` for when an **initial**
/// connect fails, parsed from `connect_id = ${tabId}:${retryCount}` (#2439).
///
/// Returns `Some(tab_id)` only for the initial attempt (`retryCount == 0`) of a
/// session carrying the tab-id form. A **reconnect attempt** (`retryCount > 0`,
/// owned by the client reconnect loop + the backend timer #2203) or a `connect_id`
/// not carrying the tab-id form (e.g. the internal agent-setup session, `None`)
/// yields `None`. The **agent** and **cancellation** exclusions are applied by the
/// caller (the non-agent branch, gated on the connect token), not here.
fn initial_connect_failed_tab_id(connect_id: Option<&str>) -> Option<String> {
    let (tab_id, retry) = connect_id?.rsplit_once(':')?;
    (retry == "0" && !tab_id.is_empty()).then(|| tab_id.to_string())
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
            monitoring_overrides: Arc::new(Mutex::new(HashMap::new())),
            persistent_sessions: Arc::new(Mutex::new(HashMap::new())),
            connecting: Arc::new(StdMutex::new(HashMap::new())),
            output_buffers: Arc::new(StdMutex::new(HashMap::new())),
            session_loggers: Arc::new(StdMutex::new(HashMap::new())),
            session_tab_ids: Arc::new(StdMutex::new(HashMap::new())),
            retained_requests: RetainedRequestStore::new(),
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
    pub(super) fn log_output(session_loggers: &SessionLoggers, session_id: &str, data: &[u8]) {
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

    /// Validate a connection configuration **without persisting it or leaving a
    /// live session** (UX-007).
    ///
    /// Establishes the connection with the same cancellable connect path as
    /// [`create_connection`](Self::create_connection) — a local backend from the
    /// registry, or an agent-mediated [`RemoteProxy`] when `agent_id` is `Some` —
    /// then **immediately disconnects** on success. Nothing is inserted into the
    /// `sessions` map, no output is subscribed, no config is written, and no
    /// title/log/reconnect state is created: it is a pure validate-and-teardown
    /// probe.
    ///
    /// A hung probe is abortable: when a `connect_id` is supplied it registers a
    /// [`CancellationToken`] in the same `connecting` map a real connect uses, so
    /// [`cancel_connecting`](Self::cancel_connecting) fires it and the underlying
    /// [`connect_cancellable`](termihub_core::connection::ConnectionType::connect_cancellable)
    /// aborts the in-flight handshake promptly instead of waiting out the timeout
    /// (#952) — no un-cancellable hang on the connect path.
    ///
    /// Returns `Ok(())` when the connection was established (and then torn down),
    /// or a typed [`SessionError`] classifying the failure — [`AuthFailed`] when
    /// credentials were rejected, [`ConnectionFailed`] when the host was
    /// unreachable / a transport failed / the connect timed out, or another
    /// variant — so the caller can present a classified reason. Mapping to the
    /// IPC [`TerminalError`] envelope (and its machine code) is done by the
    /// command layer via [`TerminalError::from_session_spawn`].
    ///
    /// [`AuthFailed`]: termihub_core::errors::SessionError::AuthFailed
    /// [`ConnectionFailed`]: termihub_core::errors::SessionError::ConnectionFailed
    #[tracing::instrument(
        skip_all,
        fields(type_id = %type_id, agent_id = agent_id.unwrap_or("direct"))
    )]
    pub async fn test_connection(
        &self,
        type_id: &str,
        settings: serde_json::Value,
        agent_id: Option<&str>,
        connect_id: Option<&str>,
    ) -> Result<(), termihub_core::errors::SessionError> {
        // Register a cancellation token so a hung test connect is abortable via
        // `cancel_connecting` (#952) — reuses the same `connecting` map a real
        // connect uses. The RAII guard clears the entry on every exit path,
        // including an early `?` return.
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

        // Establish the connection exactly as a real connect would, but never
        // record it: no `sessions` insert, no output subscription, no logging.
        let mut connection: Box<dyn ConnectionType> = if let Some(aid) = agent_id {
            let mut proxy = RemoteProxy::new(aid.to_string(), self.agent_manager.clone());
            let remote_settings = serde_json::json!({
                "type": type_id,
                "config": settings,
            });
            proxy
                .connect_cancellable(remote_settings, cancel_token.clone())
                .await?;
            Box::new(proxy)
        } else {
            let mut conn = {
                let registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
                registry
                    .create(type_id)
                    .map_err(|e| termihub_core::errors::SessionError::SpawnFailed(e.to_string()))?
            };
            conn.connect_cancellable(settings, cancel_token.clone())
                .await?;
            conn
        };

        // Validate-and-teardown: the probe must never leave a live session. The
        // test's verdict is the *connect* result, so a best-effort teardown error
        // is logged but does not turn a successful validation into a failure (the
        // probe connection is dropped immediately after regardless).
        if let Err(e) = connection.disconnect().await {
            warn!(error = %e, "test_connection: error tearing down the probe connection");
        }
        Ok(())
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
    /// A resilient direct session records its retained connection request so the
    /// backend reconnect timer can re-establish the transport itself on a drop
    /// (the redrive, #2454); the redrive gates on that request's `resilient` flag.
    ///
    /// Returns the session ID on success.
    // The parameters mirror the `create_connection` IPC surface (type + settings +
    // routing flags + the connect-time signals: spawn origin #1466, resilient
    // reconnect #2439); grouping them into a struct would only obscure the call.
    #[allow(clippy::too_many_arguments)]
    #[tracing::instrument(
        skip_all,
        fields(
            type_id = %type_id,
            agent_id = agent_id.unwrap_or("direct"),
            session_id = tracing::field::Empty,
        )
    )]
    pub async fn create_connection<E: EventEmitter>(
        &self,
        type_id: &str,
        settings: serde_json::Value,
        agent_id: Option<&str>,
        connect_id: Option<&str>,
        spawned: bool,
        resilient_reconnect: bool,
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
        // Attach the freshly-minted id to the connect span so every nested event
        // (proxy handshake, local connect, initial command) groups under it (OBS-004).
        tracing::Span::current().record("session_id", session_id.as_str());

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
                if let Err(e) = conn
                    .connect_cancellable(settings.clone(), cancel_token.clone())
                    .await
                {
                    // Server-authority fold (#2439, part of #2205): a **genuine**
                    // (non-cancelled) **initial** direct-connect failure is a terminal
                    // `session.connectFailed`, folded at the source keyed by the tab id —
                    // the symmetric third arm of the command's connect/connected fold.
                    // Left to the client (as before, so no divergence): a **cancellation**
                    // (a Stop, not a failure — the token fired); a **reconnect attempt**
                    // (retry>0, owned by the client loop + backend timer #2203, whose
                    // give-up is not yet source-foldable); and **agent** connects (this is
                    // the non-agent branch — an agent connect silently auto-retries
                    // client-side without an intent). Additive, shadow-only.
                    // A dismissed keyboard-interactive prompt (#3371) is a user
                    // cancel too, not a connect failure.
                    let cancelled = cancel_token
                        .as_ref()
                        .is_some_and(CancellationToken::is_cancelled)
                        || matches!(e, termihub_core::errors::SessionError::AuthCancelled);
                    if !cancelled {
                        if let Some(tab_id) = initial_connect_failed_tab_id(connect_id) {
                            // Classify the auth rejection from the typed core error
                            // BEFORE it is stringified (SM-005 / I18N-001): a genuine
                            // `AuthFailed` folds the non-retryable terminal state, not
                            // a transient `Failed`. Non-auth failures are unchanged.
                            let auth_failed =
                                matches!(e, termihub_core::errors::SessionError::AuthFailed);
                            emitter.fold_connect_failed(&tab_id, &e.to_string(), auth_failed);
                        }
                    }
                    // Preserve a genuine auth rejection as the typed `AuthFailed`
                    // (carrying the locale-independent code) so the frontend's
                    // destructive stale-credential discard gates on it
                    // structurally rather than on English message text
                    // (I18N-001). Non-auth failures keep `SpawnFailed`, unchanged.
                    return Err(TerminalError::from_session_spawn(e));
                }
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

        // Capture the agent's live session id before `remote_session_id` moves
        // into the `SessionEntry` below, so the resilient-reconnect retention can
        // record it for the redrive to re-attach to (#2512). `None` for a direct
        // (non-agent) session.
        let retained_agent_session_id = remote_session_id.clone();

        // Deterministic-teardown handle for the output-reader task spawned below
        // (CONC-011). Stored on the entry so `close_session` can cancel it; a
        // clone is moved into the reader.
        let reader_cancel = CancellationToken::new();

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
                    reader_cancel: reader_cancel.clone(),
                },
            );
        }

        // Record the backend `session_id` → frontend `tab_id` identity bridge
        // (#2431) so server-side lifecycle sources can address this session's
        // tab-id-keyed `session-lifecycle` region entry. The tab id is the
        // `connect_id` up to its trailing `:${retryCount}` (see `Terminal.tsx`);
        // a session created without a `connect_id` (e.g. the internal agent-setup
        // session) carries no tab and is simply not mapped. The `resilient_reconnect`
        // flag (the client's `isResilientReconnectTab` at connect time) is recorded
        // alongside so a genuine drop can be folded server-side as `reconnect` vs
        // `dropped` at the `terminal-exit` source (#2439).
        if let Some(tab_id) = connect_id.and_then(tab_id_from_connect_id) {
            self.session_tab_ids
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(
                    session_id.clone(),
                    TabBinding {
                        tab_id: tab_id.clone(),
                        resilient: resilient_reconnect,
                    },
                );

            // Retain the connection request for the resilient-reconnect loop
            // (#2454, retention Model A) so the backend redrive re-establishes the
            // transport itself. Covers **resilient DIRECT** (non-agent, #2454) and
            // **resilient AGENT** (#2473) sessions alike: the redrive
            // cold-re-establishes the agent transport from the retained `agent_id`
            // + per-agent config (#2472) before re-creating the session. A
            // non-resilient tab never reconnects, so it retains no secret; only a
            // tab that opted into resilient reconnect (the frontend's
            // `isResilientReconnectTab`) does. Refreshed on every (re)connect of
            // the tab; dropped + zeroized on any terminal-loop / session-end path
            // (see the module docs and the `clear_retained_request` call sites). A
            // no-op for the internal agent-setup session, which carries no
            // `connect_id` / tab id.
            if resilient_reconnect {
                self.retained_requests.retain(
                    &tab_id,
                    RetainedConnectionRequest {
                        type_id: type_id.to_string(),
                        settings: settings.clone(),
                        agent_id: agent_id.map(|s| s.to_string()),
                        // The live agent session id to re-attach to on reconnect
                        // (#2512), captured from the proxy's `remote_session_id()`
                        // after the initial agent connect. `None` for a direct tab
                        // (no agent session). The redrive attaches to *this* live
                        // session (running process continues) rather than minting a
                        // new one, and emits session-lost when the agent no longer
                        // lists it.
                        agent_session_id: retained_agent_session_id.clone(),
                        resilient: true,
                    },
                );
            }
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
                reader_cancel,
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

    /// The identity tuples of every **agent-hosted** session an agent owns that
    /// carries a frontend tab id, for server-side `session-lifecycle` region folds
    /// on a transient agent-transport break (#2556).
    ///
    /// A transient break is recovered *in place* by `agent_io_task`'s in-task
    /// reconnect loop — no per-session `terminal-exit` fires — so the backend
    /// source that folds those tabs' region entries (`Reconnecting` on the break,
    /// `Connected` on in-place recovery) needs the agent → desktop → tab mapping the
    /// `terminal-exit` path gets for free. This resolves it: for `agent_id`, every
    /// live session whose [`SessionInfo::agent_id`] matches, paired with its agent
    /// `remote_session_id` (matched against `list_recovered_session_ids` to decide
    /// survived-vs-gone), its desktop `session_id` (uuid), and the frontend
    /// `tab_id` the region is keyed by.
    ///
    /// Sessions with no [`TabBinding`] (e.g. the internal agent-setup session, which
    /// carries no `connect_id`) or no `remote_session_id` are skipped — they have no
    /// tab-keyed region entry to fold.
    pub async fn agent_hosted_sessions(&self, agent_id: &str) -> Vec<AgentHostedSession> {
        let sessions = self.sessions.lock().await;
        let tab_ids = self
            .session_tab_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions
            .iter()
            .filter_map(|(session_id, entry)| {
                if entry.info.agent_id.as_deref() != Some(agent_id) {
                    return None;
                }
                let remote_session_id = entry.remote_session_id.clone()?;
                let tab_id = tab_ids.get(session_id)?.tab_id.clone();
                Some(AgentHostedSession {
                    remote_session_id,
                    session_id: session_id.clone(),
                    tab_id,
                })
            })
            .collect()
    }

    /// Close a session.
    ///
    /// Explicitly calls [`ConnectionType::disconnect`] before dropping the entry
    /// so that backends that release resources in `disconnect()` (not just `Drop`)
    /// — notably Serial, which clears `output_tx` to stop its reader thread —
    /// are cleaned up immediately.
    #[tracing::instrument(skip_all, fields(session_id = %session_id))]
    pub async fn close_session(&self, session_id: &str) -> Result<(), TerminalError> {
        // Clear the identity bridge entry (#2431) **before** disconnecting — the
        // session is gone, so its tab mapping must not linger. Clearing it *first*
        // is what makes the map's presence at the `terminal-exit` source a
        // race-free discriminator for the drop fold (#2439): a deliberate close
        // (a user kill via `close_terminal`, or a tab close) drops the tab binding
        // before `disconnect()` triggers the reader's EOF, so `emit_and_cleanup`
        // never sees a binding and never folds a `dropped`/`reconnect` for it. Only
        // a *genuine* spontaneous drop — where no `close_session` ran — leaves the
        // binding intact to arm that fold.
        let removed_binding = self
            .session_tab_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
        // Drop + zeroize the tab's retained connection request (#2454): a
        // deliberate close of a *live* session ends its reconnect loop, so no
        // resolved secret must linger. (A close after a spontaneous drop finds no
        // binding here — the drop already removed it — so the post-drop terminal
        // states clear the retained request via the lifecycle-intent routes.)
        if let Some(binding) = &removed_binding {
            self.retained_requests.clear(&binding.tab_id);
        }
        let mut sessions = self.sessions.lock().await;
        if let Some(mut entry) = sessions.remove(session_id) {
            // Deterministically stop the detached output-reader task (CONC-011)
            // instead of relying on `disconnect()` to close the output channel
            // and drive the reader to EOF. The reader observes the cancel, breaks
            // its recv loop, and still runs its end-of-stream cleanup, so the
            // scrollback buffer and any session logger are released as usual.
            entry.reader_cancel.cancel();
            entry.connection.disconnect().await.ok();
            info!(session_id, "Closed session");
        }
        Ok(())
    }

    /// Drop + zeroize the retained connection request for a tab (#2454, retention
    /// Model A) — the per-tab primitive, without the per-agent transport-config
    /// scrub. The lifecycle scrub points now route through
    /// [`Self::clear_retained_request_with_agent_scrub`] so a resilient agent tab's
    /// shared transport config is refcount-scrubbed too (#2473); this narrower form
    /// stays as the direct-only building block. Idempotent: clearing a tab with no
    /// retained request is a no-op.
    #[allow(dead_code)] // building block for the agent-scrub variant + the idempotency test
    pub fn clear_retained_request(&self, tab_id: &str) {
        self.retained_requests.clear(tab_id);
    }

    /// Clear a tab's retained request and, when it was the **last** tab on its
    /// agent, scrub that agent's retained transport config too (#2473).
    ///
    /// The per-tab request (#2454) and the per-agent transport config (#2472) have
    /// different lifetimes: one SSH transport is shared by every session on an
    /// agent, so its secret-bearing config must survive until the last tab on that
    /// agent releases it. This clears the tab's own request first, then — only if
    /// no sibling tab still routes through the same agent — drops + zeroizes the
    /// per-agent config. A direct (non-agent) tab has no agent config to scrub, so
    /// this behaves exactly like [`Self::clear_retained_request`] for it; idempotent
    /// throughout. This is the tab-close / non-loop-drop scrub point (routed
    /// through [`crate::session_projection::projection`]); the reconnect give-up
    /// point applies the same refcount in
    /// [`crate::session_projection::redrive`].
    pub fn clear_retained_request_with_agent_scrub(&self, tab_id: &str) {
        // Read the agent id before clearing (the request is about to drop), then
        // clear this tab so the sibling check below does not count itself.
        let agent_id = self.retained_requests.agent_id_for(tab_id);
        self.retained_requests.clear(tab_id);
        if let Some(agent_id) = agent_id {
            if !self.retained_requests.any_for_agent(&agent_id) {
                self.agent_manager.clear_retained_agent_config(&agent_id);
            }
        }
    }

    /// Whether a resilient-reconnect connection request is currently retained for
    /// a tab (#2454). Used by tests and the (follow-up) backend redrive.
    #[allow(dead_code)] // consumed by the retention tests and the follow-up backend redrive
    pub fn has_retained_request(&self, tab_id: &str) -> bool {
        self.retained_requests.contains(tab_id)
    }

    /// A clone of the retained connection request for a tab, for the backend
    /// reconnect redrive (#2454). The redrive reads `type_id` / `settings` /
    /// `agent_id` to re-establish the transport itself and gates on `resilient`.
    /// Cloning copies the secret-bearing settings; the returned value zeroizes on
    /// drop, so the
    /// caller must clone out only the fields it forwards and let it fall out of
    /// scope promptly. `None` when nothing is retained for the tab.
    pub(crate) fn retained_request(&self, tab_id: &str) -> Option<RetainedConnectionRequest> {
        self.retained_requests.get(tab_id)
    }

    /// The agent RPC client, for the backend reconnect redrive to cold-re-establish
    /// a reaped **agent** transport before re-creating the session (#2472). The
    /// redrive lives in `session_projection`, so it reaches the client through
    /// this accessor rather than the crate-private field.
    pub(crate) fn agent_client(&self) -> Arc<dyn AgentRpcClient> {
        self.agent_manager.clone()
    }

    /// The frontend `tab_id` that owns a backend `session_id`, or `None` for a
    /// session created without a `connect_id` (no tab) or already removed (#2431).
    ///
    /// The lookup backing the server-authoritative `session-lifecycle` fold: a
    /// backend lifecycle source that knows only the uuid `session_id` (the
    /// `terminal-exit` emission, `close_session`) resolves it to the tab id the
    /// region is keyed by. The initial-connect fold (`create_connection`) reads
    /// the tab id straight off the `connect_id`, so this uuid→tab lookup backs the
    /// close/kill path: `close_terminal` resolves it to fold the graceful
    /// `session.disconnect` for a user-initiated kill (#2439). The map it reads is
    /// populated and cleaned up live, and the lookup is covered by unit tests. The
    /// genuine-drop `reconnect`/`dropped` fold at the `terminal-exit` source reads
    /// the full binding directly (see `emit_and_cleanup`), keyed off the same map.
    pub fn tab_id_for(&self, session_id: &str) -> Option<String> {
        self.session_tab_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .map(|binding| binding.tab_id.clone())
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

    /// Re-attach a reconnecting resilient tab to an **existing live agent
    /// session** — the running process continues (#2512).
    ///
    /// The backend reconnect redrive calls this after it re-establishes the
    /// agent's SSH transport and confirms (via `connection.list`) that the live
    /// agent session id it retained for the tab (`remote_session_id`) is still
    /// present. Rather than `create_connection` minting a **new** agent session
    /// (which would orphan the recovered process), it re-establishes the
    /// desktop-side proxy against the surviving daemon via
    /// [`RemoteProxy::reconnect_existing`] (which registers a fresh output channel
    /// and issues `connection.attach` for a buffer replay), inserts it under a
    /// fresh desktop `session_id`, records the identity bridge for that id keyed by
    /// the stable `tab_id`, and streams output — mirroring the post-connect
    /// bookkeeping of [`create_connection`](Self::create_connection). Returns the
    /// new desktop `session_id` so the redrive can publish it via
    /// `set_backend_session_id` for the frontend to re-attach terminal I/O to.
    ///
    /// Only ever called for a resilient agent tab, so the identity bridge is
    /// recorded with `resilient: true`. The retained request is left untouched:
    /// the same live agent session id remains valid for the next drop.
    #[tracing::instrument(
        skip_all,
        fields(
            tab_id = %tab_id,
            agent_id = %agent_id,
            remote_session_id = %remote_session_id,
            session_id = tracing::field::Empty,
        )
    )]
    pub async fn reattach_agent_session<E: EventEmitter>(
        &self,
        tab_id: &str,
        agent_id: &str,
        remote_session_id: &str,
        emitter: E,
    ) -> Result<String, TerminalError> {
        let session_id = uuid::Uuid::new_v4().to_string();
        tracing::Span::current().record("session_id", session_id.as_str());

        // Re-establish the desktop side against the surviving daemon.
        // `reconnect_existing` calls `register_session_output` + `attach_session`
        // synchronously; the latter internally parks on `blocking_recv`, so run it
        // on the blocking pool to keep the tokio worker free to drive
        // `agent_io_task` and deliver the reply.
        let agent_mgr = self.agent_manager.clone();
        let agent_id_owned = agent_id.to_string();
        let remote_sid_owned = remote_session_id.to_string();
        let proxy = tokio::task::spawn_blocking(move || {
            RemoteProxy::reconnect_existing(agent_id_owned, remote_sid_owned, agent_mgr)
        })
        .await
        .map_err(|e| TerminalError::SpawnFailed(format!("spawn_blocking join: {e}")))?
        .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let output_rx = proxy.subscribe_output();

        // Deterministic-teardown handle for the re-attached session's output
        // reader (CONC-011), mirroring the create path.
        let reader_cancel = CancellationToken::new();

        // Insert under the fresh desktop session id.
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                session_id.clone(),
                SessionEntry {
                    connection: Box::new(proxy),
                    info: SessionInfo {
                        id: session_id.clone(),
                        title: "Remote".to_string(),
                        connection_type: "remote".to_string(),
                        alive: true,
                        agent_id: Some(agent_id.to_string()),
                        spawned: false,
                    },
                    remote_session_id: Some(remote_session_id.to_string()),
                    line_ending: LineEnding::default(),
                    reader_cancel: reader_cancel.clone(),
                },
            );
        }

        // Record the identity bridge for the new desktop session id, keyed by the
        // stable tab id, so a future drop of this re-attached session folds
        // `reconnect`/`dropped` at the `terminal-exit` source (#2431/#2439).
        self.session_tab_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                session_id.clone(),
                TabBinding {
                    tab_id: tab_id.to_string(),
                    resilient: true,
                },
            );

        // Stream output for the re-attached session (buffer replay is already
        // in-flight from `attach_session`).
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
                false,
                capture,
                output_buffers,
                session_loggers,
                session_tab_ids,
                reader_cancel,
            )
            .await;
        });

        Ok(session_id)
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
                reader_cancel: CancellationToken::new(),
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
        cancel: CancellationToken,
    ) {
        // The mechanical forwarding loop (buffer-until-clear + coalescing
        // stream) now lives in the shared core pump (finding DUP-011); the
        // desktop delivery — capture + transcript + emit — is injected via
        // `TerminalOutputSink`. The reader keeps its own `emitter` /
        // `session_loggers` handles for the tier-specific settle below, so the
        // sink is built from cheap clones.
        let sink = TerminalOutputSink::new(
            session_id.clone(),
            emitter.clone(),
            capture,
            session_loggers.clone(),
        );
        let opts = PumpOptions {
            wait_for_clear,
            coalesce: true,
            max_coalesce_bytes: MAX_COALESCE_BYTES,
            clear_wait_timeout: CLEAR_WAIT_TIMEOUT,
        };

        match run_output_pump(&session_id, &mut output_rx, &sink, Some(&cancel), &opts).await {
            // A sink failure while flushing the pre-stream clear buffer returns
            // WITHOUT settling — preserving the original no-settle asymmetry
            // (old manager.rs:1968): no `terminal-exit`, no drop-fold.
            PumpEnd::ClearFlushSinkClosed => {}
            // Eof / Cancelled / a streaming-phase sink failure all settle the
            // session exactly as the original loop did after its `break`: emit
            // the exit event and run cleanup (the drop-fold lives here, #2439 —
            // the DUP-010 seam).
            _ => {
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
        }
    }

    /// Mirror emitted output into a session's scrollback capture buffer (#1900).
    ///
    /// The write is bounded by the [`RingBuffer`]'s 1 MiB capacity, so long
    /// histories are truncated to the most recent bytes — matching the concept's
    /// stated scrollback-fidelity limit.
    pub(super) fn capture_bytes(capture: &StdMutex<RingBuffer>, data: &[u8]) {
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

        // Capture-and-clear the identity bridge entry (#2431/#2439). A binding
        // still present here means this exit is a **genuine spontaneous drop** — a
        // deliberate close (kill/tab-close) clears the binding before disconnecting
        // (see `close_session`), so those never carry a binding to this point. Fold
        // the drop server-side, keyed by the tab id, mirroring the client's
        // `setTerminalExited` classification exactly (#2439): a resilient-reconnect
        // tab folds `session.reconnect` (→ Reconnecting), a non-resilient tab
        // `session.dropped` (→ Disconnected); a clean exit-code-0 exit folds
        // nothing. Convergent double-write with the still-live client mirror.
        let drop_binding = session_tab_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
        if let Some(binding) = &drop_binding {
            if let Some(fold) = drop_fold_for(exit_event.exit_code, binding.resilient) {
                emitter.fold_session_drop(&binding.tab_id, fold);
            }
        }

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

        // (The identity bridge entry for this session was already captured and
        // removed above, where its presence gated the genuine-drop fold — #2439.)

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

/// File-operation seam (SFTP / file-browser family) carved out of this file
/// (ARCH-002 / TAURI-009); a second `impl SessionManager` block lives there.
mod file_ops;

/// Session-monitoring seam (monitoring lifecycle family) carved out of this
/// file (ARCH-002 / TAURI-009); a second `impl SessionManager` block lives there.
mod monitoring;

#[cfg(test)]
mod tests;
