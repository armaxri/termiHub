//! Projection-contract tests for the shared `system-monitors` region (#2224),
//! reusing the substrate harness (#2164): an in-memory [`ProjectionSink`] and a
//! client cache that applies diffs. The routes here drive a real
//! [`SystemMonitorStore`] directly (the production `register_monitor_intents`
//! resolves the same store from the Tauri `AppHandle`; that thin wiring is
//! integration-verified via a local `./scripts/dev.sh` run) through the identical
//! parse → mutate → publish path.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with monotonic
//! versions, rejection paths advance nothing, a no-op intent advances nothing, a
//! dead subscriber is reaped, and the client cache converges on the store's
//! authority across a full monitor lifecycle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::Manager;

use termihub_core::monitoring::SystemStats;

use crate::commands::projection::ProjectionState;
use crate::projection::{
    apply_ops, compute_ops, DiffFrame, DiffOp, Dispatcher, HandlerRegistry, Intent, IntentStatus,
    ProjectionError, ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};
use crate::system_monitor_projection::projection::{
    fold_monitor_transition, publish_monitors, SYSTEM_MONITORS_REGION,
};
use crate::system_monitor_projection::store::SystemMonitorStore;

// ── Fixtures ─────────────────────────────────────────────────────────────────

fn stats(hostname: &str, cpu: f64) -> SystemStats {
    SystemStats {
        hostname: hostname.to_string(),
        uptime_seconds: 100.0,
        load_average: [0.1, 0.2, 0.3],
        cpu_usage_percent: cpu,
        memory_total_kb: 16_000_000,
        memory_available_kb: 8_000_000,
        memory_used_percent: 50.0,
        disk_total_kb: 100_000_000,
        disk_used_kb: 40_000_000,
        disk_used_percent: 40.0,
        os_info: "Linux 6.1".to_string(),
    }
}

/// A store with a couple of monitors already in flight, so a subscriber sees a
/// populated baseline.
fn seeded_store() -> Arc<SystemMonitorStore> {
    let store = Arc::new(SystemMonitorStore::new());
    store.open("s1", Some("host-a".to_string()), None);
    store.open("s2", Some("host-b".to_string()), None);
    store.opened("s2");
    store
}

/// The production `monitor.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_monitor_intents` runs. Each closure mirrors the production route
/// one-to-one so the test drives real logic, not a stand-in.
fn registry_for(store: Arc<SystemMonitorStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("monitor.open", move |intent, projector| {
        s.open(
            &required_key(intent)?,
            intent
                .payload
                .get("host")
                .and_then(Value::as_str)
                .map(str::to_string),
            intent.payload.get("intervalMs").and_then(Value::as_u64),
        );
        Ok(publish_monitors(projector, &s))
    });
    let s = store.clone();
    registry.route("monitor.opened", move |intent, projector| {
        s.opened(&required_key(intent)?);
        Ok(publish_monitors(projector, &s))
    });
    let s = store.clone();
    registry.route("monitor.openFailed", move |intent, projector| {
        s.open_failed(
            &required_key(intent)?,
            intent
                .payload
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
        Ok(publish_monitors(projector, &s))
    });
    let s = store.clone();
    registry.route("monitor.stats", move |intent, projector| {
        let key = required_key(intent)?;
        let value = intent
            .payload
            .get("stats")
            .ok_or_else(|| ("bad_payload".to_string(), "missing 'stats'".to_string()))?;
        let parsed: SystemStats = serde_json::from_value(value.clone())
            .map_err(|e| ("bad_payload".to_string(), format!("invalid stats: {e}")))?;
        s.stats(&key, parsed);
        Ok(publish_monitors(projector, &s))
    });
    let s = store.clone();
    registry.route("monitor.setPaused", move |intent, projector| {
        let paused = intent
            .payload
            .get("paused")
            .and_then(Value::as_bool)
            .ok_or_else(|| ("bad_payload".to_string(), "missing 'paused'".to_string()))?;
        s.set_paused(&required_key(intent)?, paused);
        Ok(publish_monitors(projector, &s))
    });
    let s = store.clone();
    registry.route("monitor.close", move |intent, projector| {
        s.close(&required_key(intent)?);
        Ok(publish_monitors(projector, &s))
    });
    let s = store;
    registry.route("monitor.replace", move |intent, projector| {
        let monitors = match intent.payload.get("monitors") {
            None | Some(Value::Null) => std::collections::HashMap::new(),
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|e| ("bad_payload".to_string(), format!("invalid monitors: {e}")))?,
        };
        let stats_cache = match intent.payload.get("statsCache") {
            None | Some(Value::Null) => std::collections::HashMap::new(),
            Some(value) => serde_json::from_value(value.clone()).map_err(|e| {
                (
                    "bad_payload".to_string(),
                    format!("invalid statsCache: {e}"),
                )
            })?,
        };
        s.replace(monitors, stats_cache);
        Ok(publish_monitors(projector, &s))
    });

    registry
}

