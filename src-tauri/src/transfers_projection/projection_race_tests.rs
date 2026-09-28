//! Concurrency and cross-check tests for the incremental `transfers` publish
//! (#3788, the #3780 pattern): folds racing a publish between its drain and its
//! splice must neither trip the debug PERF-006 cross-check nor leave subscribers
//! stale, and the cross-check must still catch (and resync) a genuine divergence.
//!
//! Production has concurrent publishers here: the intent dispatcher and one
//! progress sink per running transfer (`fold_transfer_progress`).

use std::sync::mpsc;
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::projection::{
    apply_ops, compute_ops, publish_hook, DiffFrame, ProjectionError, ProjectionFrame,
    ProjectionSink, Projector,
};
use crate::transfers_projection::projection::{
    apply_transfer_delta, publish_transfers, TRANSFERS_REGION,
};
use crate::transfers_projection::store::{
    RegionDelta, TransferProgress, TransferSeed, TransferStore,
};

struct RecordingSink {
    frames: Mutex<Vec<ProjectionFrame>>,
}

impl RecordingSink {
    fn new() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
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

impl ProjectionSink for RecordingSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        self.frames.lock().unwrap().push(frame.clone());
        Ok(())
    }
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

fn progress(id: &str, state: &str, transferred: u64) -> TransferProgress {
    serde_json::from_value(json!({
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
    }))
    .unwrap()
}

/// One fold from a representative mix: seed, progress, completion, removal,
/// clear-completed and the `minimized` scalar (carried by every publish).
fn fold(store: &TransferStore, step: usize, id: &str) {
    let now = 10_000 + step as u64;
    match step % 7 {
        0 => store.seed(&seed(id), now),
        1 => store.progress(&progress(id, "active", step as u64 % 1000), now),
        2 => store.progress(&progress(id, "completed", 1000), now),
        3 => store.set_minimized(step % 2 == 0),
        4 => store.remove(id),
        5 => store.clear_completed(),
        _ => store.progress(&progress(id, "paused", step as u64 % 1000), now),
    }
}

/// Replay every diff the subscriber received onto its baseline.
fn replay(sink: &RecordingSink, mut view: Value, mut version: u64) -> Value {
    for diff in sink.diffs() {
        assert_eq!(diff.base_version, version, "diffs must chain");
        apply_ops(&mut view, &diff.ops).expect("diff applies cleanly");
        version = diff.version;
    }
    view
}

