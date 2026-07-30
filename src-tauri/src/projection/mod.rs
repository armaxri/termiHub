//! The stateless-UI projection substrate (#2149, Phase 1 of #2139).
//!
//! Server-authoritative, per-region **versioned diff channels** with
//! multi-subscriber fan-out. The backend is the single authoritative writer:
//! it applies an intent once, bumps the region version once, computes the diff
//! once, and fans that one diff out to every current subscriber. See the design
//! concept `docs/concepts/future/stateless-ui-projection-substrate.html`.
//!
//! This module is the transport-neutral core — it does not depend on Tauri, so
//! the whole loop (subscribe → snapshot, intent → diff fan-out, gap → resync)
//! is exercised in-memory by the test harness below. The Tauri command wiring
//! that rides a `tauri::ipc::Channel` lives in
//! [`crate::commands::projection`].
//!
//! # Scope (Phase 1)
//!
//! Mechanism only — no real domain is migrated onto the substrate. The two
//! generic channels land **beside** the existing ~206 typed commands and ~36
//! events (strangler migration); the terminal `terminal-output` byte stream is
//! a separate, untouched channel.

mod frame;
mod region;

pub use frame::{
    DiffFrame, DiffOp, Intent, IntentAck, IntentErrorInfo, IntentStatus, ProducedRegion,
    ProjectionFrame, SnapshotFrame,
};
pub use region::ProjectedStore;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

/// Errors raised while producing, delivering, or applying projection frames.
#[derive(Debug, thiserror::Error)]
pub enum ProjectionError {
    /// A subscriber's delivery sink is gone (closed channel / dead socket).
    #[error("subscriber sink closed: {0}")]
    SinkClosed(String),
    /// The semantic-op escape hatch has no RFC 6902 mapping and cannot be
    /// applied by the default structural applier.
    #[error("cannot apply semantic diff op '{0}' via RFC 6902")]
    UnsupportedSemanticOp(String),
    /// Applying a diff to a cached view model failed.
    #[error("failed to apply diff: {0}")]
    Apply(String),
}

// ── Structural diff / apply (RFC 6902, library-backed) ──────────────────────

/// Compute the ordered [`DiffOp`]s that turn `old` into `new`.
///
/// Backed by the `json-patch` crate's RFC 6902 differ, whose `diff` emits only
/// `add` / `remove` / `replace` — exactly the substrate's default op subset.
/// An empty result means the two view models are identical (a no-op change,
/// which the projector never emits a frame for).
pub fn compute_ops(old: &Value, new: &Value) -> Vec<DiffOp> {
    json_patch::diff(old, new)
        .0
        .into_iter()
        .filter_map(diffop_from_patch)
        .collect()
}

fn diffop_from_patch(op: json_patch::PatchOperation) -> Option<DiffOp> {
    use json_patch::PatchOperation as P;
    match op {
        P::Add(a) => Some(DiffOp::Add {
            path: a.path.as_str().to_string(),
            value: a.value,
        }),
        P::Remove(r) => Some(DiffOp::Remove {
            path: r.path.as_str().to_string(),
        }),
        P::Replace(r) => Some(DiffOp::Replace {
            path: r.path.as_str().to_string(),
            value: r.value,
        }),
        // `json_patch::diff` never emits move/copy/test; ignore defensively.
        _ => None,
    }
}

/// Apply ordered [`DiffOp`]s to a cached view model in place.
///
/// This is the reference applier the client cache mirrors (the TypeScript
/// [`ProjectionClient`] uses `fast-json-patch`). It rejects the semantic-op
/// escape hatch, which has no RFC 6902 mapping.
pub fn apply_ops(view: &mut Value, ops: &[DiffOp]) -> Result<(), ProjectionError> {
    let patch = ops_to_patch(ops)?;
    json_patch::patch(view, &patch).map_err(|e| ProjectionError::Apply(e.to_string()))
}

fn ops_to_patch(ops: &[DiffOp]) -> Result<json_patch::Patch, ProjectionError> {
    // Reject the semantic escape hatch up front; the rest of the subset shares
    // its serde shape with `json_patch::PatchOperation`, so a JSON round-trip
    // converts without a direct `jsonptr` dependency.
    if let Some(DiffOp::Semantic { name, .. }) =
        ops.iter().find(|op| matches!(op, DiffOp::Semantic { .. }))
    {
        return Err(ProjectionError::UnsupportedSemanticOp(name.clone()));
    }
    let json = serde_json::to_value(ops).map_err(|e| ProjectionError::Apply(e.to_string()))?;
    serde_json::from_value(json).map_err(|e| ProjectionError::Apply(e.to_string()))
}

// ── Subscription fan-out ────────────────────────────────────────────────────

