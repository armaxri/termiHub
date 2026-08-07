//! Projection-contract tests for the shared `session-lifecycle` region (#2152),
//! reusing the substrate harness (#2164): an in-memory [`ProjectionSink`] and a
//! client cache that applies diffs. The routes here drive a real
//! [`SessionLifecycleStore`] directly (the production `register_session_intents`
//! resolves the same store from the Tauri `AppHandle`; that thin wiring is
//! integration-verified via a local `./scripts/dev.sh` run) through the identical
//! parse → mutate → publish path.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with monotonic
//! versions, rejection paths advance nothing, a dead subscriber is reaped, and
//! the client cache converges on the store's authority across a full lifecycle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::Manager;

use crate::commands::projection::ProjectionState;
use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, ProjectionError,
    ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};
use crate::session::manager::{DropFold, EventEmitter};
use crate::session_projection::projection::{
    fold_session_transition, publish_sessions, SESSION_LIFECYCLE_REGION,
};
use crate::session_projection::store::SessionLifecycleStore;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// A deterministic store (zero jitter) with a couple of sessions already in
/// flight, so a subscriber sees a populated baseline.
fn seeded_store() -> Arc<SessionLifecycleStore> {
    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.5));
    store.connect("s1");
    store.connect("s2");
    store.connected("s2");
    store
}

/// The production `session.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_session_intents` runs. Each closure mirrors the production route
/// one-to-one so the test drives real logic, not a stand-in.
fn registry_for(store: Arc<SessionLifecycleStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("session.connect", move |intent, projector| {
        s.connect(&required_id(intent)?);
        Ok(publish_sessions(projector, &s))
    });
    let s = store.clone();
    registry.route("session.connected", move |intent, projector| {
        s.connected(&required_id(intent)?);
        Ok(publish_sessions(projector, &s))
    });
    let s = store.clone();
    registry.route("session.connectFailed", move |intent, projector| {
        s.connect_failed(&required_id(intent)?, opt_error(intent));
        Ok(publish_sessions(projector, &s))
    });
    let s = store.clone();
    registry.route("session.disconnect", move |intent, projector| {
        s.disconnect(&required_id(intent)?);
        Ok(publish_sessions(projector, &s))
    });
    let s = store.clone();
    registry.route("session.dropped", move |intent, projector| {
        s.dropped(&required_id(intent)?, opt_error(intent));
        Ok(publish_sessions(projector, &s))
    });
    let s = store.clone();
    registry.route("session.reconnect", move |intent, projector| {
        s.reconnect(&required_id(intent)?);
        Ok(publish_sessions(projector, &s))
    });
    let s = store.clone();
    registry.route("session.reconnectAttempt", move |intent, projector| {
        s.reconnect_attempt(&required_id(intent)?);
        Ok(publish_sessions(projector, &s))
    });
    let s = store.clone();
    registry.route("session.reconnectFailed", move |intent, projector| {
        s.reconnect_failed(&required_id(intent)?, opt_error(intent));
        Ok(publish_sessions(projector, &s))
    });
    let s = store.clone();
    registry.route("session.cancelReconnect", move |intent, projector| {
        s.cancel_reconnect(&required_id(intent)?);
        Ok(publish_sessions(projector, &s))
    });
    let s = store;
    registry.route("session.remove", move |intent, projector| {
        s.remove(&required_id(intent)?);
        Ok(publish_sessions(projector, &s))
    });

    registry
}

/// The route-side `sessionId` parse — the one rejection path the routes carry.
fn required_id(intent: &Intent) -> Result<String, (String, String)> {
    intent
        .payload
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'sessionId'".to_string()))
}

fn opt_error(intent: &Intent) -> Option<String> {
    intent
        .payload
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
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

fn intent(kind: &str, payload: Value) -> Intent {
    Intent {
        intent_id: format!("01J-{kind}"),
        kind: kind.to_string(),
        payload,
        client_id: "client-1".to_string(),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn subscribe_returns_the_seeded_snapshot_identically_to_every_subscriber() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());

    let snap_a = projector.subscribe(
        SESSION_LIFECYCLE_REGION,
        "sub-a",
        "A",
        Arc::new(VecSink::new()),
    );
    let snap_b = projector.subscribe(
        SESSION_LIFECYCLE_REGION,
        "sub-b",
        "B",
        Arc::new(VecSink::new()),
    );

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "session-lifecycle");
    assert_eq!(snap_a.view["sessions"]["s1"]["status"], json!("connecting"));
    assert_eq!(snap_a.view["sessions"]["s2"]["status"], json!("connected"));
}

