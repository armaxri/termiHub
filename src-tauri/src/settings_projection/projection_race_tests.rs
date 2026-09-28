//! Concurrency tests for the whole-snapshot `settings` publish (#3788).
//!
//! `settings` is one of the regions that publish a whole store snapshot
//! (with agents, connections, tunnels and the per-client regions), and it has
//! concurrent publishers in production: the intent dispatcher and
//! `fold_settings_from_manager` from Tauri command threads. These pin that the
//! snapshot is taken under the region lock ([`Projector::publish_with`]), so a
//! racing fold-and-publish can never be overwritten by an older snapshot.

use std::sync::mpsc;
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::projection::{
    apply_ops, publish_hook, DiffFrame, ProjectionError, ProjectionFrame, ProjectionSink, Projector,
};
use crate::settings_projection::projection::{publish_settings, SETTINGS_REGION};
use crate::settings_projection::store::SettingsStore;

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

fn patch(key: &str, value: Value) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(key.to_string(), value);
    map
}

fn replay(sink: &RecordingSink, mut view: Value, mut version: u64) -> Value {
    for diff in sink.diffs() {
        assert_eq!(diff.base_version, version, "diffs must chain");
        apply_ops(&mut view, &diff.ops).expect("diff applies cleanly");
        version = diff.version;
    }
    view
}

fn seeded() -> (
    Arc<SettingsStore>,
    Arc<Projector>,
    Arc<RecordingSink>,
    Value,
    u64,
) {
    let store = Arc::new(SettingsStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(SETTINGS_REGION, store.snapshot());
    let sink = Arc::new(RecordingSink::new());
    let base = projector.subscribe(SETTINGS_REGION, "sub", "A", sink.clone());
    (store, projector, sink, base.view, base.version)
}

/// N threads each fold and then publish. With no final flush publish, the
/// subscriber and the region must still end equal to the store.
#[test]
fn concurrent_folds_and_publishes_converge_on_the_store() {
    const THREADS: usize = 6;
    const ITERS: usize = 400;
    let (store, projector, sink, view, version) = seeded();

    let barrier = Arc::new(Barrier::new(THREADS));
    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            let store = store.clone();
            let projector = projector.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                for i in 0..ITERS {
                    let key = format!("raceKey{}", (t + i) % 3);
                    store.patch(patch(&key, json!(t * ITERS + i)));
                    publish_settings(&projector, &store);
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("publisher thread must not panic");
    }

    assert_eq!(
        replay(&sink, view, version),
        store.snapshot(),
        "subscriber must converge on the store"
    );
    assert_eq!(
        projector.snapshot(SETTINGS_REGION).view,
        store.snapshot(),
        "region view must converge on the store"
    );
}

/// The hazard itself: a snapshot taken *before* the region lock (the pre-#3788
/// `publish(region, store.snapshot())`) can be published over a newer one a
/// racing publisher already landed, leaving the region stale.
#[test]
fn publishing_a_snapshot_taken_outside_the_region_lock_would_go_stale() {
    let (store, projector, _sink, _view, _version) = seeded();
    store.patch(patch("raceKey", json!(1)));
    let stale = store.snapshot();
    store.patch(patch("raceKey", json!(2)));
    publish_settings(&projector, &store);
    projector.publish(SETTINGS_REGION, stale);

    assert_eq!(
        projector.snapshot(SETTINGS_REGION).view["raceKey"],
        1,
        "the older snapshot overwrote the newer one"
    );
    assert_ne!(projector.snapshot(SETTINGS_REGION).view, store.snapshot());
}

/// The fix, pinned deterministically: another thread's fold **and publish**
/// racing in between this publish's snapshot and its splice cannot overtake it,
/// so the subscriber ends on the newer value.
#[test]
fn a_publish_racing_between_snapshot_and_splice_cannot_leave_the_region_stale() {
    let (store, projector, sink, view, version) = seeded();
    store.patch(patch("raceKey", json!(1)));

    let racer: Arc<Mutex<Option<thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let (s, p, slot) = (store.clone(), projector.clone(), racer.clone());
    publish_hook::set_after_drain(move || {
        let (done_tx, done_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            s.patch(patch("raceKey", json!(2)));
            publish_settings(&p, &s);
            let _ = done_tx.send(());
        });
        let overtook = done_rx.recv_timeout(Duration::from_millis(200)).is_ok();
        assert!(
            !overtook,
            "a racing publish completed between snapshot and splice"
        );
        *slot.lock().unwrap() = Some(handle);
    });

    publish_settings(&projector, &store);
    let handle = racer.lock().unwrap().take().expect("hook ran");
    handle.join().expect("racer must not panic");

    let converged = replay(&sink, view, version);
    assert_eq!(converged["raceKey"], 2);
    assert_eq!(converged, store.snapshot(), "subscriber must converge");
    assert_eq!(
        projector.snapshot(SETTINGS_REGION).view,
        store.snapshot(),
        "region view must converge"
    );
}