/// A delivery handle for a region's diff stream.
///
/// Implemented by a `tauri::ipc::Channel<ProjectionFrame>` on desktop and a
/// WebSocket send half in remote-client mode. An `Err` return marks the
/// subscriber dead; the projector reaps it on the emit path.
pub trait ProjectionSink: Send + Sync {
    /// Deliver one frame. Returns `Err` if the sink is gone.
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError>;
}

struct Subscriber {
    /// Caller-owned subscription id (the frontend generates it and passes the
    /// same value to `subscribe` and `unsubscribe`).
    id: String,
    client_id: String,
    sink: Arc<dyn ProjectionSink>,
}

struct RegionState {
    version: u64,
    /// The current authoritative view model (the last emitted snapshot).
    view: Value,
    subscribers: Vec<Subscriber>,
}

impl RegionState {
    fn new(view: Value) -> Self {
        Self {
            version: 0,
            view,
            subscribers: Vec::new(),
        }
    }

    fn snapshot(&self, region: &str) -> SnapshotFrame {
        SnapshotFrame {
            region: region.to_string(),
            version: self.version,
            view: self.view.clone(),
        }
    }
}

/// The projector: owns the subscription registry (`region → subscribers`), the
/// per-region monotonic version counters, and the coalescing/diff step.
///
/// A single mutex over the region map gives the concept's "snapshot capture and
/// subscriber insertion under one region lock" guarantee, so a late joiner can
/// neither miss a diff that lands during attach nor receive one that predates
/// its snapshot.
#[derive(Default)]
pub struct Projector {
    regions: Mutex<HashMap<String, RegionState>>,
}

