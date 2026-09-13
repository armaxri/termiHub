//! Projection-contract tests for the shared `transfers` region (#2229), reusing
//! the substrate harness (#2164): an in-memory [`ProjectionSink`] and a client
//! cache that applies diffs. The routes here drive a real [`TransferStore`]
//! directly (the production `register_transfer_intents` resolves the same store
//! from the Tauri `AppHandle`; that thin wiring is integration-verified via a
//! local `./scripts/dev.sh` run) through the identical parse → mutate → publish
//! path.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with monotonic
//! versions, rejection paths advance nothing, a no-op intent advances nothing, a
//! dead subscriber is reaped, and the client cache converges on the store's
//! authority across a full transfer lifecycle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::Manager;

use crate::commands::projection::ProjectionState;
use crate::projection::{
    apply_ops, compute_ops, DiffFrame, DiffOp, Dispatcher, HandlerRegistry, Intent, IntentStatus,
    ProjectionError, ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};
use crate::transfers_projection::projection::{
    fold_transfer_progress, publish_transfers, TRANSFERS_REGION,
};
use crate::transfers_projection::store::{
    TransferProgress, TransferQueueState, TransferSeed, TransferSnapshot, TransferStore,
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// A fixed `now` so folds are deterministic in tests.
const NOW: u64 = 10_000;

/// A store with a couple of transfers already in the queue, so a subscriber sees
/// a populated baseline.
fn seeded_store() -> Arc<TransferStore> {
    let store = Arc::new(TransferStore::new());
    store.seed(&seed("t1"), NOW);
    store.seed(&seed("t2"), NOW);
    store.progress(&progress_active("t2", 500), NOW);
    store
}

fn seed(id: &str) -> TransferSeed {
    serde_json::from_value(json!({
        "id": id,
        "sessionId": "sess-1",
        "direction": "download",
        "name": "data.csv",
        "path": "/remote/data.csv",
        "totalBytes": 1000,
    }))
    .unwrap()
}

fn progress_active(id: &str, transferred: u64) -> TransferProgress {
    serde_json::from_value(json!({
        "transferId": id,
        "sessionId": "sess-1",
        "direction": "download",
        "fileName": "data.csv",
        "path": "/remote/data.csv",
        "transferred": transferred,
        "total": 1000,
        "phase": "transferring",
        "state": "active",
        "totalBytes": 1000,
    }))
    .unwrap()
}

/// The production `transfer.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_transfer_intents` runs, with a fixed `now` so folds are
/// deterministic. Each closure mirrors the production route one-to-one so the
/// test drives real logic, not a stand-in.
fn registry_for(store: Arc<TransferStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("transfer.seed", move |intent, projector| {
        let seed: TransferSeed = parse_field(intent, "seed")?;
        s.seed(&seed, NOW);
        Ok(publish_transfers(projector, &s))
    });
    let s = store.clone();
    registry.route("transfer.progress", move |intent, projector| {
        let progress: TransferProgress = parse_field(intent, "progress")?;
        s.progress(&progress, NOW);
        Ok(publish_transfers(projector, &s))
    });
    let s = store.clone();
    registry.route("transfer.reconcile", move |intent, projector| {
        let snapshots: Vec<TransferSnapshot> = parse_field(intent, "snapshots")?;
        s.reconcile(&snapshots, NOW);
        Ok(publish_transfers(projector, &s))
    });
    let s = store.clone();
    registry.route("transfer.remove", move |intent, projector| {
        s.remove(&required_str(intent, "id")?);
        Ok(publish_transfers(projector, &s))
    });
    let s = store.clone();
    registry.route("transfer.clearCompleted", move |_intent, projector| {
        s.clear_completed();
        Ok(publish_transfers(projector, &s))
    });
    let s = store.clone();
    registry.route("transfer.setMinimized", move |intent, projector| {
        let minimized = intent
            .payload
            .get("minimized")
            .and_then(Value::as_bool)
            .ok_or_else(|| ("bad_payload".to_string(), "missing 'minimized'".to_string()))?;
        s.set_minimized(minimized);
        Ok(publish_transfers(projector, &s))
    });
    let s = store;
    registry.route("transfer.replace", move |intent, projector| {
        let queue = match intent.payload.get("queue") {
            None | Some(Value::Null) => std::collections::HashMap::new(),
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|e| ("bad_payload".to_string(), format!("invalid 'queue': {e}")))?,
        };
        let minimized = intent
            .payload
            .get("minimized")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        s.replace(queue, minimized);
        Ok(publish_transfers(projector, &s))
    });

    registry
}