#[test]
fn a_lifecycle_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(SESSION_LIFECYCLE_REGION, "sub-a", "A", sink_a.clone());
    projector.subscribe(SESSION_LIFECYCLE_REGION, "sub-b", "B", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent("session.connected", json!({ "sessionId": "s1" })));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![crate::projection::ProducedRegion {
            region: SESSION_LIFECYCLE_REGION.to_string(),
            version: 1,
        }])
    );

    let diffs_a = sink_a.diffs();
    let diffs_b = sink_b.diffs();
    assert_eq!(diffs_a.len(), 1, "exactly one diff to A");
    assert_eq!(diffs_b.len(), 1, "exactly one diff to B");
    assert_eq!(diffs_a[0], diffs_b[0], "identical diff to every subscriber");
    assert_eq!(diffs_a[0].base_version, 0);
    assert_eq!(diffs_a[0].version, 1);

    cache_a.apply(&diffs_a[0]);
    assert_eq!(
        cache_a.view,
        store.snapshot(),
        "cache converges on authority"
    );
    assert_eq!(cache_a.view["sessions"]["s1"]["status"], json!("connected"));
}

#[test]
fn a_full_reconnect_loop_advances_monotonically_and_converges() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(SESSION_LIFECYCLE_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // s2 was connected; drive it through drop → reconnect → attempt → fail →
    // attempt → success. Each accepted intent that changes the view = one diff.
    for kind_payload in [
        (
            "session.dropped",
            json!({ "sessionId": "s2", "error": "reset" }),
        ),
        ("session.reconnect", json!({ "sessionId": "s2" })),
        ("session.reconnectAttempt", json!({ "sessionId": "s2" })),
        ("session.reconnectFailed", json!({ "sessionId": "s2" })),
        ("session.reconnectAttempt", json!({ "sessionId": "s2" })),
        ("session.connected", json!({ "sessionId": "s2" })),
    ] {
        let ack = dispatcher.dispatch(intent(kind_payload.0, kind_payload.1));
        assert_eq!(
            ack.status,
            IntentStatus::Accepted,
            "{} accepted",
            kind_payload.0
        );
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 6, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 6);
    assert_eq!(cache.view, store.snapshot(), "cache converges on authority");
    assert_eq!(cache.view["sessions"]["s2"]["status"], json!("connected"));
}

#[test]
fn an_intent_missing_the_session_id_is_rejected_without_advancing() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(SESSION_LIFECYCLE_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent("session.connect", json!({ "wrong": "field" })));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(SESSION_LIFECYCLE_REGION), Some(0));
}

#[test]
fn a_no_op_intent_advances_nothing() {
    // `connected` on an already-connected session leaves the view unchanged, so
    // the projector coalesces it to no diff and no version bump.
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(SESSION_LIFECYCLE_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent("session.connected", json!({ "sessionId": "s2" })));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(SESSION_LIFECYCLE_REGION), Some(0));
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(SESSION_LIFECYCLE_REGION, "live", "A", live.clone());
    projector.subscribe(SESSION_LIFECYCLE_REGION, "dead", "B", dead.clone());
    assert_eq!(projector.subscriber_count(SESSION_LIFECYCLE_REGION), 2);

    dead.alive.store(false, Ordering::SeqCst);
    dispatcher.dispatch(intent("session.connected", json!({ "sessionId": "s1" })));

    assert_eq!(
        live.diffs().len(),
        1,
        "the live subscriber still gets the diff"
    );
    assert_eq!(
        projector.subscriber_count(SESSION_LIFECYCLE_REGION),
        1,
        "the dead subscriber was reaped"
    );
}

// ── Server-authority fold (#2431, prerequisite for #2205) ─────────────────────
//
// These drive the *production* `fold_session_transition` end to end against a
// `tauri::test::mock_app()` with the same managed state `lib.rs::setup()` wires:
// an `Arc<SessionLifecycleStore>` and a `ProjectionState`. They prove the store
// is fed **server-side** — the instant `create_connection` produces an initial
// connect / connected transition — addressed by the **frontend tab id** the
// region is keyed by, with no `session.*` client dispatch, and that the fold
// reproduces the client route's store transition exactly (parity, no drift).