impl Projector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed a region's initial view model at version 0.
    ///
    /// Optional: `subscribe`/`publish` lazily create an absent region with a
    /// `null` view. Seeding lets a domain publish its real baseline before the
    /// first subscriber attaches.
    pub fn register_region(&self, region: &str, initial_view: Value) {
        let mut regions = self.lock();
        regions
            .entry(region.to_string())
            .or_insert_with(|| RegionState::new(initial_view));
    }

    /// Attach a subscriber and return the region's current snapshot.
    ///
    /// Snapshot capture and subscriber insertion happen under one lock, so the
    /// returned baseline and the diff stream that follows cannot interleave
    /// (invariant 1: snapshot-on-attach). Idempotent per `subscription_id`: a
    /// repeated id replaces the existing subscriber's sink.
    pub fn subscribe(
        &self,
        region: &str,
        subscription_id: impl Into<String>,
        client_id: impl Into<String>,
        sink: Arc<dyn ProjectionSink>,
    ) -> SnapshotFrame {
        let subscription_id = subscription_id.into();
        let mut regions = self.lock();
        let state = regions
            .entry(region.to_string())
            .or_insert_with(|| RegionState::new(Value::Null));
        state.subscribers.retain(|s| s.id != subscription_id);
        state.subscribers.push(Subscriber {
            id: subscription_id,
            client_id: client_id.into(),
            sink,
        });
        state.snapshot(region)
    }

    /// Detach a subscriber. Idempotent — a missing id is a no-op.
    pub fn unsubscribe(&self, region: &str, subscription_id: &str) {
        let mut regions = self.lock();
        if let Some(state) = regions.get_mut(region) {
            state.subscribers.retain(|s| s.id != subscription_id);
        }
    }

    /// Detach every subscription a client holds on a region (e.g. on client
    /// disconnect, when its individual subscription ids are not known here).
    /// Idempotent.
    pub fn unsubscribe_client(&self, region: &str, client_id: &str) {
        let mut regions = self.lock();
        if let Some(state) = regions.get_mut(region) {
            state.subscribers.retain(|s| s.client_id != client_id);
        }
    }

    /// Publish a region's new authoritative view model.
    ///
    /// Diffs the new view against the last emitted one; if nothing changed,
    /// returns `None` and emits no frame. Otherwise bumps the version by one,
    /// stores the new view, and fans a single [`DiffFrame`]
    /// (`base_version = V`, `version = V + 1`) out to every current subscriber,
    /// reaping any whose sink has gone. Returns the new version.
    ///
    /// Because the diff is computed against the *last emitted* view, many
    /// mutations collapsed into one `publish` call produce one diff — the
    /// concept's burst-coalescing, for free.
    pub fn publish(&self, region: &str, new_view: Value) -> Option<u64> {
        let mut regions = self.lock();
        let state = regions
            .entry(region.to_string())
            .or_insert_with(|| RegionState::new(Value::Null));

        let ops = compute_ops(&state.view, &new_view);
        if ops.is_empty() {
            return None;
        }
        let base_version = state.version;
        let version = base_version + 1;
        state.version = version;
        state.view = new_view;

        let frame = ProjectionFrame::Diff(DiffFrame {
            region: region.to_string(),
            base_version,
            version,
            ops,
        });
        Self::fan_out(state, &frame);
        Some(version)
    }

    /// Publish the current snapshot of a [`ProjectedStore`].
    pub fn publish_store(&self, store: &dyn ProjectedStore) -> Option<u64> {
        self.publish(store.region_id(), store.snapshot())
    }

    /// The region's current snapshot (creates an empty region if absent).
    pub fn snapshot(&self, region: &str) -> SnapshotFrame {
        let mut regions = self.lock();
        let state = regions
            .entry(region.to_string())
            .or_insert_with(|| RegionState::new(Value::Null));
        state.snapshot(region)
    }

    /// Re-baseline a region after a detected gap or a reconnect.
    ///
    /// Returns `None` if the caller's `have` already matches the region's
    /// current version (nothing to send); otherwise the current snapshot.
    pub fn resync(&self, region: &str, have: Option<u64>) -> Option<SnapshotFrame> {
        let mut regions = self.lock();
        let state = regions
            .entry(region.to_string())
            .or_insert_with(|| RegionState::new(Value::Null));
        if have == Some(state.version) {
            return None;
        }
        Some(state.snapshot(region))
    }

    /// Number of live subscribers on a region (test / diagnostics helper).
    pub fn subscriber_count(&self, region: &str) -> usize {
        self.lock()
            .get(region)
            .map(|s| s.subscribers.len())
            .unwrap_or(0)
    }

    /// The region's current version, if it exists (test / diagnostics helper).
    pub fn region_version(&self, region: &str) -> Option<u64> {
        self.lock().get(region).map(|s| s.version)
    }

    fn fan_out(state: &mut RegionState, frame: &ProjectionFrame) {
        // Deliver to every subscriber; reap any whose sink is gone.
        state
            .subscribers
            .retain(|sub| sub.sink.deliver(frame).is_ok());
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RegionState>> {
        // The map is only ever locked for the short body of a projector call;
        // a poisoned lock means another thread panicked mid-mutation, which is
        // a bug — recover the guard rather than cascade the panic.
        self.regions.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ── Intent dispatch (single writer) ─────────────────────────────────────────

/// Handles a validated [`Intent`]: mutates authoritative domain state and
/// publishes the affected region(s) via the [`Projector`].
///
/// Returns the regions advanced (for the ack's `produced` list) on success, or
/// an error `(code, message)` to reject with.
pub trait IntentHandler: Send + Sync {
    fn handle(
        &self,
        intent: &Intent,
        projector: &Projector,
    ) -> Result<Vec<ProducedRegion>, (String, String)>;
}

/// Serialises intents onto a single writer and turns handler results into
/// [`IntentAck`] receipts.
///
/// A write mutex guards the whole read-decide-mutate-publish step so intents
/// never interleave — the substrate's single-writer guarantee. The result of
/// an accepted intent reaches the UI as a projection diff, never inline.
pub struct Dispatcher {
    projector: Arc<Projector>,
    handler: Arc<dyn IntentHandler>,
    write_lock: Mutex<()>,
}

impl Dispatcher {
    pub fn new(projector: Arc<Projector>, handler: Arc<dyn IntentHandler>) -> Self {
        Self {
            projector,
            handler,
            write_lock: Mutex::new(()),
        }
    }

    /// Dispatch one intent and return its receipt.
    pub fn dispatch(&self, intent: Intent) -> IntentAck {
        let _writer = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        match self.handler.handle(&intent, &self.projector) {
            Ok(produced) => IntentAck::accepted(intent.intent_id, produced),
            Err((code, message)) => IntentAck::rejected(intent.intent_id, code, message),
        }
    }
}

/// Routes intents to a handler chosen by exact [`Intent::kind`].
///
/// The Phase-1 app registers an empty registry: the two channels exist and are
/// wired, but no real domain is served yet, so every intent is rejected with
/// `unknown_intent`. Domains register routes as they migrate (Phase 2+).
#[derive(Default)]
pub struct HandlerRegistry {
    #[allow(clippy::type_complexity)]
    routes: HashMap<
        String,
        Box<
            dyn Fn(&Intent, &Projector) -> Result<Vec<ProducedRegion>, (String, String)>
                + Send
                + Sync,
        >,
    >,
}

impl HandlerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a handler for an exact intent `kind`.
    pub fn route<F>(&mut self, kind: impl Into<String>, handler: F)
    where
        F: Fn(&Intent, &Projector) -> Result<Vec<ProducedRegion>, (String, String)>
            + Send
            + Sync
            + 'static,
    {
        self.routes.insert(kind.into(), Box::new(handler));
    }
}

impl IntentHandler for HandlerRegistry {
    fn handle(
        &self,
        intent: &Intent,
        projector: &Projector,
    ) -> Result<Vec<ProducedRegion>, (String, String)> {
        match self.routes.get(&intent.kind) {
            Some(route) => route(intent, projector),
            None => Err((
                "unknown_intent".to_string(),
                format!("no handler registered for intent kind '{}'", intent.kind),
            )),
        }
    }
}

#[cfg(test)]
mod tests;
