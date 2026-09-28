//! Concurrency and cross-check tests for the incremental `session-lifecycle`
//! publish (#3780): folds racing a publish between its drain and its splice must
//! neither trip the debug PERF-006 cross-check nor leave subscribers stale, and
//! the cross-check must still catch (and resync) a genuine divergence.

use std::sync::mpsc;
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::projection::{
    apply_ops, compute_ops, DiffFrame, ProjectionError, ProjectionFrame, ProjectionSink, Projector,
};
use crate::session_projection::projection::{
    apply_session_delta, publish_hook, publish_sessions, SESSION_LIFECYCLE_REGION,
};
use crate::session_projection::store::{RegionDelta, SessionLifecycleStore};

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

fn fold(store: &SessionLifecycleStore, step: usize, id: &str) {
    match step % 5 {
        0 => store.connect(id),
        1 => store.connected(id),
        2 => store.dropped(id, Some(format!("drop-{step}"))),
        3 => store.disconnect(id),
        _ => store.remove(id),
    }
}

#[test]
fn concurrent_folds_and_publishes_converge_on_the_store() {
    const THREADS: usize = 6;
    const ITERS: usize = 400;
    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.0));
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let sink = Arc::new(RecordingSink::new());
    let base = projector.subscribe(SESSION_LIFECYCLE_REGION, "sub", "A", sink.clone());

    let barrier = Arc::new(Barrier::new(THREADS));
    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            let store = store.clone();
            let projector = projector.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                for i in 0..ITERS {
                    let id = format!("s{}", (t + i) % 3);
                    fold(&store, t * 7 + i, &id);
                    publish_sessions(&projector, &store);
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("publisher thread must not panic");
    }
    // A final quiescent publish flushes anything still dirty.
    publish_sessions(&projector, &store);

    let mut version = base.version;
    let mut view: Value = base.view.clone();
    for diff in sink.diffs() {
        assert_eq!(diff.base_version, version, "diffs must chain");
        apply_ops(&mut view, &diff.ops).expect("diff applies cleanly");
        version = diff.version;
    }
    assert_eq!(
        view,
        store.snapshot(),
        "subscriber must converge on the store"
    );
    assert_eq!(
        projector.snapshot(SESSION_LIFECYCLE_REGION).view,
        store.snapshot(),
        "region view must converge on the store"
    );
}

/// A seeded region with one subscriber, returning the subscriber's client cache
/// (baseline view + version) so a test can replay the fanned-out diffs.
fn seeded() -> (
    Arc<SessionLifecycleStore>,
    Arc<Projector>,
    Arc<RecordingSink>,
    Value,
    u64,
) {
    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.0));
    store.connect("s1");
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let sink = Arc::new(RecordingSink::new());
    let base = projector.subscribe(SESSION_LIFECYCLE_REGION, "sub", "A", sink.clone());
    // Drain the seed's dirty set (the baseline already equals the store).
    assert!(publish_sessions(&projector, &store).is_empty());
    (store, projector, sink, base.view, base.version)
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

/// The debug-check TOCTOU of #3780, pinned deterministically: a fold lands on
/// the store *after* this publish drained its delta. The publish must neither
/// trip the PERF-006 cross-check nor lose the fold — the next publish carries it.
#[test]
fn a_fold_landing_after_the_drain_neither_trips_the_check_nor_is_lost() {
    let (store, projector, sink, view, version) = seeded();
    store.connect("x");
    let s = store.clone();
    publish_hook::set_after_drain(move || s.connected("x"));

    publish_sessions(&projector, &store);
    let after_first = replay(&sink, view.clone(), version);
    assert_eq!(after_first["sessions"]["x"]["status"], "connecting");

    publish_sessions(&projector, &store);
    let converged = replay(&sink, view, version);
    assert_eq!(converged["sessions"]["x"]["status"], "connected");
    assert_eq!(converged, store.snapshot());
}

/// The release-path half of #3780: another thread's fold **and publish** racing
/// in between this publish's drain and its splice. Were the drain taken outside
/// the region lock, the other publish would splice the newer value first and
/// this one would then overwrite it with its older, already-drained value —
/// leaving every subscriber stale with nothing left dirty to heal it. The drain
/// must be ordered with the splice, so the racer can only publish after us.
#[test]
fn a_publish_racing_between_drain_and_splice_cannot_leave_the_region_stale() {
    let (store, projector, sink, view, version) = seeded();
    store.connect("x");

    let racer: Arc<Mutex<Option<thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let (s, p, slot) = (store.clone(), projector.clone(), racer.clone());
    publish_hook::set_after_drain(move || {
        let (done_tx, done_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            s.connected("x");
            publish_sessions(&p, &s);
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

    publish_sessions(&projector, &store);
    let handle = racer.lock().unwrap().take().expect("hook ran");
    handle.join().expect("racer must not panic");

    let converged = replay(&sink, view, version);
    assert_eq!(converged["sessions"]["x"]["status"], "connected");
    assert_eq!(converged, store.snapshot(), "subscriber must converge");
    assert_eq!(
        projector.snapshot(SESSION_LIFECYCLE_REGION).view,
        store.snapshot(),
        "region view must converge"
    );
}

/// The cross-check must keep its teeth: a genuine dirty-tracking miss (a delta
/// that omits a session the store changed) is detected, and the publish resyncs
/// to the whole-region diff instead of emitting the incomplete one.
#[test]
fn the_cross_check_catches_a_real_divergence_and_resyncs() {
    let store = SessionLifecycleStore::new();
    store.set_rand_for_test(Box::new(|| 0.0));
    store.connect("a");
    store.connect("b");
    let (_, mut view) = store.drain_delta_with_snapshot();
    let old_full = view.clone();

    store.connected("a");
    store.connected("b");
    let (full_delta, truth) = store.drain_delta_with_snapshot();
    // Simulate a dirty-tracking miss: drop "b" from the delta.
    let missed = RegionDelta {
        sessions: full_delta
            .sessions
            .into_iter()
            .filter(|(key, _)| key != "b")
            .collect(),
    };

    let (ops, divergence) =
        apply_session_delta(&mut view, &missed, Some(&truth), || unreachable!());
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

    // And a stale value (right key, wrong content) is caught too.
    let mut view = old_full.clone();
    let stale = RegionDelta {
        sessions: vec![
            ("a".to_string(), old_full["sessions"].get("a").cloned()),
            ("b".to_string(), truth["sessions"].get("b").cloned()),
        ],
    };
    let (_, divergence) = apply_session_delta(&mut view, &stale, Some(&truth), || unreachable!());
    assert!(
        divergence.is_some(),
        "a stale drained value must be detected"
    );
    assert_eq!(view, truth);
}

/// A consistent delta passes the cross-check untouched (no false positive).
#[test]
fn the_cross_check_accepts_a_consistent_delta() {
    let store = SessionLifecycleStore::new();
    store.connect("a");
    let (_, mut view) = store.drain_delta_with_snapshot();
    let old_full = view.clone();
    store.connected("a");
    store.remove("zz");
    let (delta, truth) = store.drain_delta_with_snapshot();
    let (ops, divergence) = apply_session_delta(&mut view, &delta, Some(&truth), || unreachable!());
    assert_eq!(divergence, None);
    assert_eq!(ops, compute_ops(&old_full, &truth));
    assert_eq!(view, truth);
}
