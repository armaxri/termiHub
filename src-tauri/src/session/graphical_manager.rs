//! Graphical (remote-desktop) session manager.
//!
//! The framebuffer-oriented analogue of [`SessionManager`](super::manager::SessionManager):
//! it owns live graphical sessions keyed by session id, drives the shared
//! [`SessionStateMachine`], and fans the backend's frame / cursor / clipboard /
//! state changes out as Tauri events (`remote-desktop-frame`,
//! `remote-desktop-cursor`, `remote-desktop-clipboard`, `remote-desktop-state`).
//!
//! It is protocol-blind: a session is created through the same
//! [`ConnectionTypeRegistry`] as every other connection, and its framebuffer
//! surface is reached via [`ConnectionType::graphical()`]. Registration is
//! additive/data-driven, so VNC (#1681) and RDP (#1682) plug in with no edit
//! here.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use termihub_core::connection::{
    CertPrompt, CertPromptReceiver, ConnectionType, ConnectionTypeRegistry, CursorUpdate,
    FrameUpdate, GraphicalState, InputEvent, RemoteClipboardFile, SessionStateMachine,
};

use crate::session::rdp_trust_store::{RdpTrustStore, TrustLookup};
use crate::utils::errors::TerminalError;

/// Maximum concurrent graphical sessions.
const MAX_GRAPHICAL_SESSIONS: usize = 16;

// ── Event payloads ─────────────────────────────────────────────────

/// `remote-desktop-frame` payload: a session id plus the flattened frame update
/// (`width`, `height`, `rects`).
#[derive(Debug, Clone, Serialize)]
pub struct RemoteDesktopFrameEvent {
    pub session_id: String,
    #[serde(flatten)]
    pub frame: FrameUpdate,
}

/// `remote-desktop-cursor` payload.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteDesktopCursorEvent {
    pub session_id: String,
    #[serde(flatten)]
    pub cursor: CursorUpdate,
}

/// `remote-desktop-clipboard` payload (remote → local text).
#[derive(Debug, Clone, Serialize)]
pub struct RemoteDesktopClipboardEvent {
    pub session_id: String,
    pub text: String,
}

/// `remote-desktop-state` payload: the current lifecycle state plus the
/// reconnect attempt counter (for the reconnect overlay) and an optional
/// human-readable message (auth/connect failures).
///
/// Fields stay snake_case (like `terminal-output`/`terminal-exit`); the
/// frontend `events.ts` wrapper renames to camelCase. The `state` value itself
/// is a camelCase-serialized [`GraphicalState`] (e.g. `"connectFailed"`).
#[derive(Debug, Clone, Serialize)]
pub struct RemoteDesktopStateEvent {
    pub session_id: String,
    pub state: GraphicalState,
    pub reconnect_attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `remote-desktop-cert-prompt` payload: an untrusted server certificate needs
/// an interactive trust decision (#1767). The frontend renders an accept-once /
/// accept-for-host / reject dialog and replies via `remote_desktop_cert_decision`.
///
/// `changed` distinguishes first contact (`false`) from a *changed* fingerprint
/// for a previously-trusted host (`true`) — the possible-MITM case the dialog
/// warns about prominently.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteDesktopCertPromptEvent {
    pub session_id: String,
    pub host: String,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    pub changed: bool,
}

// ── Event sink abstraction (for test injection) ────────────────────

/// Abstracts frontend event delivery so the manager is unit-testable without a
/// Tauri runtime. The production impl wraps `tauri::AppHandle`.
pub trait GraphicalEventSink: Clone + Send + Sync + 'static {
    /// Emit a decoded frame update.
    fn emit_frame(&self, event: &RemoteDesktopFrameEvent);
    /// Emit a cursor update.
    fn emit_cursor(&self, event: &RemoteDesktopCursorEvent);
    /// Emit a remote → local clipboard update.
    fn emit_clipboard(&self, event: &RemoteDesktopClipboardEvent);
    /// Emit a lifecycle state change.
    fn emit_state(&self, event: &RemoteDesktopStateEvent);
    /// Emit an interactive server-certificate trust prompt (#1767).
    fn emit_cert_prompt(&self, event: &RemoteDesktopCertPromptEvent);
}

