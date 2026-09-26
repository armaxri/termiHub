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
//!
//! # Client identity (TAURI-012, #3444)
//!
//! The `client_id` on an intent or subscription is asserted by the webview and
//! is **not trusted**. Every command below takes the invoking
//! [`tauri::WebviewWindow`] and authorizes the call against its label through
//! [`ClientIdentities`]: a window may act only as client ids it owns (bound to
//! it on first use) and may touch only its own client-scoped regions
//! (`<domain>@<clientId>`). A mismatch is rejected with a typed
//! [`ClientIdentityError`] and logged. The authorization logic lives in the
//! transport-neutral `*_as` methods on [`ProjectionState`] so it is unit-tested
//! without a Tauri runtime; the commands only supply the window label.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;
use tracing::warn;

use crate::projection::{
    ClientIdentities, ClientIdentityError, Dispatcher, HandlerRegistry, Intent, IntentAck,
    IntentHandler, ProjectionError, ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};

/// Managed Tauri state holding the projector, the intent dispatcher, and the
/// `client_id → window` identity bindings.
pub struct ProjectionState {
    pub projector: Arc<Projector>,
    pub dispatcher: Arc<Dispatcher>,
    /// Binds each asserted `client_id` to the window that first used it
    /// (TAURI-012). See the module docs.
    pub identities: Arc<ClientIdentities>,
}

impl ProjectionState {
    /// An empty projector + dispatcher whose registry serves no domain yet
    /// (every intent is rejected `unknown_intent`).
    pub fn new() -> Self {
        Self::with_handler(Arc::new(HandlerRegistry::new()))
    }

    /// Build the state around a pre-populated intent handler. Domains register
    /// their routes on a [`HandlerRegistry`] and pass it here (Phase 2+); the
    /// tunnel pilot wires `tunnel.*` this way in `lib.rs` once the tunnel
    /// manager is managed. See [`crate::tunnel::projection`].
    pub fn with_handler(handler: Arc<dyn IntentHandler>) -> Self {
        let projector = Arc::new(Projector::new());
        let dispatcher = Arc::new(Dispatcher::new(projector.clone(), handler));
        Self {
            projector,
            dispatcher,
            identities: Arc::new(ClientIdentities::new()),
        }
    }

    /// Dispatch `intent` on behalf of the principal `caller` (the invoking
    /// window's label). Rejects — without running any handler — an intent whose
    /// `client_id` is owned by a different principal.
    pub fn dispatch_as(&self, caller: &str, intent: Intent) -> IntentAck {
        if let Err(e) = self.identities.authorize(caller, &intent.client_id) {
            log_denied("intent_dispatch", caller, &e);
            return IntentAck::rejected(intent.intent_id, e.code(), e.to_string());
        }
        self.dispatcher.dispatch(intent)
    }

    /// Attach `sink` to `region` on behalf of `caller`. The asserted
    /// `client_id` must be the caller's, and a client-scoped region must belong
    /// to one of the caller's clients.
    pub fn subscribe_as(
        &self,
        caller: &str,
        region: &str,
        subscription_id: String,
        client_id: String,
        sink: Arc<dyn ProjectionSink>,
    ) -> Result<SnapshotFrame, ClientIdentityError> {
        self.identities
            .authorize(caller, &client_id)
            .and_then(|()| self.identities.authorize_region(caller, region))
            .inspect_err(|e| log_denied("projection_subscribe", caller, e))?;
        Ok(self
            .projector
            .subscribe(region, subscription_id, client_id, sink))
    }

    /// Detach `subscription_id` from `region` on behalf of `caller`. Only
    /// subscriptions held by the caller's own clients are removed; a
    /// subscription of another window is left untouched (idempotent no-op).
    pub fn unsubscribe_as(
        &self,
        caller: &str,
        region: &str,
        subscription_id: &str,
    ) -> Result<(), ClientIdentityError> {
        self.identities
            .authorize_region(caller, region)
            .inspect_err(|e| log_denied("projection_unsubscribe", caller, e))?;
        let identities = &self.identities;
        self.projector
            .unsubscribe_owned(region, subscription_id, |client| {
                identities.is_owned_by(caller, client)
            });
        Ok(())
    }

    /// Re-baseline `region` for `caller`. A client-scoped region is readable
    /// only by the window that owns its client.
    pub fn resync_as(
        &self,
        caller: &str,
        region: &str,
        have: Option<u64>,
    ) -> Result<Option<SnapshotFrame>, ClientIdentityError> {
        self.identities
            .authorize_region(caller, region)
            .inspect_err(|e| log_denied("projection_resync", caller, e))?;
        Ok(self.projector.resync(region, have))
    }

    /// Forget every client identity bound to `principal` and detach its
    /// subscriptions (its window was destroyed). Returns the number of
    /// subscriptions removed.
    pub fn release_principal(&self, principal: &str) -> usize {
        let released = self.identities.release_principal(principal);
        self.projector.unsubscribe_clients_everywhere(&released)
    }
}

fn log_denied(command: &str, caller: &str, error: &ClientIdentityError) {
    warn!(
        command,
        window = caller,
        code = error.code(),
        "Projection call refused: {error} (TAURI-012)"
    );
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
/// an accepted intent arrives separately as a projection diff. The intent's
/// `clientId` must belong to the invoking window (TAURI-012).
#[tauri::command]
pub fn intent_dispatch(
    intent: Intent,
    window: tauri::WebviewWindow,
    state: State<'_, ProjectionState>,
) -> IntentAck {
    state.dispatch_as(window.label(), intent)
}

/// Channel 2 — attach to a region. Returns the current snapshot and begins the
/// diff stream on `channel`. `subscription_id` is client-generated and passed
/// again to `projection_unsubscribe` to detach. `client_id` (and a
/// client-scoped region's `@<clientId>`) must belong to the invoking window.
#[tauri::command]
pub fn projection_subscribe(
    region: String,
    subscription_id: String,
    client_id: String,
    channel: Channel<ProjectionFrame>,
    window: tauri::WebviewWindow,
    state: State<'_, ProjectionState>,
) -> Result<SnapshotFrame, ClientIdentityError> {
    state.subscribe_as(
        window.label(),
        &region,
        subscription_id,
        client_id,
        Arc::new(ChannelSink(channel)),
    )
}

/// Detach one of the invoking window's subscriptions. Idempotent.
#[tauri::command]
pub fn projection_unsubscribe(
    region: String,
    subscription_id: String,
    window: tauri::WebviewWindow,
    state: State<'_, ProjectionState>,
) -> Result<(), ClientIdentityError> {
    state.unsubscribe_as(window.label(), &region, &subscription_id)
}

/// Re-baseline a region after a detected gap or reconnect. Returns `None` when
/// `have` already matches the region's current version.
#[tauri::command]
pub fn projection_resync(
    region: String,
    have: Option<u64>,
    window: tauri::WebviewWindow,
    state: State<'_, ProjectionState>,
) -> Result<Option<SnapshotFrame>, ClientIdentityError> {
    state.resync_as(window.label(), &region, have)
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