/// The route-side `key` parse — the one rejection path shared by every route.
fn required_key(intent: &Intent) -> Result<String, (String, String)> {
    intent
        .payload
        .get("key")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'key'".to_string()))
}

/// An in-memory sink recording delivered frames; can be killed to simulate a
/// dead subscriber (mirrors the substrate/tunnel/session test double).
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
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());

    let snap_a = projector.subscribe(
        SYSTEM_MONITORS_REGION,
        "sub-a",
        "A",
        Arc::new(VecSink::new()),
    );
    let snap_b = projector.subscribe(
        SYSTEM_MONITORS_REGION,
        "sub-b",
        "B",
        Arc::new(VecSink::new()),
    );

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "system-monitors");
    assert_eq!(snap_a.view["monitors"]["s1"]["status"], json!("connecting"));
    assert_eq!(snap_a.view["monitors"]["s2"]["status"], json!("live"));
}

#[test]
fn a_monitor_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(SYSTEM_MONITORS_REGION, "sub-a", "A", sink_a.clone());
    projector.subscribe(SYSTEM_MONITORS_REGION, "sub-b", "B", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent("monitor.opened", json!({ "key": "s1" })));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![crate::projection::ProducedRegion {
            region: SYSTEM_MONITORS_REGION.to_string(),
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
    assert_eq!(cache_a.view["monitors"]["s1"]["status"], json!("live"));
}

#[test]
fn a_full_monitor_lifecycle_advances_monotonically_and_converges() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(SYSTEM_MONITORS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // s1: connecting → opened → two stats samples → paused → closed. Each accepted
    // intent that changes the view = one diff.
    for kind_payload in [
        ("monitor.opened", json!({ "key": "s1" })),
        (
            "monitor.stats",
            json!({ "key": "s1", "stats": stats("host-a", 12.0) }),
        ),
        (
            "monitor.stats",
            json!({ "key": "s1", "stats": stats("host-a", 34.0) }),
        ),
        ("monitor.setPaused", json!({ "key": "s1", "paused": true })),
        ("monitor.close", json!({ "key": "s1" })),
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
    assert_eq!(diffs.len(), 5, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 5);
    assert_eq!(cache.view, store.snapshot(), "cache converges on authority");
    // s1's entry is gone but its last stats survive in the cache.
    assert_eq!(cache.view["monitors"].get("s1"), None);
    assert_eq!(
        cache.view["statsCache"]["s1"]["cpuUsagePercent"],
        json!(34.0)
    );
}

#[test]
fn replace_mirrors_a_whole_snapshot_in_one_diff_and_converges() {
    // The render-cut mirror (#2224): a `monitor.replace` carrying `appStore`'s
    // whole monitoring slice overwrites the region in a single diff, and the
    // client cache converges on that snapshot.
    let store = seeded_store(); // s1 connecting, s2 live
    let projector = Arc::new(Projector::new());
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(SYSTEM_MONITORS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // Build the mirror payload from an independent store, exactly as the frontend
    // seed serialises `appStore` (a fresh monitor `s3`, no s1/s2).
    let source = Arc::new(SystemMonitorStore::new());
    source.open("s3", Some("host-c".to_string()), None);
    source.opened("s3");
    source.stats("s3", stats("host-c", 7.0));
    let view = source.snapshot();

    let ack = dispatcher.dispatch(intent(
        "monitor.replace",
        json!({ "monitors": view["monitors"], "statsCache": view["statsCache"] }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one coalesced diff for the whole replace");
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view,
        source.snapshot(),
        "the region now faithfully mirrors the source snapshot"
    );
    assert_eq!(cache.view["monitors"].get("s1"), None, "prior entries gone");
    assert_eq!(cache.view["monitors"]["s3"]["status"], json!("live"));
}

#[test]
fn an_intent_missing_the_key_is_rejected_without_advancing() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(SYSTEM_MONITORS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent("monitor.open", json!({ "wrong": "field" })));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(SYSTEM_MONITORS_REGION), Some(0));
}

#[test]
fn a_no_op_intent_advances_nothing() {
    // `opened` on an already-live monitor leaves the view unchanged, so the
    // projector coalesces it to no diff and no version bump.
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(SYSTEM_MONITORS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent("monitor.opened", json!({ "key": "s2" })));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(SYSTEM_MONITORS_REGION), Some(0));
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(SYSTEM_MONITORS_REGION, "live", "A", live.clone());
    projector.subscribe(SYSTEM_MONITORS_REGION, "dead", "B", dead.clone());
    assert_eq!(projector.subscriber_count(SYSTEM_MONITORS_REGION), 2);

    dead.alive.store(false, Ordering::SeqCst);
    dispatcher.dispatch(intent("monitor.opened", json!({ "key": "s1" })));

    assert_eq!(
        live.diffs().len(),
        1,
        "the live subscriber still gets the diff"
    );
    assert_eq!(
        projector.subscriber_count(SYSTEM_MONITORS_REGION),
        1,
        "the dead subscriber was reaped"
    );
}

// ── Server-authority fold (#2376, prerequisite for #2224) ─────────────────────
//
// These drive the *production* `fold_monitor_transition` end to end against a
// `tauri::test::mock_app()` with the same managed state `lib.rs::setup()` wires:
// an `Arc<SystemMonitorStore>` and a `ProjectionState`. They prove the store is
// fed **server-side** — the instant the collector loop / lifecycle produces a
// transition — with no `monitor.*` client dispatch, and that the fold reproduces
// the client route's store transition exactly (parity, no double count).

/// A collector-produced stats sample folded server-side updates the shared store
/// and fans the `system-monitors` region diff out — without any client dispatch.
#[test]
fn server_side_stats_fold_updates_store_and_region_without_client_dispatch() {
    let app = tauri::test::mock_app();

    // The entry is created client-side (`monitor.open`, which carries the UI host
    // label); the server folds the collector stream into it.
    let store = Arc::new(SystemMonitorStore::new());
    store.open("s1", Some("host-a".to_string()), None);
    store.opened("s1");
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(SYSTEM_MONITORS_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    // Server folds a sample at the source — no `monitor.stats` intent is dispatched.
    let sample = stats("host-a", 42.0);
    fold_monitor_transition(app.handle(), |s| s.stats("s1", sample.clone()));

    // The store is authoritative server-side.
    let entry = store.get("s1").expect("entry still present");
    assert_eq!(
        entry.sample_count, 1,
        "server fold incremented the sample count"
    );
    assert_eq!(
        store.cached_stats("s1").map(|s| s.cpu_usage_percent),
        Some(42.0)
    );

    // Exactly one region diff fanned out; the client cache converges on the server
    // truth with no round-trip.
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side fold");
    cache.apply(&diffs[0]);
    assert_eq!(cache.view["monitors"]["s1"]["sampleCount"], json!(1));
    assert_eq!(
        cache.view["monitors"]["s1"]["stats"]["cpuUsagePercent"],
        json!(42.0)
    );
}

/// A collector-produced status transition folded server-side updates the store
/// and region without any client dispatch.
#[test]
fn server_side_status_fold_updates_store_and_region() {
    use termihub_core::monitoring::MonitorStatus;

    let app = tauri::test::mock_app();
    let store = Arc::new(SystemMonitorStore::new());
    store.open("s1", Some("host-a".to_string()), None);
    store.opened("s1");
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(SYSTEM_MONITORS_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    fold_monitor_transition(app.handle(), |s| s.set_status("s1", MonitorStatus::Stale));

    assert_eq!(
        store.get("s1").and_then(|e| e.status),
        Some(MonitorStatus::Stale)
    );
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1);
    cache.apply(&diffs[0]);
    assert_eq!(cache.view["monitors"]["s1"]["status"], json!("stale"));
}

/// The server-side stats fold reproduces the client `monitor.stats` route's store
/// transition exactly — identical snapshots, so there is no drift or double count
/// when the fold and the (still-present, additive) client mirror both run.
#[test]
fn server_side_stats_fold_matches_the_client_monitor_stats_route() {
    let sample = stats("host-a", 42.0);

    // (a) Server-side fold: the store method the fold applies at the source.
    let server = seeded_store();
    server.opened("s1");
    server.stats("s1", sample.clone());

    // (b) Client route: the `monitor.stats` intent through the production registry.
    let client = seeded_store();
    client.opened("s1");
    let projector = Arc::new(Projector::new());
    projector.register_region(SYSTEM_MONITORS_REGION, client.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(client.clone())));
    let ack = dispatcher.dispatch(intent(
        "monitor.stats",
        json!({ "key": "s1", "stats": serde_json::to_value(&sample).unwrap() }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    assert_eq!(
        server.snapshot(),
        client.snapshot(),
        "the server fold reproduces the client route's transition exactly"
    );
}

/// A server-side close fold drops the entry from the shared store (the disconnect
/// / cancel lifecycle edge), publishing the region diff.
#[test]
fn server_side_close_fold_drops_the_entry() {
    let app = tauri::test::mock_app();
    let store = Arc::new(SystemMonitorStore::new());
    store.open("s1", Some("host-a".to_string()), None);
    store.opened("s1");
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    app.manage(projection);

    fold_monitor_transition(app.handle(), |s| s.close("s1"));

    assert!(
        store.get("s1").is_none(),
        "close dropped the entry server-side"
    );
}

/// The server now owns monitor entry creation (#2224): the `open` fold creates the
/// `connecting` entry at the source with the UI-only host label, primes any cached
/// stats, and leaves `monitorSessionId` null until the connect settles.
#[test]
fn server_side_open_fold_creates_the_connecting_entry() {
    use termihub_core::monitoring::MonitorStatus;

    let app = tauri::test::mock_app();
    let store = Arc::new(SystemMonitorStore::new());
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    app.manage(projection);

    fold_monitor_transition(app.handle(), |s| {
        s.open("s1", Some("host-a".to_string()), None)
    });

    let entry = store.get("s1").expect("open created the entry server-side");
    assert_eq!(entry.host.as_deref(), Some("host-a"));
    assert!(entry.loading, "a fresh open is loading");
    assert_eq!(entry.monitor_session_id, None);
    assert!(matches!(entry.status, Some(MonitorStatus::Connecting)));
}

/// The fold is a best-effort no-op when no store / projection state is managed
/// (e.g. a headless harness that never ran `setup()`) — it must not panic.
#[test]
fn server_side_fold_is_a_noop_without_managed_state() {
    let app = tauri::test::mock_app();
    // Nothing managed — reaching the assert without panicking is the contract.
    fold_monitor_transition(app.handle(), |s| s.stats("s1", stats("h", 1.0)));
}

// ── Incremental publish equivalence (PERF-006) ────────────────────────────────
//
// The incremental publish (`drain_delta` → reduced diff → in-place splice) must
// emit a diff **byte-identical** to the old whole-region path (re-serialize the
// whole store + `compute_ops` of the two full trees). These tests pin that: at
// each fold they assert the fanned-out ops equal `compute_ops(prev_full,
// new_full)`, and that the subscriber cache converges on the store snapshot.

/// Publish `store` and assert the emitted diff equals the whole-region diff
/// between `prev` (the region view before the fold) and the store's fresh
/// snapshot. Advances `prev` to the new snapshot. Returns nothing; a `None`
/// publish (no change) is asserted to coincide with an empty whole-region diff.
fn assert_incremental_equals_full(
    projector: &Projector,
    store: &SystemMonitorStore,
    sink: &VecSink,
    prev: &mut Value,
    label: &str,
) {
    let before = sink.diffs().len();
    let new_full = store.snapshot();
    let expected_ops: Vec<DiffOp> = compute_ops(prev, &new_full);

    let produced = publish_monitors(projector, store);
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

/// The representative fold sequence the finding calls out — add an entry, update
/// one field of one entry among many, remove an entry, and a no-op — each
/// producing exactly the whole-region diff, over a populated (O(N)) region.
#[test]
fn incremental_publish_is_byte_identical_to_the_whole_region_diff() {
    let store = SystemMonitorStore::new();
    // A populated region: several live monitors, so a whole-region rebuild would
    // be O(N) per fold and a single-entry change must not touch the rest.
    for i in 0..6 {
        let key = format!("s{i}");
        store.open(&key, Some(format!("host-{i}")), None);
        store.opened(&key);
        store.stats(&key, stats(&format!("host-{i}"), i as f64));
    }

    let projector = Projector::new();
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projector.subscribe(SYSTEM_MONITORS_REGION, "sub", "A", sink.clone());

    // Clear the seed dirty set; the region baseline already equals the store, so
    // this drains without emitting (a no-op publish).
    assert!(publish_monitors(&projector, &store).is_empty());

    let mut prev = store.snapshot();

    // 1) Update one field of one entry among many (the hot per-sample path).
    store.stats("s3", stats("host-3", 99.0));
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "update-one-of-many");

    // 2) Add a brand-new entry.
    store.open("s42", Some("host-42".to_string()), None);
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "add-entry");

    // 3) A status change on the new entry, then a stats sample (touches both maps).
    store.opened("s42");
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "opened");
    store.stats("s42", stats("host-42", 7.0));
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "stats-both-maps");

    // 4) Remove an entry (its stats cache survives — a `remove` under /monitors).
    store.close("s0");
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "remove-entry");

    // 5) A genuine no-op: `opened` on an already-live monitor changes nothing.
    store.opened("s1");
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "no-op");

    // The subscriber, fed only the incremental diffs, converges on the authority.
    let snap = projector.snapshot(SYSTEM_MONITORS_REGION);
    assert_eq!(
        snap.view,
        store.snapshot(),
        "region view == store authority"
    );
}