impl<R: tauri::Runtime> GraphicalEventSink for tauri::AppHandle<R> {
    fn emit_frame(&self, event: &RemoteDesktopFrameEvent) {
        let _ = self.emit("remote-desktop-frame", event);
    }
    fn emit_cursor(&self, event: &RemoteDesktopCursorEvent) {
        let _ = self.emit("remote-desktop-cursor", event);
    }
    fn emit_clipboard(&self, event: &RemoteDesktopClipboardEvent) {
        let _ = self.emit("remote-desktop-clipboard", event);
    }
    fn emit_state(&self, event: &RemoteDesktopStateEvent) {
        let _ = self.emit("remote-desktop-state", event);
    }
    fn emit_cert_prompt(&self, event: &RemoteDesktopCertPromptEvent) {
        let _ = self.emit("remote-desktop-cert-prompt", event);
    }
}

// ── Session record ─────────────────────────────────────────────────

/// The host + fingerprint of a cert prompt awaiting the user's verdict, held so
/// [`cert_decision`](GraphicalSessionManager::cert_decision) can persist the
/// fingerprint on "Accept for host" (#1767).
type PendingCert = Arc<Mutex<Option<(String, String)>>>;

/// A live graphical session.
struct GraphicalSession {
    /// The connected backend, shared so command handlers can drive input /
    /// resize / clipboard while the pump tasks run independently.
    connection: Arc<Mutex<Box<dyn ConnectionType>>>,
    /// The shared lifecycle state machine.
    state: Arc<Mutex<SessionStateMachine>>,
    /// Frame + cursor (+ optional cert-prompt) pump tasks, aborted on disconnect.
    tasks: Vec<JoinHandle<()>>,
    /// Backend type id (for diagnostics).
    type_id: String,
    /// The certificate prompt currently awaiting a user decision, if any (#1767).
    pending_cert: PendingCert,
}

/// Manages live graphical remote-desktop sessions.
#[derive(Clone)]
pub struct GraphicalSessionManager {
    sessions: Arc<Mutex<HashMap<String, GraphicalSession>>>,
    registry: Arc<ConnectionTypeRegistry>,
    /// Persisted per-host RDP certificate trust store (#1767).
    trust_store: Arc<RdpTrustStore>,
}