/// A server-folded initial connect creates the tab-id-keyed `connecting` entry in
/// the shared store and fans the `session-lifecycle` region diff out — without any
/// client dispatch.
#[test]
fn server_side_connect_fold_creates_the_tab_keyed_entry_without_client_dispatch() {
    let app = tauri::test::mock_app();
    let store = Arc::new(SessionLifecycleStore::new());
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(SESSION_LIFECYCLE_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    // The server folds the initial connect at the source, keyed by the tab id —
    // no `session.connect` intent is dispatched.
    fold_session_transition(app.handle(), |s| s.connect("tab-1"));

    // The store is authoritative server-side, under the tab-id key.
    assert_eq!(
        store.get("tab-1").map(|s| s.status),
        Some(crate::session_projection::store::SessionStatus::Connecting)
    );

    // Exactly one region diff fanned out; the client cache converges on the server
    // truth with no round-trip.
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side fold");
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view["sessions"]["tab-1"]["status"],
        json!("connecting")
    );
}

/// A server-folded `connected` settles the tab-keyed session live and publishes
/// the region diff.
#[test]
fn server_side_connected_fold_settles_the_session_live() {
    let app = tauri::test::mock_app();
    let store = Arc::new(SessionLifecycleStore::new());
    store.connect("tab-1");
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(SESSION_LIFECYCLE_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    fold_session_transition(app.handle(), |s| s.connected("tab-1"));

    assert_eq!(
        store.get("tab-1").map(|s| s.status),
        Some(crate::session_projection::store::SessionStatus::Connected)
    );
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1);
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view["sessions"]["tab-1"]["status"],
        json!("connected")
    );
}

/// The server-side connect fold reproduces the client `session.connect` route's
/// store transition exactly — identical snapshots, so there is no drift when the
/// fold and the (still-present, additive) client mirror both run for the initial
/// connect.
#[test]
fn server_side_connect_fold_matches_the_client_session_connect_route() {
    // (a) Server-side fold: the store method the fold applies at the source.
    let server = SessionLifecycleStore::new();
    server.set_rand_for_test(Box::new(|| 0.5));
    server.connect("tab-1");

    // (b) Client route: the `session.connect` intent through the production registry.
    let client = Arc::new(SessionLifecycleStore::new());
    client.set_rand_for_test(Box::new(|| 0.5));
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, client.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(client.clone())));
    let ack = dispatcher.dispatch(intent("session.connect", json!({ "sessionId": "tab-1" })));
    assert_eq!(ack.status, IntentStatus::Accepted);

    assert_eq!(
        server.snapshot(),
        client.snapshot(),
        "the server fold reproduces the client route's transition exactly"
    );
}

/// A user-initiated kill (`close_terminal` with `intentional = true`) folds the
/// graceful `session.disconnect` server-side under the tab id: the session lands
/// idle `Disconnected` with reason `User`, and the region diff fans out — no
/// client dispatch (#2439, part of #2205).
#[test]
fn server_side_kill_disconnect_fold_settles_the_session_disconnected() {
    let app = tauri::test::mock_app();
    let store = Arc::new(SessionLifecycleStore::new());
    store.connect("tab-1");
    store.connected("tab-1");
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(SESSION_LIFECYCLE_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    // The kill path folds the graceful disconnect at the source, keyed by the tab
    // id — the same transition the client mirrors for a `killed` exit.
    fold_session_transition(app.handle(), |s| s.disconnect("tab-1"));

    assert_eq!(
        store.get("tab-1").map(|s| s.status),
        Some(crate::session_projection::store::SessionStatus::Disconnected)
    );

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side kill fold");
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view["sessions"]["tab-1"]["status"],
        json!("disconnected")
    );
    assert_eq!(cache.view["sessions"]["tab-1"]["endReason"], json!("user"));
}

