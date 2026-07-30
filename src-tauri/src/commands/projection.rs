//! Tauri command wiring for the stateless-UI projection substrate (#2149).
//!
//! Rides the desktop IPC transport: `intent_dispatch` answers with an
//! [`IntentAck`]; `projection_subscribe` returns the region's current
//! [`SnapshotFrame`] and opens a per-region `tauri::ipc::Channel` for the diff
//! stream (efficient per-region push, avoiding a global event fan-in). The
//! terminal `terminal-output` byte stream is a separate, untouched channel.
//!
//! Phase 1 wires an **empty** handler registry (mechanism only; no domain
//! migrated yet) — the channels exist and round-trip, and intents for
//! unregistered kinds are rejected with `unknown_intent`. Domains register
//! routes as they migrate (Phase 2+, #2150).

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::projection::{
    Dispatcher, HandlerRegistry, Intent, IntentAck, ProjectionError, ProjectionFrame,
    ProjectionSink, Projector, SnapshotFrame,
};

/// Managed Tauri state holding the projector and the intent dispatcher.
pub struct ProjectionState {
    pub projector: Arc<Projector>,
    pub dispatcher: Arc<Dispatcher>,
}

impl ProjectionState {
    pub fn new() -> Self {
        let projector = Arc::new(Projector::new());
        let dispatcher = Arc::new(Dispatcher::new(
            projector.clone(),
            Arc::new(HandlerRegistry::new()),
        ));
        Self {
            projector,
            dispatcher,
        }
    }
}

impl Default for ProjectionState {
    fn default() -> Self {
        Self::new()
    }
}

/// A [`ProjectionSink`] backed by a per-region Tauri IPC channel.
struct ChannelSink(Channel<ProjectionFrame>);

impl ProjectionSink for ChannelSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        self.0
            .send(frame.clone())
            .map_err(|e| ProjectionError::SinkClosed(e.to_string()))
    }
}

/// Channel 1 — dispatch a user intent; returns the ack receipt. The result of
/// an accepted intent arrives separately as a projection diff.
#[tauri::command]
pub fn intent_dispatch(intent: Intent, state: State<'_, ProjectionState>) -> IntentAck {
    state.dispatcher.dispatch(intent)
}

/// Channel 2 — attach to a region. Returns the current snapshot and begins the
/// diff stream on `channel`. `subscription_id` is client-generated and passed
/// again to `projection_unsubscribe` to detach.
#[tauri::command]
pub fn projection_subscribe(
    region: String,
    subscription_id: String,
    client_id: String,
    channel: Channel<ProjectionFrame>,
    state: State<'_, ProjectionState>,
) -> SnapshotFrame {
    state.projector.subscribe(
        &region,
        subscription_id,
        client_id,
        Arc::new(ChannelSink(channel)),
    )
}

/// Detach a subscription. Idempotent.
#[tauri::command]
pub fn projection_unsubscribe(
    region: String,
    subscription_id: String,
    state: State<'_, ProjectionState>,
) {
    state.projector.unsubscribe(&region, &subscription_id);
}

/// Re-baseline a region after a detected gap or reconnect. Returns `None` when
/// `have` already matches the region's current version.
#[tauri::command]
pub fn projection_resync(
    region: String,
    have: Option<u64>,
    state: State<'_, ProjectionState>,
) -> Option<SnapshotFrame> {
    state.projector.resync(&region, have)
}