impl GraphicalSessionManager {
    /// Create a new manager over the given connection-type registry, persisting
    /// RDP certificate trust to `trust_store`.
    pub fn new(registry: Arc<ConnectionTypeRegistry>, trust_store: Arc<RdpTrustStore>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            registry,
            trust_store,
        }
    }

    /// The RDP certificate trust store backing this manager, for the
    /// trust-management commands (#1784).
    pub fn trust_store(&self) -> &Arc<RdpTrustStore> {
        &self.trust_store
    }

    /// Number of live graphical sessions.
    pub async fn session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// Connect a new graphical session and start fanning its events out.
    ///
    /// Returns the new session id. Drives the state machine through
    /// `Connecting → Authenticating → Active`, emitting `remote-desktop-state`
    /// at each step, then spawns the frame and cursor pumps.
    pub async fn connect<S: GraphicalEventSink>(
        &self,
        type_id: &str,
        settings: serde_json::Value,
        sink: S,
    ) -> Result<String, TerminalError> {
        if self.session_count().await >= MAX_GRAPHICAL_SESSIONS {
            return Err(TerminalError::SpawnFailed(
                "Maximum number of graphical sessions reached".to_string(),
            ));
        }

        let session_id = uuid::Uuid::new_v4().to_string();
        let state = Arc::new(Mutex::new(SessionStateMachine::new()));

        // Connecting.
        emit_state(&sink, &session_id, GraphicalState::Connecting, 0, None);

        let mut connection = self
            .registry
            .create(type_id)
            .map_err(|e| TerminalError::ConnectionFailed(e.to_string()))?;

        // Guard: only graphical types belong here (graphical() returns Some only
        // once connected, so gate on the declared capability instead).
        if !connection.capabilities().graphical {
            return Err(TerminalError::ConnectionFailed(format!(
                "Connection type '{type_id}' is not a graphical remote-desktop type"
            )));
        }

        // The host keys the certificate trust store (#1767). Read it before
        // `settings` is consumed by `connect`; default to the type id so a
        // config without a host still keys deterministically.
        let host = settings
            .get("host")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(type_id)
            .to_string();

        // Authenticating → establish.
        emit_state(&sink, &session_id, GraphicalState::Authenticating, 0, None);
        if let Err(e) = connection.connect(settings).await {
            let msg = e.to_string();
            warn!(session_id = %session_id, error = %msg, "graphical connect failed");
            let mut sm = state.lock().await;
            sm.connect_failed();
            emit_state(
                &sink,
                &session_id,
                GraphicalState::ConnectFailed,
                0,
                Some(msg.clone()),
            );
            return Err(TerminalError::ConnectionFailed(msg));
        }

        // Subscribe to the framebuffer surface (and any cert-prompt channel)
        // before marking active.
        let (frame_rx, cursor_rx, cert_rx) = {
            let backend = connection.graphical().ok_or_else(|| {
                TerminalError::ConnectionFailed(
                    "connected graphical backend did not expose a framebuffer surface".to_string(),
                )
            })?;
            (
                backend.subscribe_frames(),
                backend.subscribe_cursor(),
                backend.subscribe_cert_prompts(),
            )
        };

        {
            let mut sm = state.lock().await;
            sm.transport_up();
            sm.activated();
        }
        emit_state(&sink, &session_id, GraphicalState::Active, 0, None);
        info!(session_id = %session_id, type_id, "graphical session active");

        // The connection is shared with the cert-prompt pump (which drives
        // `send_cert_decision` on auto-accept) and the command handlers.
        let connection = Arc::new(Mutex::new(connection));
        let pending_cert: PendingCert = Arc::new(Mutex::new(None));

        // Spawn the frame + cursor pumps.
        let mut tasks = Vec::new();
        {
            let sink = sink.clone();
            let sid = session_id.clone();
            let state = state.clone();
            tasks.push(tokio::spawn(frame_pump(sid, frame_rx, sink, state)));
        }
        {
            let sink = sink.clone();
            let sid = session_id.clone();
            tasks.push(tokio::spawn(cursor_pump(sid, cursor_rx, sink)));
        }
        // The cert-prompt pump only exists for backends that expose the channel
        // (RDP); VNC/mock return `None` and never reach this branch (#1767).
        if let Some(cert_rx) = cert_rx {
            let sink = sink.clone();
            let sid = session_id.clone();
            tasks.push(tokio::spawn(cert_pump(
                sid,
                host,
                cert_rx,
                sink,
                connection.clone(),
                self.trust_store.clone(),
                pending_cert.clone(),
            )));
        }

        let session = GraphicalSession {
            connection,
            state,
            tasks,
            type_id: type_id.to_string(),
            pending_cert,
        };
        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), session);

        Ok(session_id)
    }

    /// Deliver the user's verdict for a pending certificate prompt (#1767).
    ///
    /// On "Accept for host" (`accept && remember`) the presented fingerprint is
    /// persisted to the trust store so the host is not prompted again; the
    /// verdict is then routed down to the backend, which is blocking its connect
    /// on it. Plain "Accept" is session-scoped (not remembered); "Reject" aborts.
    pub async fn cert_decision(
        &self,
        session_id: &str,
        accept: bool,
        remember: bool,
    ) -> Result<(), TerminalError> {
        let (conn, pending) = {
            let sessions = self.sessions.lock().await;
            let s = sessions
                .get(session_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
            (s.connection.clone(), s.pending_cert.clone())
        };

        // Persist first (so a remembered decision survives even if the backend
        // send races a teardown), then clear the pending marker.
        let pending_entry = pending.lock().await.take();
        if accept && remember {
            if let Some((host, fingerprint)) = &pending_entry {
                self.trust_store.remember(host, fingerprint);
            }
        }

        let guard = conn.lock().await;
        let backend = guard
            .graphical()
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        backend
            .send_cert_decision(accept, remember)
            .await
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }

    /// Forward a protocol-agnostic input event to a session's backend.
    pub async fn send_input(
        &self,
        session_id: &str,
        event: InputEvent,
    ) -> Result<(), TerminalError> {
        let conn = self.connection_of(session_id).await?;
        let guard = conn.lock().await;
        let backend = guard
            .graphical()
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        backend
            .send_input(event)
            .await
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }

    /// Ask a session's backend to re-emit a full framebuffer frame.
    ///
    /// Used when a window (re)attaches to a still-live graphical session after a
    /// cross-window tab move (#1904): the destination canvas is blank until the
    /// next full frame, so this forces a prompt repaint instead of waiting for
    /// the protocol's next natural keyframe. The re-emitted frame flows out on
    /// `remote-desktop-frame` through the session's already-running frame pump.
    pub async fn request_full_frame(&self, session_id: &str) -> Result<(), TerminalError> {
        let conn = self.connection_of(session_id).await?;
        let guard = conn.lock().await;
        let backend = guard
            .graphical()
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        backend
            .request_full_frame()
            .await
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }

    /// Request a new session resolution in pixels.
    pub async fn resize(
        &self,
        session_id: &str,
        width_px: u16,
        height_px: u16,
        sink: impl GraphicalEventSink,
    ) -> Result<(), TerminalError> {
        let (conn, state) = self.session_handles(session_id).await?;
        {
            let mut sm = state.lock().await;
            if sm.resize_requested() == GraphicalState::Resizing {
                emit_state(
                    &sink,
                    session_id,
                    GraphicalState::Resizing,
                    sm.reconnect_attempts(),
                    None,
                );
            }
        }
        let result = {
            let guard = conn.lock().await;
            let backend = guard
                .graphical()
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
            backend
                .resize(width_px, height_px)
                .await
                .map_err(|e| TerminalError::InternalError(e.to_string()))
        };
        {
            let mut sm = state.lock().await;
            let s = sm.resize_complete();
            emit_state(&sink, session_id, s, sm.reconnect_attempts(), None);
        }
        result
    }

    /// Push local clipboard text to a session's remote, and echo it back as a
    /// `remote-desktop-clipboard` event so the shared clipboard panel confirms
    /// the sync landed.
    pub async fn send_clipboard(
        &self,
        session_id: &str,
        text: String,
        sink: impl GraphicalEventSink,
    ) -> Result<(), TerminalError> {
        let conn = self.connection_of(session_id).await?;
        {
            let guard = conn.lock().await;
            let backend = guard
                .graphical()
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
            backend
                .set_clipboard(text.clone())
                .await
                .map_err(|e| TerminalError::InternalError(e.to_string()))?;
        }
        sink.emit_clipboard(&RemoteDesktopClipboardEvent {
            session_id: session_id.to_string(),
            text,
        });
        Ok(())
    }

    /// Read the remote clipboard text, if any.
    pub async fn get_clipboard(&self, session_id: &str) -> Result<Option<String>, TerminalError> {
        let conn = self.connection_of(session_id).await?;
        let guard = conn.lock().await;
        let backend = guard
            .graphical()
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        Ok(backend.get_clipboard().await)
    }

    /// The files the remote most recently copied to its clipboard, surfaced for a
    /// local paste with delayed rendering (#1793/#1804).
    ///
    /// Empty unless the backend supports remote→host file transfer, the host
    /// advertised delayed rendering (a platform capability, see
    /// [`host_supports_clipboard_delayed_render`](termihub_core::backends::rdp_sidecar::host_supports_clipboard_delayed_render)),
    /// and the remote actually copied files. The bytes are **not** fetched here —
    /// that is deferred to [`Self::fetch_remote_clipboard_file`], invoked on the
    /// real paste gesture.
    pub async fn remote_clipboard_files(
        &self,
        session_id: &str,
    ) -> Result<Vec<RemoteClipboardFile>, TerminalError> {
        let conn = self.connection_of(session_id).await?;
        let guard = conn.lock().await;
        let backend = guard
            .graphical()
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        Ok(backend.remote_clipboard_files().await)
    }

    /// Fetch one surfaced remote-clipboard file's bytes on demand (delayed
    /// rendering, #1793/#1804), staging them into a sanitized, bounded temp file
    /// and returning its path. `index` must be one a prior
    /// [`Self::remote_clipboard_files`] surfaced.
    ///
    /// Only the platform-native OS-clipboard binding calls this (on the real paste
    /// gesture); macOS (`macos_clipboard`), Windows (`windows_clipboard`), and
    /// Linux (`linux_clipboard`) are all wired. Off those platforms it has no
    /// in-crate caller yet, so the dead-code lint is suppressed there rather than
    /// deleting a method the pending binding needs.
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "linux", windows)),
        allow(dead_code)
    )]
    pub async fn fetch_remote_clipboard_file(
        &self,
        session_id: &str,
        index: u32,
    ) -> Result<std::path::PathBuf, TerminalError> {
        let conn = self.connection_of(session_id).await?;
        let guard = conn.lock().await;
        let backend = guard
            .graphical()
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        backend
            .fetch_remote_clipboard_file(index)
            .await
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }

    /// Disconnect and clean up a graphical session.
    pub async fn disconnect(
        &self,
        session_id: &str,
        sink: impl GraphicalEventSink,
    ) -> Result<(), TerminalError> {
        let session = self.sessions.lock().await.remove(session_id);
        let Some(session) = session else {
            return Err(TerminalError::SessionNotFound(session_id.to_string()));
        };
        for task in &session.tasks {
            task.abort();
        }
        {
            let mut sm = session.state.lock().await;
            sm.closed();
        }
        {
            let mut guard = session.connection.lock().await;
            if let Err(e) = guard.disconnect().await {
                debug!(session_id, type_id = %session.type_id, error = %e, "graphical disconnect error");
            }
        }
        emit_state(&sink, session_id, GraphicalState::Closed, 0, None);
        Ok(())
    }

    /// Look up a session's shared connection handle.
    async fn connection_of(
        &self,
        session_id: &str,
    ) -> Result<Arc<Mutex<Box<dyn ConnectionType>>>, TerminalError> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|s| s.connection.clone())
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))
    }

    /// Look up a session's connection + state handles.
    async fn session_handles(
        &self,
        session_id: &str,
    ) -> Result<
        (
            Arc<Mutex<Box<dyn ConnectionType>>>,
            Arc<Mutex<SessionStateMachine>>,
        ),
        TerminalError,
    > {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|s| (s.connection.clone(), s.state.clone()))
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))
    }
}

