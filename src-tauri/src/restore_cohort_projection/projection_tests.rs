//! Projection-contract tests for the client-scoped `restore-cohort@<clientId>`
//! region (#2206), reusing the substrate harness (#2164): an in-memory
//! [`ProjectionSink`] and a client cache that applies diffs. The routes here
//! drive a real [`RestoreCohortStore`] directly (the production
//! `register_restore_intents` resolves the same store from the Tauri
//! `AppHandle`; that thin wiring is integration-verified via a local
//! `./scripts/dev.sh` run) through the identical parse → mutate → publish path.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with monotonic
//! versions, client-scoped isolation, rejection paths advance nothing, a no-op
//! intent coalesces to nothing, a dead subscriber is reaped, and the client
//! cache converges on the store's authority across a full cohort.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, ProjectionError,
    ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};
use crate::restore_cohort_projection::projection::{publish_restore_cohort, restore_cohort_region};
use crate::restore_cohort_projection::store::{RestoreCohortStore, TabOutcome};

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// The production `restore.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_restore_intents` runs.
fn registry_for(store: Arc<RestoreCohortStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("restore.beginCohort", move |intent, projector| {
        let pending = required_str_array(intent)?;
        let pre_failed = intent
            .payload
            .get("preFailedCount")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(0);
        let toast_id = intent
            .payload
            .get("toastId")
            .and_then(Value::as_str)
            .map(str::to_string);
        s.begin_cohort(&intent.client_id, &pending, pre_failed, toast_id);
        Ok(publish_restore_cohort(projector, &s, &intent.client_id))
    });

    let s = store;
    registry.route("restore.settleTab", move |intent, projector| {
        let tab_id = intent
            .payload
            .get("tabId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ("bad_payload".to_string(), "missing 'tabId'".to_string()))?;
        let outcome = match intent.payload.get("outcome").and_then(Value::as_str) {
            Some("connected") => TabOutcome::Connected,
            Some("failed") => TabOutcome::Failed,
            _ => {
                return Err((
                    "bad_payload".to_string(),
                    "missing or invalid 'outcome'".to_string(),
                ))
            }
        };
        s.settle_tab(&intent.client_id, &tab_id, outcome);
        Ok(publish_restore_cohort(projector, &s, &intent.client_id))
    });

    registry
}

fn required_str_array(intent: &Intent) -> Result<Vec<String>, (String, String)> {
    let arr = intent
        .payload
        .get("pendingTabIds")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            (
                "bad_payload".to_string(),
                "missing 'pendingTabIds'".to_string(),
            )
        })?;
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
fn subscribe_returns_the_empty_baseline_identically_to_every_subscriber() {
    let store = Arc::new(RestoreCohortStore::new());
    let region = restore_cohort_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));

    let snap_a = projector.subscribe(&region, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(&region, "sub-b", "A", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "restore-cohort@A");
    assert_eq!(snap_a.view["cohort"], Value::Null);
    assert_eq!(snap_a.view["failedTabIds"], json!([]));
    assert_eq!(snap_a.view["settlement"], Value::Null);
}

#[test]
fn a_begin_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = Arc::new(RestoreCohortStore::new());
    let region = restore_cohort_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub-a", "A", sink_a.clone());
    projector.subscribe(&region, "sub-b", "A", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "restore.beginCohort",
        "A",
        json!({ "pendingTabIds": ["t1", "t2"], "preFailedCount": 0 }),
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
    assert_eq!(cache_a.view["cohort"]["total"], json!(2));
}

#[test]
fn a_full_cohort_advances_monotonically_and_converges() {
    let store = Arc::new(RestoreCohortStore::new());
    let region = restore_cohort_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // begin(2) → settle t1 connected → settle t2 failed (settles the cohort).
    for (kind, payload) in [
        (
            "restore.beginCohort",
            json!({ "pendingTabIds": ["t1", "t2"], "preFailedCount": 0, "toastId": "x" }),
        ),
        (
            "restore.settleTab",
            json!({ "tabId": "t1", "outcome": "connected" }),
        ),
        (
            "restore.settleTab",
            json!({ "tabId": "t2", "outcome": "failed" }),
        ),
    ] {
        let ack = dispatcher.dispatch(intent(kind, "A", payload));
        assert_eq!(ack.status, IntentStatus::Accepted, "{kind} accepted");
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 3, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 3);
    assert_eq!(
        cache.view,
        store.snapshot("A"),
        "cache converges on authority"
    );
    assert_eq!(cache.view["cohort"], Value::Null);
    assert_eq!(cache.view["settlement"]["restored"], json!(1));
    assert_eq!(cache.view["settlement"]["failed"], json!(1));
    assert_eq!(cache.view["settlement"]["retryTabIds"], json!(["t2"]));
    assert_eq!(cache.view["failedTabIds"], json!(["t2"]));
}

#[test]
fn a_cohort_is_isolated_to_its_client_region() {
    let store = Arc::new(RestoreCohortStore::new());
    let region_a = restore_cohort_region("A");
    let region_b = restore_cohort_region("B");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region_a, store.snapshot("A"));
    projector.register_region(&region_b, store.snapshot("B"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    projector.subscribe(&region_a, "sa", "A", sink_a.clone());
    projector.subscribe(&region_b, "sb", "B", sink_b.clone());

    dispatcher.dispatch(intent(
        "restore.beginCohort",
        "A",
        json!({ "pendingTabIds": ["t1"], "preFailedCount": 0 }),
    ));

    assert_eq!(sink_a.diffs().len(), 1, "A's region advanced");
    assert_eq!(sink_b.diffs().len(), 0, "B's region untouched");
    assert_eq!(projector.region_version(&region_b), Some(0));
}

#[test]
fn an_intent_missing_required_fields_is_rejected_without_advancing() {
    let store = Arc::new(RestoreCohortStore::new());
    let region = restore_cohort_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent("restore.settleTab", "A", json!({ "tabId": "t1" })));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn a_no_op_settle_advances_nothing() {
    // Settling with no active cohort leaves the view unchanged, so the projector
    // coalesces it to no diff and no version bump.
    let store = Arc::new(RestoreCohortStore::new());
    let region = restore_cohort_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent(
        "restore.settleTab",
        "A",
        json!({ "tabId": "ghost", "outcome": "failed" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = Arc::new(RestoreCohortStore::new());
    let region = restore_cohort_region("A");
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
        "restore.beginCohort",
        "A",
        json!({ "pendingTabIds": ["t1"], "preFailedCount": 0 }),
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