/// The route-side `parse_field` — deserialize a required object/array field.
fn parse_field<T: serde::de::DeserializeOwned>(
    intent: &Intent,
    key: &str,
) -> Result<T, (String, String)> {
    let value = intent
        .payload
        .get(key)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))?;
    serde_json::from_value(value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid '{key}': {e}")))
}

fn required_str(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

/// An in-memory sink recording delivered frames; can be killed to simulate a
/// dead subscriber (mirrors the substrate/tunnel/monitor test double).
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
    projector.register_region(TRANSFERS_REGION, store.snapshot());

    let snap_a = projector.subscribe(TRANSFERS_REGION, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(TRANSFERS_REGION, "sub-b", "B", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "transfers");
    assert_eq!(snap_a.view["queue"]["t1"]["state"], json!("queued"));
    assert_eq!(snap_a.view["queue"]["t2"]["state"], json!("active"));
    assert_eq!(snap_a.view["minimized"], json!(false));
}

#[test]
fn a_transfer_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(TRANSFERS_REGION, "sub-a", "A", sink_a.clone());
    projector.subscribe(TRANSFERS_REGION, "sub-b", "B", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "transfer.progress",
        json!({ "progress": progress_payload("t1", "completed", 1000) }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![crate::projection::ProducedRegion {
            region: TRANSFERS_REGION.to_string(),
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
    assert_eq!(cache_a.view["queue"]["t1"]["state"], json!("completed"));
    assert_eq!(cache_a.view["queue"]["t1"]["percent"], json!(100));
}

#[test]
fn a_full_transfer_lifecycle_advances_monotonically_and_converges() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(TRANSFERS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // t1: queued → active → completed, then clearCompleted drops it. Each
    // view-changing intent = one diff.
    for (kind, payload) in [
        (
            "transfer.progress",
            json!({ "progress": progress_payload("t1", "active", 400) }),
        ),
        (
            "transfer.progress",
            json!({ "progress": progress_payload("t1", "completed", 1000) }),
        ),
        ("transfer.setMinimized", json!({ "minimized": true })),
        ("transfer.clearCompleted", json!({})),
    ] {
        let ack = dispatcher.dispatch(intent(kind, payload));
        assert_eq!(ack.status, IntentStatus::Accepted, "{kind} accepted");
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 4, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 4);
    assert_eq!(cache.view, store.snapshot(), "cache converges on authority");
    assert_eq!(cache.view["queue"].get("t1"), None, "completed row cleared");
    assert_eq!(cache.view["minimized"], json!(true));
}

#[test]
fn replace_mirrors_a_whole_slice_in_one_diff_and_converges() {
    // The render-cut mirror (#2229): a `transfer.replace` carrying `appStore`'s
    // whole transfer-queue slice overwrites the region in a single diff.
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(TRANSFERS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // Build the mirror from an independent store (a fresh t3, no t1/t2).
    let source = Arc::new(TransferStore::new());
    source.seed(&seed("t3"), NOW);
    source.progress(&progress_active("t3", 750), NOW);
    let view = source.snapshot();

    let ack = dispatcher.dispatch(intent(
        "transfer.replace",
        json!({ "queue": view["queue"], "minimized": true }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one coalesced diff for the whole replace");
    cache.apply(&diffs[0]);
    assert_eq!(cache.view, store.snapshot(), "region mirrors the source");
    assert_eq!(cache.view["queue"].get("t1"), None, "prior rows gone");
    assert_eq!(cache.view["queue"]["t3"]["state"], json!("active"));
    assert_eq!(cache.view["minimized"], json!(true));
}

#[test]
fn an_intent_missing_its_field_is_rejected_without_advancing() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(TRANSFERS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent("transfer.seed", json!({ "wrong": "field" })));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(TRANSFERS_REGION), Some(0));
}

#[test]
fn a_no_op_intent_advances_nothing() {
    // `remove` of an unknown id leaves the view unchanged, so the projector
    // coalesces it to no diff and no version bump.
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(TRANSFERS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent("transfer.remove", json!({ "id": "ghost" })));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(TRANSFERS_REGION), Some(0));
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(TRANSFERS_REGION, "live", "A", live.clone());
    projector.subscribe(TRANSFERS_REGION, "dead", "B", dead.clone());
    assert_eq!(projector.subscriber_count(TRANSFERS_REGION), 2);

    dead.alive.store(false, Ordering::SeqCst);
    dispatcher.dispatch(intent(
        "transfer.progress",
        json!({ "progress": progress_payload("t1", "active", 300) }),
    ));

    assert_eq!(
        live.diffs().len(),
        1,
        "the live subscriber still gets the diff"
    );
    assert_eq!(
        projector.subscriber_count(TRANSFERS_REGION),
        1,
        "the dead subscriber was reaped"
    );
}

/// A `transfer-progress` payload as the frontend serialises it (camelCase).
fn progress_payload(id: &str, state: &str, transferred: u64) -> Value {
    json!({
        "transferId": id,
        "sessionId": "sess-1",
        "direction": "download",
        "fileName": "data.csv",
        "path": "/remote/data.csv",
        "transferred": transferred,
        "total": 1000,
        "phase": "transferring",
        "state": state,
        "totalBytes": 1000,
    })
}

// ── Server-authority fold (#2387, prerequisite for #2229) ─────────────────────
//
// These drive the *production* `fold_transfer_progress` end to end against a
// `tauri::test::mock_app()` with the same managed state `lib.rs::setup()` wires:
// an `Arc<TransferStore>` and a `ProjectionState`. They prove the store is fed
// **server-side** — the instant the transfer engine produces a
// register/queue/progress/pause/finish/cancel `transfer-progress` event and
// hands it to `app_progress_sink` — with no `transfer.*` client dispatch, and
// that the fold reproduces the client `transfer.progress` route's store
// transition exactly (parity, no double count).

/// A backend-produced progress event folded server-side upserts the row in the
/// shared store and fans the `transfers` region diff out — without any client
/// dispatch. The full lifecycle is captured because every backend event carries
/// the rich `state` field.
#[test]
fn server_side_progress_fold_updates_store_and_region_without_client_dispatch() {
    let app = tauri::test::mock_app();

    let store = Arc::new(TransferStore::new());
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(TRANSFERS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(TRANSFERS_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    // The engine emits an `active` progress sample at the source — no
    // `transfer.progress` intent is dispatched.
    fold_transfer_progress(app.handle(), &progress_payload("t1", "active", 400));

    // The store is authoritative server-side.
    let entry = store.get("t1").expect("row created by the server fold");
    assert_eq!(entry.state, TransferQueueState::Active);
    assert_eq!(entry.transferred, 400);
    assert_eq!(entry.percent, Some(40));

    // Exactly one region diff fanned out; the client cache converges on the
    // server truth with no round-trip.
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side fold");
    cache.apply(&diffs[0]);
    assert_eq!(cache.view["queue"]["t1"]["state"], json!("active"));
    assert_eq!(cache.view["queue"]["t1"]["transferred"], json!(400));
    assert_eq!(cache.view, store.snapshot(), "cache converges on authority");
}

/// A terminal `completed` event folded server-side settles the row (percent
/// 100), publishing the region diff — the finish edge of the lifecycle.
#[test]
fn server_side_terminal_fold_settles_the_row() {
    let app = tauri::test::mock_app();
    let store = Arc::new(TransferStore::new());
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(TRANSFERS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projection
        .projector
        .subscribe(TRANSFERS_REGION, "sub", "C", sink.clone());
    app.manage(projection);

    fold_transfer_progress(app.handle(), &progress_payload("t1", "active", 400));
    fold_transfer_progress(app.handle(), &progress_payload("t1", "completed", 1000));

    let entry = store.get("t1").expect("row retained after completion");
    assert_eq!(entry.state, TransferQueueState::Completed);
    assert_eq!(entry.percent, Some(100));
    assert_eq!(sink.diffs().len(), 2, "one diff per folded event");
}

/// The server-side progress fold reproduces the client `transfer.progress`
/// route's store transition exactly — identical snapshots, so there is no drift
/// or double count when the fold and the (still-present, additive) client mirror
/// both run the same event.
#[test]
fn server_side_progress_fold_matches_the_client_transfer_progress_route() {
    let event = progress_payload("t1", "active", 400);

    // (a) Server-side fold: the store method the fold applies at the source.
    let server = Arc::new(TransferStore::new());
    server.progress(&serde_json::from_value(event.clone()).unwrap(), NOW);

    // (b) Client route: the `transfer.progress` intent through the production
    // registry wiring (mirrored by `registry_for`).
    let client = Arc::new(TransferStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(TRANSFERS_REGION, client.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(client.clone())));
    let ack = dispatcher.dispatch(intent("transfer.progress", json!({ "progress": event })));
    assert_eq!(ack.status, IntentStatus::Accepted);

    assert_eq!(
        server.snapshot(),
        client.snapshot(),
        "the server fold reproduces the client route's transition exactly"
    );
}

/// The fold is a best-effort no-op when no store / projection state is managed
/// (e.g. a headless harness that never ran `setup()`) — it must not panic.
#[test]
fn server_side_fold_is_a_noop_without_managed_state() {
    let app = tauri::test::mock_app();
    // Nothing managed — reaching the assert without panicking is the contract.
    fold_transfer_progress(app.handle(), &progress_payload("t1", "active", 1));
}

// ── Incremental publish equivalence (PERF-006, rollout of #2878) ──────────────
//
// The incremental publish (`drain_delta` → reduced diff → in-place splice) must
// emit a diff **byte-identical** to the old whole-region path (re-serialize the
// whole store + `compute_ops` of the two full trees). These tests pin that: at
// each fold they assert the fanned-out ops equal `compute_ops(prev_full,
// new_full)`, and that the subscriber cache converges on the store snapshot. The
// scalar `minimized` field is exercised alongside the `queue` map.

/// A progress event of a given state parsed into the store's `TransferProgress`.
fn progress(id: &str, state: &str, transferred: u64) -> TransferProgress {
    serde_json::from_value(progress_payload(id, state, transferred)).unwrap()
}

/// Publish `store` and assert the emitted diff equals the whole-region diff
/// between `prev` (the region view before the fold) and the store's fresh
/// snapshot. Advances `prev` to the new snapshot. A `None` publish (no change) is
/// asserted to coincide with an empty whole-region diff.
fn assert_incremental_equals_full(
    projector: &Projector,
    store: &TransferStore,
    sink: &VecSink,
    prev: &mut Value,
    label: &str,
) {
    let before = sink.diffs().len();
    let new_full = store.snapshot();
    let expected_ops: Vec<DiffOp> = compute_ops(prev, &new_full);

    let produced = publish_transfers(projector, store);
    let diffs = sink.diffs();

    if expected_ops.is_empty() {
        assert!(
            produced.is_empty(),
            "{label}: no region advanced on a no-op"
        );
        assert_eq!(diffs.len(), before, "{label}: no diff on a no-op");
    } else {
        assert_eq!(diffs.len(), before + 1, "{label}: exactly one diff emitted");
        assert_eq!(
            &diffs.last().unwrap().ops,
            &expected_ops,
            "{label}: incremental ops must equal the whole-region diff"
        );
    }

    // Cross-check the reference view converges exactly like a client cache would.
    let mut applied = prev.clone();
    apply_ops(&mut applied, &expected_ops).expect("diff applies cleanly");
    assert_eq!(
        applied, new_full,
        "{label}: applying the diff reproduces the snapshot"
    );

    *prev = new_full;
}

/// The representative fold sequence the finding calls out — add a row, update one
/// field of one row among many (the hot per-progress path), remove a row, toggle
/// the `minimized` scalar, and a no-op — each producing exactly the whole-region
/// diff, over a populated (O(N)) queue.
#[test]
fn incremental_publish_is_byte_identical_to_the_whole_region_diff() {
    let store = TransferStore::new();
    // A populated queue: several active transfers, so a whole-region rebuild would
    // be O(N) per fold and a single-row progress must not touch the rest.
    for i in 0..6 {
        let id = format!("t{i}");
        store.seed(&seed(&id), NOW);
        store.progress(&progress(&id, "active", 100), NOW + 1);
    }

    let projector = Projector::new();
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projector.subscribe(TRANSFERS_REGION, "sub", "A", sink.clone());

    // Clear the seed dirty set; the region baseline already equals the store, so
    // this drains without emitting (a no-op publish).
    assert!(publish_transfers(&projector, &store).is_empty());

    let mut prev = store.snapshot();

    // 1) Update one field of one row among many (the hot per-progress path).
    store.progress(&progress("t3", "active", 500), NOW + 2);
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "update-one-of-many");

    // 2) Add a brand-new row.
    store.seed(&seed("t42"), NOW + 3);
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "add-entry");

    // 3) The scalar `minimized` flips alone (no queue key touched).
    store.set_minimized(true);
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "minimized-only");

    // 4) A completed row, then clear it (a `remove` under /queue).
    store.progress(&progress("t0", "completed", 1000), NOW + 4);
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "complete-row");
    store.clear_completed();
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "clear-completed");

    // 5) Remove a row directly.
    store.remove("t1");
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "remove-entry");

    // 6) A genuine no-op: `seed` for an id already present is ignored.
    store.seed(&seed("t2"), NOW + 5);
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "no-op");

    // The subscriber, fed only the incremental diffs, converges on the authority.
    let snap = projector.snapshot(TRANSFERS_REGION);
    assert_eq!(
        snap.view,
        store.snapshot(),
        "region view == store authority"
    );
}

/// Multiple rows plus the `minimized` scalar changing in the **same** publish must
/// still diff byte-identically to the whole-region path, exercising multi-key
/// ordering (and the scalar's sorted position before `queue`) within one reduced
/// diff.
#[test]
fn incremental_publish_coalesces_multi_entry_changes_identically() {
    let store = TransferStore::new();
    for i in 0..4 {
        let id = format!("t{i}");
        store.seed(&seed(&id), NOW);
        store.progress(&progress(&id, "active", 100), NOW + 1);
    }
    let projector = Projector::new();
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projector.subscribe(TRANSFERS_REGION, "sub", "A", sink.clone());
    assert!(publish_transfers(&projector, &store).is_empty());

    let mut prev = store.snapshot();

    // Mutate three rows and the scalar before a single publish → one coalesced diff.
    store.progress(&progress("t2", "active", 700), NOW + 2);
    store.remove("t0");
    store.seed(&seed("t9"), NOW + 3);
    store.set_minimized(true);
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "coalesced-multi");
}

/// The whole-map `replace` mirror (the one intrinsically O(region) fold) also
/// stays byte-identical: adds for the new keys, removes for the gone ones, plus
/// the `minimized` scalar.
#[test]
fn incremental_publish_replace_matches_the_whole_region_diff() {
    let store = seeded_store();
    let projector = Projector::new();
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projector.subscribe(TRANSFERS_REGION, "sub", "A", sink.clone());
    assert!(publish_transfers(&projector, &store).is_empty());

    let mut prev = store.snapshot();

    let source = TransferStore::new();
    source.seed(&seed("t9"), NOW);
    source.progress(&progress("t9", "active", 250), NOW + 1);
    source.set_minimized(true);
    let mirror = source.snapshot();
    let queue = serde_json::from_value(mirror["queue"].clone()).unwrap();
    store.replace(queue, mirror["minimized"].as_bool().unwrap());

    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "replace");
    assert_eq!(prev, source.snapshot(), "region mirrors the replace source");
}