/// Emit a state event, cloning the small payload.
fn emit_state<S: GraphicalEventSink>(
    sink: &S,
    session_id: &str,
    state: GraphicalState,
    reconnect_attempt: u32,
    message: Option<String>,
) {
    sink.emit_state(&RemoteDesktopStateEvent {
        session_id: session_id.to_string(),
        state,
        reconnect_attempt,
        message,
    });
}

/// Pump frame updates from the backend to `remote-desktop-frame` events until
/// the channel closes.
async fn frame_pump<S: GraphicalEventSink>(
    session_id: String,
    mut frames: termihub_core::connection::FrameReceiver,
    sink: S,
    state: Arc<Mutex<SessionStateMachine>>,
) {
    while let Some(frame) = frames.recv().await {
        sink.emit_frame(&RemoteDesktopFrameEvent {
            session_id: session_id.clone(),
            frame,
        });
    }
    // Channel closed. If the session is still live (not an intentional
    // disconnect), record the drop so the state reflects it.
    let mut sm = state.lock().await;
    if sm.state().is_live() {
        let dropped = sm.connection_dropped();
        debug!(session_id = %session_id, ?dropped, "graphical frame channel closed");
        sink.emit_state(&RemoteDesktopStateEvent {
            session_id: session_id.clone(),
            state: dropped,
            reconnect_attempt: sm.reconnect_attempts(),
            message: None,
        });
    }
}

