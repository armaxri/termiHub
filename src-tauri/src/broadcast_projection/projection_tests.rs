//! Projection-contract tests for the client-scoped `broadcast@<clientId>` region
//! (#2242), reusing the substrate harness (#2164): an in-memory [`VecSink`] and
//! a client cache that applies diffs. The routes here drive a real
//! [`BroadcastStore`] directly (the production `register_broadcast_intents`
//! resolves the same store from the Tauri `AppHandle`; that thin wiring is
//! integration-verified via a local `./scripts/dev.sh` run) through the
//! identical parse → mutate → publish path.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with monotonic
//! versions, client-scoped isolation, rejection paths advance nothing, a no-op
//! intent coalesces to nothing, a dead subscriber is reaped, and the client
//! cache converges on the store's authority across a full session.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::broadcast_projection::projection::{broadcast_region, publish_broadcast};
use crate::broadcast_projection::store::{BroadcastScope, BroadcastStore};
use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, ProjectionError,
    ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// The production `broadcast.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_broadcast_intents` runs.
fn registry_for(store: Arc<BroadcastStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("broadcast.start", move |intent, projector| {
        let scope = scope_field(intent, true)?.unwrap_or_default();
        let source = str_field(intent, "sourceTabId")?;
        let targets = str_array(intent, "targetTabIds")?;
        s.start(&intent.client_id, scope, &source, &targets);
        Ok(publish_broadcast(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("broadcast.stop", move |intent, projector| {
        s.stop(&intent.client_id);
        Ok(publish_broadcast(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("broadcast.toggle", move |intent, projector| {
        let scope = scope_field(intent, false)?.unwrap_or_default();
        let source = intent
            .payload
            .get("sourceTabId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let targets = match intent.payload.get("targetTabIds") {
            None | Some(Value::Null) => Vec::new(),
            Some(_) => str_array(intent, "targetTabIds")?,
        };
        s.toggle(&intent.client_id, scope, source.as_deref(), &targets);
        Ok(publish_broadcast(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("broadcast.addTarget", move |intent, projector| {
        let tab_id = str_field(intent, "tabId")?;
        s.add_target(&intent.client_id, &tab_id);
        Ok(publish_broadcast(projector, &s, &intent.client_id))
    });

    let s = store;
    registry.route("broadcast.removeTarget", move |intent, projector| {
        let tab_id = str_field(intent, "tabId")?;
        s.remove_target(&intent.client_id, &tab_id);
        Ok(publish_broadcast(projector, &s, &intent.client_id))
    });

    registry
}

fn scope_field(
    intent: &Intent,
    required: bool,
) -> Result<Option<BroadcastScope>, (String, String)> {
    match intent.payload.get("scope").and_then(Value::as_str) {
        Some("all") => Ok(Some(BroadcastScope::All)),
        Some("panel") => Ok(Some(BroadcastScope::Panel)),
        Some("custom") => Ok(Some(BroadcastScope::Custom)),
        Some(_) => Err(("bad_payload".to_string(), "invalid 'scope'".to_string())),
        None if required => Err(("bad_payload".to_string(), "missing 'scope'".to_string())),
        None => Ok(None),
    }
}

fn str_field(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

fn str_array(intent: &Intent, key: &str) -> Result<Vec<String>, (String, String)> {
    let arr = intent
        .payload
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))?;
    arr.iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| ("bad_payload".to_string(), "invalid entry".to_string()))
        })
        .collect()
}

/// An in-memory sink recording delivered frames; can be killed to simulate a
/// dead subscriber (mirrors the substrate/tunnel/layout test double).
struct VecSink {
    frames: Mutex<Vec<ProjectionFrame>>,
    alive: AtomicBool,
}

impl VecSink {
    fn new() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            alive: AtomicBool::new(true),
        }
    }

    fn diffs(&self) -> Vec<DiffFrame> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|f| match f {
                ProjectionFrame::Diff(d) => Some(d.clone()),
                ProjectionFrame::Snapshot(_) => None,
            })
            .collect()
    }
}

impl ProjectionSink for VecSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(ProjectionError::SinkClosed("killed".into()));
        }
        self.frames.lock().unwrap().push(frame.clone());
        Ok(())
    }
}

/// A minimal client cache mirroring the TypeScript `ProjectionClient`.
struct ClientCache {
    version: u64,
    view: Value,
}

impl ClientCache {
    fn from_snapshot(s: &SnapshotFrame) -> Self {
        Self {
            version: s.version,
            view: s.view.clone(),
        }
    }

    fn apply(&mut self, diff: &DiffFrame) {
        assert_eq!(diff.base_version, self.version, "diff must fit the cache");
        apply_ops(&mut self.view, &diff.ops).expect("diff applies cleanly");
        self.version = diff.version;
    }
}

fn intent(kind: &str, client: &str, payload: Value) -> Intent {
    Intent {
        intent_id: format!("01J-{kind}"),
        kind: kind.to_string(),
        payload,
        client_id: client.to_string(),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn subscribe_returns_the_idle_baseline_identically_to_every_subscriber() {
    let store = Arc::new(BroadcastStore::new());
    let region = broadcast_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));

    let snap_a = projector.subscribe(&region, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(&region, "sub-b", "A", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "broadcast@A");
    assert_eq!(snap_a.view["active"], json!(false));
    assert_eq!(snap_a.view["sourceTabId"], Value::Null);
    assert_eq!(snap_a.view["targetTabIds"], json!([]));
    assert_eq!(snap_a.view["scope"], json!("all"));
}

#[test]
fn a_start_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = Arc::new(BroadcastStore::new());
    let region = broadcast_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub-a", "A", sink_a.clone());
    projector.subscribe(&region, "sub-b", "A", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "broadcast.start",
        "A",
        json!({ "scope": "all", "sourceTabId": "src", "targetTabIds": ["t1", "t2"] }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![crate::projection::ProducedRegion {
            region: region.clone(),
            version: 1,
        }])
    );

    let diffs_a = sink_a.diffs();
    let diffs_b = sink_b.diffs();
    assert_eq!(diffs_a.len(), 1, "exactly one diff to A");
    assert_eq!(diffs_b.len(), 1, "exactly one diff to B");
    assert_eq!(diffs_a[0], diffs_b[0], "identical diff to every subscriber");

    cache_a.apply(&diffs_a[0]);
    assert_eq!(cache_a.view, store.snapshot("A"), "cache converges");
    assert_eq!(cache_a.view["active"], json!(true));
    assert_eq!(cache_a.view["targetTabIds"], json!(["src", "t1", "t2"]));
}

#[test]
fn a_full_session_advances_monotonically_and_converges() {
    let store = Arc::new(BroadcastStore::new());
    let region = broadcast_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // start(src,t1) → addTarget(t2) → removeTarget(t1) → stop.
    for (kind, payload) in [
        (
            "broadcast.start",
            json!({ "scope": "panel", "sourceTabId": "src", "targetTabIds": ["t1"] }),
        ),
        ("broadcast.addTarget", json!({ "tabId": "t2" })),
        ("broadcast.removeTarget", json!({ "tabId": "t1" })),
        ("broadcast.stop", json!({})),
    ] {
        let ack = dispatcher.dispatch(intent(kind, "A", payload));
        assert_eq!(ack.status, IntentStatus::Accepted, "{kind} accepted");
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 4, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 4);
    assert_eq!(
        cache.view,
        store.snapshot("A"),
        "cache converges on authority"
    );
    assert_eq!(cache.view["active"], json!(false));
    assert_eq!(cache.view["targetTabIds"], json!([]));
    // stop retains the scope from the start for the keyboard toggle.
    assert_eq!(cache.view["scope"], json!("panel"));
    assert_eq!(cache.view["lastScope"], json!("panel"));
}

#[test]
fn membership_is_isolated_to_its_client_region() {
    let store = Arc::new(BroadcastStore::new());
    let region_a = broadcast_region("A");
    let region_b = broadcast_region("B");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region_a, store.snapshot("A"));
    projector.register_region(&region_b, store.snapshot("B"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    projector.subscribe(&region_a, "sa", "A", sink_a.clone());
    projector.subscribe(&region_b, "sb", "B", sink_b.clone());

    dispatcher.dispatch(intent(
        "broadcast.start",
        "A",
        json!({ "scope": "all", "sourceTabId": "src", "targetTabIds": [] }),
    ));

    assert_eq!(sink_a.diffs().len(), 1, "A's region advanced");
    assert_eq!(sink_b.diffs().len(), 0, "B's region untouched");
    assert_eq!(projector.region_version(&region_b), Some(0));
}

#[test]
fn an_intent_missing_required_fields_is_rejected_without_advancing() {
    let store = Arc::new(BroadcastStore::new());
    let region = broadcast_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    // start with no sourceTabId is rejected.
    let ack = dispatcher.dispatch(intent(
        "broadcast.start",
        "A",
        json!({ "scope": "all", "targetTabIds": [] }),
    ));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn a_no_op_remove_advances_nothing() {
    // Removing a tab that is not a target leaves the view unchanged, so the
    // projector coalesces it to no diff and no version bump.
    let store = Arc::new(BroadcastStore::new());
    let region = broadcast_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent(
        "broadcast.removeTarget",
        "A",
        json!({ "tabId": "ghost" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn toggle_off_then_on_round_trips_through_the_region() {
    let store = Arc::new(BroadcastStore::new());
    let region = broadcast_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // Idle toggle with a source starts; a second toggle stops.
    for payload in [
        json!({ "scope": "all", "sourceTabId": "src", "targetTabIds": ["t1"] }),
        json!({}),
    ] {
        let ack = dispatcher.dispatch(intent("broadcast.toggle", "A", payload));
        assert_eq!(ack.status, IntentStatus::Accepted);
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 2, "start then stop each produced a diff");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.view, store.snapshot("A"), "cache converges");
    assert_eq!(cache.view["active"], json!(false));
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = Arc::new(BroadcastStore::new());
    let region = broadcast_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(&region, "live", "A", live.clone());
    projector.subscribe(&region, "dead", "A", dead.clone());
    assert_eq!(projector.subscriber_count(&region), 2);

    dead.alive.store(false, Ordering::SeqCst);
    dispatcher.dispatch(intent(
        "broadcast.start",
        "A",
        json!({ "scope": "all", "sourceTabId": "src", "targetTabIds": [] }),
    ));

    assert_eq!(
        live.diffs().len(),
        1,
        "the live subscriber still gets the diff"
    );
    assert_eq!(
        projector.subscriber_count(&region),
        1,
        "the dead subscriber was reaped"
    );
}