/// N threads each fold and then publish, as the dispatcher and the per-transfer
/// progress sinks do. With no final flush publish, the subscriber and the region
/// must still end equal to the store: every fold is followed by its own folder's
/// publish, and drains are applied in lock order.
#[test]
fn concurrent_folds_and_publishes_converge_on_the_store() {
    const THREADS: usize = 6;
    const ITERS: usize = 400;
    let store = Arc::new(TransferStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let sink = Arc::new(RecordingSink::new());
    let base = projector.subscribe(TRANSFERS_REGION, "sub", "A", sink.clone());

    let barrier = Arc::new(Barrier::new(THREADS));
    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            let store = store.clone();
            let projector = projector.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                for i in 0..ITERS {
                    let id = format!("t{}", (t + i) % 3);
                    fold(&store, t * 7 + i, &id);
                    publish_transfers(&projector, &store);
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("publisher thread must not panic");
    }

    assert_eq!(
        replay(&sink, base.view.clone(), base.version),
        store.snapshot(),
        "subscriber must converge on the store"
    );
    assert_eq!(
        projector.snapshot(TRANSFERS_REGION).view,
        store.snapshot(),
        "region view must converge on the store"
    );
}

/// A seeded region with one subscriber, returning the subscriber's baseline.
fn seeded() -> (
    Arc<TransferStore>,
    Arc<Projector>,
    Arc<RecordingSink>,
    Value,
    u64,
) {
    let store = Arc::new(TransferStore::new());
    store.seed(&seed("t1"), 10_000);
    let projector = Arc::new(Projector::new());
    projector.register_region(TRANSFERS_REGION, store.snapshot());
    let sink = Arc::new(RecordingSink::new());
    let base = projector.subscribe(TRANSFERS_REGION, "sub", "A", sink.clone());
    // Drain the seed's dirty set (the baseline already equals the store).
    assert!(publish_transfers(&projector, &store).is_empty());
    (store, projector, sink, base.view, base.version)
}

/// The fixed publish exactly as a **release** build runs it: drain under the
/// region lock, no PERF-006 ground truth. The hazard test below uses it so the
/// debug cross-check (which would itself detect — and heal — the stale region)
/// does not mask what release subscribers would see.
fn release_publish(projector: &Projector, store: &TransferStore) -> Option<u64> {
    projector.publish_delta(TRANSFERS_REGION, |view| {
        apply_transfer_delta(view, &store.drain_delta(), None, || unreachable!()).0
    })
}

/// The hazard itself, pinned without the fix in the way: the pre-#3788 ordering
/// (drain, *then* take the region lock) lets a racing fold-and-publish land a
/// newer value that the late splice then overwrites with the older one. This
/// replays that interleaving by hand and shows the region ends stale with
/// nothing left dirty to heal it — which is why the drain must be under the lock.
#[test]
fn draining_outside_the_region_lock_would_leave_the_region_stale() {
    let (store, projector, _sink, _view, _version) = seeded();
    store.progress(&progress("t1", "active", 10), 10_001);

    // Old publish, step 1: drain outside the region lock.
    let stale_delta = store.drain_delta();
    // A racing publisher folds a newer value and publishes it in full.
    store.progress(&progress("t1", "active", 20), 10_002);
    store.set_minimized(true);
    release_publish(&projector, &store);
    // Old publish, step 2: splice the already-drained (older) delta.
    projector.publish_delta(TRANSFERS_REGION, |view| {
        apply_transfer_delta(view, &stale_delta, None, || unreachable!()).0
    });

    let region = projector.snapshot(TRANSFERS_REGION).view;
    assert_ne!(region, store.snapshot(), "the old ordering goes stale");
    assert_eq!(
        region["minimized"], false,
        "a newer minimized was overwritten"
    );
    // `minimized` is carried by every delta, so the next publish heals it — but
    // the stale queue row is no longer dirty, so no later publish ever heals it.
    release_publish(&projector, &store);
    let region = projector.snapshot(TRANSFERS_REGION).view;
    assert_eq!(region["minimized"], true);
    assert_ne!(
        region["queue"]["t1"],
        store.snapshot()["queue"]["t1"],
        "the queue row stays stale"
    );
    assert_eq!(release_publish(&projector, &store), None);
}

/// The debug-check TOCTOU, pinned deterministically: a fold lands on the store
/// *after* this publish drained its delta. The publish must neither trip the
/// PERF-006 cross-check nor lose the fold — the next publish carries it.
#[test]
fn a_fold_landing_after_the_drain_neither_trips_the_check_nor_is_lost() {
    let (store, projector, sink, view, version) = seeded();
    store.progress(&progress("t1", "active", 10), 10_001);
    let s = store.clone();
    publish_hook::set_after_drain(move || {
        s.progress(&progress("t1", "completed", 1000), 10_002);
        s.set_minimized(true);
    });

    publish_transfers(&projector, &store);
    let after_first = replay(&sink, view.clone(), version);
    assert_eq!(after_first["queue"]["t1"]["state"], "active");
    assert_eq!(after_first["minimized"], false);

    publish_transfers(&projector, &store);
    let converged = replay(&sink, view, version);
    assert_eq!(converged["queue"]["t1"]["state"], "completed");
    assert_eq!(converged["minimized"], true);
    assert_eq!(converged, store.snapshot());
}

/// The release-path race: another thread's fold **and publish** racing in
/// between this publish's drain and its splice. The drain is ordered with the
/// splice under the region lock, so the racer can only publish after us, and
/// the subscriber ends on the newer value.
#[test]
fn a_publish_racing_between_drain_and_splice_cannot_leave_the_region_stale() {
    let (store, projector, sink, view, version) = seeded();
    store.progress(&progress("t1", "active", 10), 10_001);

    let racer: Arc<Mutex<Option<thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let (s, p, slot) = (store.clone(), projector.clone(), racer.clone());
    publish_hook::set_after_drain(move || {
        let (done_tx, done_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            s.progress(&progress("t1", "completed", 1000), 10_002);
            s.set_minimized(true);
            publish_transfers(&p, &s);
            let _ = done_tx.send(());
        });
        // Give the racer every chance to overtake this publish. With the drain
        // ordered under the region lock it cannot finish until we release it.
        let overtook = done_rx.recv_timeout(Duration::from_millis(200)).is_ok();
        assert!(
            !overtook,
            "a racing publish completed between drain and splice"
        );
        *slot.lock().unwrap() = Some(handle);
    });

    publish_transfers(&projector, &store);
    let handle = racer.lock().unwrap().take().expect("hook ran");
    handle.join().expect("racer must not panic");

    let converged = replay(&sink, view, version);
    assert_eq!(converged["queue"]["t1"]["state"], "completed");
    assert_eq!(converged["minimized"], true);
    assert_eq!(converged, store.snapshot(), "subscriber must converge");
    assert_eq!(
        projector.snapshot(TRANSFERS_REGION).view,
        store.snapshot(),
        "region view must converge"
    );
}