/// Pump cursor updates from the backend to `remote-desktop-cursor` events.
async fn cursor_pump<S: GraphicalEventSink>(
    session_id: String,
    mut cursors: termihub_core::connection::CursorReceiver,
    sink: S,
) {
    while let Some(cursor) = cursors.recv().await {
        sink.emit_cursor(&RemoteDesktopCursorEvent {
            session_id: session_id.clone(),
            cursor,
        });
    }
}

/// Pump interactive certificate-trust prompts from the backend (#1767).
///
/// For each [`CertPrompt`] the sidecar raises, consult the trust store:
/// - **Trusted** (fingerprint already remembered for this host) → auto-accept
///   silently, never bothering the user.
/// - **Unknown** (first contact) → surface a `remote-desktop-cert-prompt` event
///   for the accept/reject dialog.
/// - **Changed** (host known, fingerprint differs) → surface the same event with
///   `changed: true` so the dialog warns about a possible MITM.
///
/// For the prompted cases the verdict arrives asynchronously via
/// [`cert_decision`](GraphicalSessionManager::cert_decision); `pending` records
/// the host + fingerprint so that path can persist an "accept for host".
#[allow(clippy::too_many_arguments)]
async fn cert_pump<S: GraphicalEventSink>(
    session_id: String,
    host: String,
    mut prompts: CertPromptReceiver,
    sink: S,
    connection: Arc<Mutex<Box<dyn ConnectionType>>>,
    trust_store: Arc<RdpTrustStore>,
    pending: PendingCert,
) {
    while let Some(prompt) = prompts.recv().await {
        let CertPrompt {
            fingerprint,
            subject,
            issuer,
        } = prompt;

        match trust_store.lookup(&host, &fingerprint) {
            TrustLookup::Trusted => {
                // Remembered: accept silently, no dialog.
                debug!(session_id = %session_id, host = %host, "auto-accepting remembered RDP certificate");
                let guard = connection.lock().await;
                if let Some(backend) = guard.graphical() {
                    if let Err(e) = backend.send_cert_decision(true, false).await {
                        warn!(session_id = %session_id, error = %e, "failed to auto-accept remembered cert");
                    }
                }
            }
            lookup @ (TrustLookup::Unknown | TrustLookup::Changed) => {
                let changed = lookup == TrustLookup::Changed;
                *pending.lock().await = Some((host.clone(), fingerprint.clone()));
                if changed {
                    warn!(session_id = %session_id, host = %host, "RDP certificate fingerprint CHANGED for a trusted host (possible MITM)");
                }
                sink.emit_cert_prompt(&RemoteDesktopCertPromptEvent {
                    session_id: session_id.clone(),
                    host: host.clone(),
                    fingerprint,
                    subject,
                    issuer,
                    changed,
                });
                // The verdict returns via `cert_decision`; keep pumping in case
                // the backend re-prompts (it will not for a single connect).
            }
        }
    }
}

