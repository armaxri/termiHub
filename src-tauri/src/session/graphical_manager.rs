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
    ConnectionType, ConnectionTypeRegistry, CursorUpdate, FrameUpdate, GraphicalState, InputEvent,
    SessionStateMachine,
};

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
}

// ── Session record ─────────────────────────────────────────────────

/// A live graphical session.
struct GraphicalSession {
    /// The connected backend, shared so command handlers can drive input /
    /// resize / clipboard while the pump tasks run independently.
    connection: Arc<Mutex<Box<dyn ConnectionType>>>,
    /// The shared lifecycle state machine.
    state: Arc<Mutex<SessionStateMachine>>,
    /// Frame + cursor pump tasks, aborted on disconnect.
    tasks: Vec<JoinHandle<()>>,
    /// Backend type id (for diagnostics).
    type_id: String,
}

/// Manages live graphical remote-desktop sessions.
#[derive(Clone)]
pub struct GraphicalSessionManager {
    sessions: Arc<Mutex<HashMap<String, GraphicalSession>>>,
    registry: Arc<ConnectionTypeRegistry>,
}

impl GraphicalSessionManager {
    /// Create a new manager over the given connection-type registry.
    pub fn new(registry: Arc<ConnectionTypeRegistry>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            registry,
        }
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

        // Subscribe to the framebuffer surface before marking active.
        let (frame_rx, cursor_rx) = {
            let backend = connection.graphical().ok_or_else(|| {
                TerminalError::ConnectionFailed(
                    "connected graphical backend did not expose a framebuffer surface".to_string(),
                )
            })?;
            (backend.subscribe_frames(), backend.subscribe_cursor())
        };

        {
            let mut sm = state.lock().await;
            sm.transport_up();
            sm.activated();
        }
        emit_state(&sink, &session_id, GraphicalState::Active, 0, None);
        info!(session_id = %session_id, type_id, "graphical session active");

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

        let session = GraphicalSession {
            connection: Arc::new(Mutex::new(connection)),
            state,
            tasks,
            type_id: type_id.to_string(),
        };
        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), session);

        Ok(session_id)
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

#[cfg(all(test, feature = "mock-remote-desktop"))]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    /// Recording sink for assertions without a Tauri runtime.
    #[derive(Clone, Default)]
    struct RecordingSink {
        frames: Arc<StdMutex<usize>>,
        cursors: Arc<StdMutex<usize>>,
        states: Arc<StdMutex<Vec<GraphicalState>>>,
    }

    impl GraphicalEventSink for RecordingSink {
        fn emit_frame(&self, _event: &RemoteDesktopFrameEvent) {
            *self.frames.lock().unwrap() += 1;
        }
        fn emit_cursor(&self, _event: &RemoteDesktopCursorEvent) {
            *self.cursors.lock().unwrap() += 1;
        }
        fn emit_clipboard(&self, _event: &RemoteDesktopClipboardEvent) {}
        fn emit_state(&self, event: &RemoteDesktopStateEvent) {
            self.states.lock().unwrap().push(event.state);
        }
    }

    fn manager() -> GraphicalSessionManager {
        let registry = Arc::new(crate::session::registry::build_desktop_registry());
        GraphicalSessionManager::new(registry)
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
}