/// The cross-check keeps its teeth: a genuine dirty-tracking miss (a delta that
/// omits a row the store changed) or a stale drained value is detected, and the
/// publish resyncs to the whole-region diff instead of emitting the bad one.
#[test]
fn the_cross_check_catches_a_real_divergence_and_resyncs() {
    let store = TransferStore::new();
    store.seed(&seed("a"), 10_000);
    store.seed(&seed("b"), 10_000);
    let (_, mut view) = store.drain_delta_with_snapshot();
    let old_full = view.clone();

    store.progress(&progress("a", "active", 10), 10_001);
    store.progress(&progress("b", "active", 20), 10_001);
    let (full_delta, truth) = store.drain_delta_with_snapshot();
    // Simulate a dirty-tracking miss: drop "b" from the delta.
    let missed = RegionDelta {
        queue: full_delta
            .queue
            .into_iter()
            .filter(|(key, _)| key != "b")
            .collect(),
        minimized: full_delta.minimized,
    };

    let (ops, divergence) =
        apply_transfer_delta(&mut view, &missed, Some(&truth), || unreachable!());
    let reason = divergence.expect("a missed dirty key must be detected");
    assert!(
        reason.contains("whole-region"),
        "reason names the mismatch: {reason}"
    );
    assert_eq!(
        ops,
        compute_ops(&old_full, &truth),
        "resynced to the full diff"
    );
    assert_eq!(view, truth, "view resynced to the store");

    // A stale scalar (right shape, wrong content) is caught too.
    let mut view = old_full.clone();
    let stale = RegionDelta {
        queue: vec![
            ("a".to_string(), truth["queue"].get("a").cloned()),
            ("b".to_string(), truth["queue"].get("b").cloned()),
        ],
        minimized: !truth["minimized"].as_bool().unwrap(),
    };
    let (_, divergence) = apply_transfer_delta(&mut view, &stale, Some(&truth), || unreachable!());
    assert!(
        divergence.is_some(),
        "a stale drained value must be detected"
    );
    assert_eq!(view, truth);
}

/// A consistent delta passes the cross-check untouched (no false positive).
#[test]
fn the_cross_check_accepts_a_consistent_delta() {
    let store = TransferStore::new();
    store.seed(&seed("a"), 10_000);
    let (_, mut view) = store.drain_delta_with_snapshot();
    let old_full = view.clone();
    store.progress(&progress("a", "active", 10), 10_001);
    store.set_minimized(true);
    store.remove("zz");
    let (delta, truth) = store.drain_delta_with_snapshot();
    let (ops, divergence) =
        apply_transfer_delta(&mut view, &delta, Some(&truth), || unreachable!());
    assert_eq!(divergence, None);
    assert_eq!(ops, compute_ops(&old_full, &truth));
    assert_eq!(view, truth);
}