/// Two entries changing in the **same** publish must still diff byte-identically
/// to the whole-region path (both under `/monitors`, plus a `/statsCache` add),
/// exercising multi-key ordering within one reduced diff.
#[test]
fn incremental_publish_coalesces_multi_entry_changes_identically() {
    let store = SystemMonitorStore::new();
    for i in 0..4 {
        let key = format!("s{i}");
        store.open(&key, Some(format!("host-{i}")), None);
        store.opened(&key);
    }
    let projector = Projector::new();
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projector.subscribe(SYSTEM_MONITORS_REGION, "sub", "A", sink.clone());
    assert!(publish_monitors(&projector, &store).is_empty());

    let mut prev = store.snapshot();

    // Mutate three entries before a single publish → one coalesced diff.
    store.stats("s2", stats("host-2", 50.0));
    store.set_paused("s0", true);
    store.close("s3");
    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "coalesced-multi");
}

/// The whole-map `replace` mirror (the one intrinsically O(region) fold) also
/// stays byte-identical: adds for the new keys, removes for the gone ones.
#[test]
fn incremental_publish_replace_matches_the_whole_region_diff() {
    let store = seeded_store(); // s1 connecting, s2 live
    let projector = Projector::new();
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projector.subscribe(SYSTEM_MONITORS_REGION, "sub", "A", sink.clone());
    assert!(publish_monitors(&projector, &store).is_empty());

    let mut prev = store.snapshot();

    let source = SystemMonitorStore::new();
    source.open("s3", Some("host-c".to_string()), None);
    source.opened("s3");
    source.stats("s3", stats("host-c", 7.0));
    let mirror = source.snapshot();
    let monitors = serde_json::from_value(mirror["monitors"].clone()).unwrap();
    let stats_cache = serde_json::from_value(mirror["statsCache"].clone()).unwrap();
    store.replace(monitors, stats_cache);

    assert_incremental_equals_full(&projector, &store, &sink, &mut prev, "replace");
    assert_eq!(prev, source.snapshot(), "region mirrors the replace source");
}