#[cfg(all(test, feature = "mock-remote-desktop"))]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    /// Recording sink for assertions without a Tauri runtime.
    #[derive(Clone, Default)]
    struct RecordingSink {
        frames: Arc<StdMutex<usize>>,
        /// Frames whose dirty rect covers the whole surface (a full repaint).
        full_frames: Arc<StdMutex<usize>>,
        cursors: Arc<StdMutex<usize>>,
        states: Arc<StdMutex<Vec<GraphicalState>>>,
        cert_prompts: Arc<StdMutex<Vec<RemoteDesktopCertPromptEvent>>>,
    }

    impl GraphicalEventSink for RecordingSink {
        fn emit_frame(&self, event: &RemoteDesktopFrameEvent) {
            *self.frames.lock().unwrap() += 1;
            let f = &event.frame;
            if f.rects
                .iter()
                .any(|r| r.x == 0 && r.y == 0 && r.width == f.width && r.height == f.height)
            {
                *self.full_frames.lock().unwrap() += 1;
            }
        }
        fn emit_cursor(&self, _event: &RemoteDesktopCursorEvent) {
            *self.cursors.lock().unwrap() += 1;
        }
        fn emit_clipboard(&self, _event: &RemoteDesktopClipboardEvent) {}
        fn emit_state(&self, event: &RemoteDesktopStateEvent) {
            self.states.lock().unwrap().push(event.state);
        }
        fn emit_cert_prompt(&self, event: &RemoteDesktopCertPromptEvent) {
            self.cert_prompts.lock().unwrap().push(event.clone());
        }
    }

    fn manager() -> GraphicalSessionManager {
        let registry = Arc::new(crate::session::registry::build_desktop_registry());
        GraphicalSessionManager::new(registry, Arc::new(RdpTrustStore::in_memory()))
    }

    #[tokio::test]
    async fn connect_emits_states_and_frames() {
        let mgr = manager();
        let sink = RecordingSink::default();
        let sid = mgr
            .connect("mock-remote-desktop", serde_json::json!({}), sink.clone())
            .await
            .expect("connect");
        assert_eq!(mgr.session_count().await, 1);

        let states = sink.states.lock().unwrap().clone();
        assert_eq!(
            states,
            vec![
                GraphicalState::Connecting,
                GraphicalState::Authenticating,
                GraphicalState::Active,
            ]
        );

        // Frames flow within a moment.
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            *sink.frames.lock().unwrap() >= 1,
            "frames should be emitted"
        );
        assert!(
            *sink.cursors.lock().unwrap() >= 1,
            "cursors should be emitted"
        );

        mgr.disconnect(&sid, sink.clone())
            .await
            .expect("disconnect");
        assert_eq!(mgr.session_count().await, 0);
        assert!(sink
            .states
            .lock()
            .unwrap()
            .contains(&GraphicalState::Closed));
    }

    #[tokio::test]
    async fn resize_input_and_clipboard_round_trip() {
        let mgr = manager();
        let sink = RecordingSink::default();
        let sid = mgr
            .connect("mock-remote-desktop", serde_json::json!({}), sink.clone())
            .await
            .expect("connect");

        mgr.resize(&sid, 640, 480, sink.clone())
            .await
            .expect("resize");
        mgr.send_input(
            &sid,
            InputEvent::Key {
                code: "KeyA".to_string(),
                pressed: true,
            },
        )
        .await
        .expect("input");

        assert_eq!(mgr.session_count().await, 1);
        mgr.send_clipboard(&sid, "hello".to_string(), sink.clone())
            .await
            .expect("set clipboard");
        assert_eq!(
            mgr.get_clipboard(&sid).await.expect("get"),
            Some("hello".to_string())
        );

        mgr.disconnect(&sid, sink).await.expect("disconnect");
    }

    #[tokio::test]
    async fn request_full_frame_emits_a_frame_on_attach() {
        // The full-frame-on-attach hook (#1904): a moved graphical tab landing in
        // a new window asks the backend to re-paint, which flows out as extra
        // `remote-desktop-frame` events through the running pump.
        let mgr = manager();
        let sink = RecordingSink::default();
        let sid = mgr
            .connect("mock-remote-desktop", serde_json::json!({}), sink.clone())
            .await
            .expect("connect");

        // Let the initial background frame drain so the baseline is settled.
        tokio::time::sleep(Duration::from_millis(250)).await;
        let before = *sink.full_frames.lock().unwrap();

        mgr.request_full_frame(&sid)
            .await
            .expect("full frame on attach");

        // A *full-surface* repaint follows within a moment — the ongoing
        // moving-block ticks only paint a small dirty rect, so a rising
        // full-frame count is attributable to the hook.
        tokio::time::sleep(Duration::from_millis(250)).await;
        let after = *sink.full_frames.lock().unwrap();
        assert!(
            after > before,
            "request_full_frame should emit a full-surface repaint (before={before}, after={after})"
        );

        // Unknown sessions are reported, not silently ignored.
        assert!(matches!(
            mgr.request_full_frame("nope").await,
            Err(TerminalError::SessionNotFound(_))
        ));

        mgr.disconnect(&sid, sink).await.expect("disconnect");
    }

    #[tokio::test]
    async fn remote_clipboard_files_default_empty_and_fetch_errors() {
        // The mock backend keeps the seam's default impls: no remote clipboard
        // files, and a fetch is unsupported. This exercises the manager
        // pass-throughs (#1804) end to end without a real RDP sidecar.
        let mgr = manager();
        let sink = RecordingSink::default();
        let sid = mgr
            .connect("mock-remote-desktop", serde_json::json!({}), sink.clone())
            .await
            .expect("connect");

        assert!(mgr
            .remote_clipboard_files(&sid)
            .await
            .expect("list")
            .is_empty());
        let err = mgr
            .fetch_remote_clipboard_file(&sid, 0)
            .await
            .expect_err("fetch unsupported on the mock backend");
        assert!(matches!(err, TerminalError::InternalError(_)));

        // Unknown sessions are reported, not silently empty.
        assert!(matches!(
            mgr.remote_clipboard_files("nope").await,
            Err(TerminalError::SessionNotFound(_))
        ));

        mgr.disconnect(&sid, sink).await.expect("disconnect");
    }

    #[tokio::test]
    async fn rejects_non_graphical_type() {
        let mgr = manager();
        let sink = RecordingSink::default();
        let err = mgr
            .connect("telnet", serde_json::json!({}), sink)
            .await
            .expect_err("telnet is not graphical");
        assert!(matches!(err, TerminalError::ConnectionFailed(_)));
    }

    #[tokio::test]
    async fn unknown_session_errors() {
        let mgr = manager();
        let err = mgr
            .send_input(
                "nope",
                InputEvent::Key {
                    code: "KeyA".to_string(),
                    pressed: true,
                },
            )
            .await
            .expect_err("unknown session");
        assert!(matches!(err, TerminalError::SessionNotFound(_)));
    }

    /// Drive the cert pump directly with a known trust-store state and assert the
    /// three routing outcomes (#1767): remembered → no dialog (auto-accept),
    /// unknown → a first-contact prompt, changed → a MITM-flagged prompt.
    async fn run_cert_pump(
        trust_store: Arc<RdpTrustStore>,
        host: &str,
        fingerprint: &str,
    ) -> RecordingSink {
        use termihub_core::connection::ConnectionType;
        let sink = RecordingSink::default();
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        // A disconnected mock backend: `graphical()` is None, so the auto-accept
        // path is a no-op send — exactly what we want to observe (no dialog).
        let registry = crate::session::registry::build_desktop_registry();
        let conn: Box<dyn ConnectionType> = registry.create("mock-remote-desktop").unwrap();
        let connection = Arc::new(Mutex::new(conn));
        let pending: PendingCert = Arc::new(Mutex::new(None));

        let handle = tokio::spawn(cert_pump(
            "sid".to_string(),
            host.to_string(),
            rx,
            sink.clone(),
            connection,
            trust_store,
            pending,
        ));

        tx.send(CertPrompt {
            fingerprint: fingerprint.to_string(),
            subject: None,
            issuer: None,
        })
        .await
        .unwrap();
        drop(tx);
        handle.await.unwrap();
        sink
    }

    #[tokio::test]
    async fn cert_pump_auto_accepts_remembered_fingerprint() {
        let store = Arc::new(RdpTrustStore::in_memory());
        store.remember("h:3389", "sha256:AA");
        let sink = run_cert_pump(store, "h:3389", "sha256:AA").await;
        // Remembered → no user dialog.
        assert!(sink.cert_prompts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cert_pump_prompts_unknown_host() {
        let store = Arc::new(RdpTrustStore::in_memory());
        let sink = run_cert_pump(store, "h:3389", "sha256:AA").await;
        let prompts = sink.cert_prompts.lock().unwrap();
        assert_eq!(prompts.len(), 1);
        assert!(!prompts[0].changed, "first contact is not a MITM warning");
        assert_eq!(prompts[0].fingerprint, "sha256:AA");
    }

    #[tokio::test]
    async fn cert_pump_flags_changed_fingerprint_as_mitm() {
        let store = Arc::new(RdpTrustStore::in_memory());
        store.remember("h:3389", "sha256:AA");
        // A different key for a remembered host.
        let sink = run_cert_pump(store, "h:3389", "sha256:BB").await;
        let prompts = sink.cert_prompts.lock().unwrap();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].changed, "changed fingerprint must warn (MITM)");
    }
}