/// The server-side kill-disconnect fold reproduces the client `session.disconnect`
/// route's store transition exactly — so the convergent double-write (server fold
/// + still-present client mirror) never drifts for a `killed` exit.
#[test]
fn server_side_kill_disconnect_fold_matches_the_client_session_disconnect_route() {
    // (a) Server-side fold.
    let server = SessionLifecycleStore::new();
    server.connect("tab-1");
    server.connected("tab-1");
    server.disconnect("tab-1");

    // (b) Client route: the `session.disconnect` intent through the production registry.
    let client = Arc::new(SessionLifecycleStore::new());
    client.connect("tab-1");
    client.connected("tab-1");
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, client.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(client.clone())));
    let ack = dispatcher.dispatch(intent(
        "session.disconnect",
        json!({ "sessionId": "tab-1" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    assert_eq!(
        server.snapshot(),
        client.snapshot(),
        "the server kill fold reproduces the client disconnect route's transition exactly"
    );
}

/// A genuine drop of a **resilient-reconnect** tab folds `session.reconnect`
/// server-side via the production `AppHandle::fold_session_drop` (the exact call
/// `emit_and_cleanup` makes at the `terminal-exit` source): the session enters
/// `Reconnecting` and one region diff fans out — no client dispatch (#2439).
#[test]
fn server_side_resilient_drop_fold_starts_reconnecting() {
    let app = tauri::test::mock_app();
    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.5));
    store.connect("tab-1");
    store.connected("tab-1");
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(SESSION_LIFECYCLE_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    // The genuine-drop path folds `reconnect` for a resilient tab at the source —
    // the same transition the client mirrors via `startAutoReconnect`.
    app.handle().fold_session_drop("tab-1", DropFold::Reconnect);

    assert_eq!(
        store.get("tab-1").map(|s| s.status),
        Some(crate::session_projection::store::SessionStatus::Reconnecting)
    );

    let diffs = sink.diffs();
    assert_eq!(
        diffs.len(),
        1,
        "one diff from the server-side reconnect fold"
    );
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view["sessions"]["tab-1"]["status"],
        json!("reconnecting")
    );
}

/// A genuine drop of a **non-resilient** tab folds `session.dropped` server-side
/// via the production `AppHandle::fold_session_drop`: the session lands idle
/// `Disconnected` with reason `Unexpected`, and one region diff fans out (#2439).
#[test]
fn server_side_nonresilient_drop_fold_settles_disconnected() {
    let app = tauri::test::mock_app();
    let store = Arc::new(SessionLifecycleStore::new());
    store.connect("tab-1");
    store.connected("tab-1");
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(SESSION_LIFECYCLE_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    app.handle().fold_session_drop("tab-1", DropFold::Dropped);

    assert_eq!(
        store.get("tab-1").map(|s| s.status),
        Some(crate::session_projection::store::SessionStatus::Disconnected)
    );

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side dropped fold");
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view["sessions"]["tab-1"]["status"],
        json!("disconnected")
    );
    assert_eq!(
        cache.view["sessions"]["tab-1"]["endReason"],
        json!("unexpected")
    );
}

/// The server-side drop folds reproduce the client `session.reconnect` /
/// `session.dropped` route transitions exactly — so the convergent double-write
/// (server fold + still-present client mirror) never drifts for a genuine drop.
#[test]
fn server_side_drop_folds_match_the_client_routes() {
    // Resilient drop → reconnect parity.
    let server_r = SessionLifecycleStore::new();
    server_r.set_rand_for_test(Box::new(|| 0.5));
    server_r.connect("tab-1");
    server_r.connected("tab-1");
    server_r.reconnect("tab-1");

    let client_r = Arc::new(SessionLifecycleStore::new());
    client_r.set_rand_for_test(Box::new(|| 0.5));
    client_r.connect("tab-1");
    client_r.connected("tab-1");
    let projector_r = Arc::new(Projector::new());
    projector_r.register_region(SESSION_LIFECYCLE_REGION, client_r.snapshot());
    let dispatcher_r = Dispatcher::new(projector_r, Arc::new(registry_for(client_r.clone())));
    assert_eq!(
        dispatcher_r
            .dispatch(intent("session.reconnect", json!({ "sessionId": "tab-1" })))
            .status,
        IntentStatus::Accepted
    );
    assert_eq!(
        server_r.snapshot(),
        client_r.snapshot(),
        "the server reconnect fold reproduces the client reconnect route exactly"
    );

    // Non-resilient drop → dropped parity.
    let server_d = SessionLifecycleStore::new();
    server_d.connect("tab-2");
    server_d.connected("tab-2");
    server_d.dropped("tab-2", None);

    let client_d = Arc::new(SessionLifecycleStore::new());
    client_d.connect("tab-2");
    client_d.connected("tab-2");
    let projector_d = Arc::new(Projector::new());
    projector_d.register_region(SESSION_LIFECYCLE_REGION, client_d.snapshot());
    let dispatcher_d = Dispatcher::new(projector_d, Arc::new(registry_for(client_d.clone())));
    assert_eq!(
        dispatcher_d
            .dispatch(intent("session.dropped", json!({ "sessionId": "tab-2" })))
            .status,
        IntentStatus::Accepted
    );
    assert_eq!(
        server_d.snapshot(),
        client_d.snapshot(),
        "the server dropped fold reproduces the client dropped route exactly"
    );
}
