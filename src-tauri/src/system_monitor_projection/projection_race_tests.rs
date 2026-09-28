//! Concurrency and cross-check tests for the incremental `system-monitors`
//! publish (#3788, the #3780 pattern): folds racing a publish between its drain
//! and its splice must neither trip the debug PERF-006 cross-check nor leave
//! subscribers stale, and the cross-check must still catch (and resync) a
//! genuine divergence.
//!
//! Production has concurrent publishers here: the intent dispatcher, each
//! session's monitoring collector task and the Tauri monitoring commands. The
//! race these pin is e.g. a collector's last stats sample racing a `close`: the
//! old ordering could splice the drained (still-open) entry back over the
//! removal, leaving a closed monitor on screen for good.

use std::sync::mpsc;
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use termihub_core::monitoring::{MonitorStatus, SystemStats};

use crate::projection::{
    apply_ops, compute_ops, publish_hook, DiffFrame, ProjectionError, ProjectionFrame,
    ProjectionSink, Projector,
};
use crate::system_monitor_projection::projection::{
    apply_monitor_delta, publish_monitors, SYSTEM_MONITORS_REGION,
};
use crate::system_monitor_projection::store::{RegionDelta, SystemMonitorStore};

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

fn stats(cpu: f64) -> SystemStats {
    SystemStats {
        hostname: "host".to_string(),
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
        swap_total_kb: 4_000_000,
        swap_used_kb: 1_000_000,
        swap_used_percent: 25.0,
        net_rx_bytes_per_sec: 1024.0,
        net_tx_bytes_per_sec: 512.0,
        per_core_cpu_percent: vec![25.0, 75.0],
    }
}

/// One fold from a representative mix: the collector's stats/status stream and
/// the command-side open / opened / pause / interval / close lifecycle.
fn fold(store: &SystemMonitorStore, step: usize, key: &str) {
    match step % 7 {
        0 => store.open(key, Some(format!("host-{step}")), None),
        1 => store.opened(key),
        2 => store.stats(key, stats(step as f64)),
        3 => store.set_status(key, MonitorStatus::Stale, None),
        4 => store.set_paused(key, step % 2 == 0),
        5 => store.set_interval(key, 1000 + step as u64),
        _ => store.close(key),
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

/// N threads each fold and then publish, as the collector tasks, commands and
/// dispatcher do. With no final flush publish, the subscriber and the region
/// must still end equal to the store: every fold is followed by its own folder's
/// publish, and drains are applied in lock order.
#[test]
fn concurrent_folds_and_publishes_converge_on_the_store() {
    const THREADS: usize = 6;
    const ITERS: usize = 400;
    let store = Arc::new(SystemMonitorStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let sink = Arc::new(RecordingSink::new());
    let base = projector.subscribe(SYSTEM_MONITORS_REGION, "sub", "A", sink.clone());

    let barrier = Arc::new(Barrier::new(THREADS));
    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            let store = store.clone();
            let projector = projector.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                for i in 0..ITERS {
                    let key = format!("m{}", (t + i) % 3);
                    fold(&store, t * 7 + i, &key);
                    publish_monitors(&projector, &store);
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
        projector.snapshot(SYSTEM_MONITORS_REGION).view,
        store.snapshot(),
        "region view must converge on the store"
    );
}

/// A seeded region with one live monitor and one subscriber, returning the
/// subscriber's baseline.
fn seeded() -> (
    Arc<SystemMonitorStore>,
    Arc<Projector>,
    Arc<RecordingSink>,
    Value,
    u64,
) {
    let store = Arc::new(SystemMonitorStore::new());
    store.open("m1", Some("host".to_string()), None);
    store.opened("m1");
    let projector = Arc::new(Projector::new());
    projector.register_region(SYSTEM_MONITORS_REGION, store.snapshot());
    let sink = Arc::new(RecordingSink::new());
    let base = projector.subscribe(SYSTEM_MONITORS_REGION, "sub", "A", sink.clone());
    // Drain the seed's dirty set (the baseline already equals the store).
    assert!(publish_monitors(&projector, &store).is_empty());
    (store, projector, sink, base.view, base.version)
}

/// The fixed publish exactly as a **release** build runs it: drain under the
/// region lock, no PERF-006 ground truth. The hazard test below uses it so the
/// debug cross-check (which would itself detect — and heal — the stale region)
/// does not mask what release subscribers would see.
fn release_publish(projector: &Projector, store: &SystemMonitorStore) -> Option<u64> {
    projector.publish_delta(SYSTEM_MONITORS_REGION, |view| {
        apply_monitor_delta(view, &store.drain_delta(), None, || unreachable!()).0
    })
}

/// The hazard itself, pinned without the fix in the way: the pre-#3788 ordering
/// (drain, *then* take the region lock) lets a racing `close` publish its
/// removal first, after which the late splice resurrects the drained entry. The
/// region ends stale with nothing left dirty to heal it — which is why the
/// drain must be under the lock.
#[test]
fn draining_outside_the_region_lock_would_resurrect_a_closed_monitor() {
    let (store, projector, _sink, _view, _version) = seeded();
    // The collector's sample…
    store.stats("m1", stats(42.0));
    // …old publish, step 1: drain outside the region lock.
    let stale_delta = store.drain_delta();
    // A racing command closes the monitor and publishes the removal.
    store.close("m1");
    release_publish(&projector, &store);
    assert!(projector.snapshot(SYSTEM_MONITORS_REGION).view["monitors"]
        .get("m1")
        .is_none());
    // Old publish, step 2: splice the already-drained (older) delta.
    projector.publish_delta(SYSTEM_MONITORS_REGION, |view| {
        apply_monitor_delta(view, &stale_delta, None, || unreachable!()).0
    });

    let region = projector.snapshot(SYSTEM_MONITORS_REGION).view;
    assert!(
        region["monitors"].get("m1").is_some(),
        "the closed monitor was resurrected"
    );
    // Nothing is left dirty, so a further (release) publish cannot heal it.
    assert_eq!(release_publish(&projector, &store), None);
    assert_ne!(
        projector.snapshot(SYSTEM_MONITORS_REGION).view,
        store.snapshot()
    );
}

/// The debug-check TOCTOU, pinned deterministically: a fold lands on the store
/// *after* this publish drained its delta. The publish must neither trip the
/// PERF-006 cross-check nor lose the fold — the next publish carries it.
#[test]
fn a_fold_landing_after_the_drain_neither_trips_the_check_nor_is_lost() {
    let (store, projector, sink, view, version) = seeded();
    store.stats("m1", stats(42.0));
    let s = store.clone();
    publish_hook::set_after_drain(move || s.close("m1"));

    publish_monitors(&projector, &store);
    let after_first = replay(&sink, view.clone(), version);
    assert_eq!(
        after_first["monitors"]["m1"]["stats"]["cpuUsagePercent"],
        42.0
    );

    publish_monitors(&projector, &store);
    let converged = replay(&sink, view, version);
    assert!(converged["monitors"].get("m1").is_none());
    assert_eq!(converged, store.snapshot());
}

/// The release-path race: a `close` **and its publish** racing in between a
/// collector publish's drain and its splice. The drain is ordered with the
/// splice under the region lock, so the racer can only publish after us, and
/// the subscriber ends with the monitor closed.
#[test]
fn a_close_racing_between_drain_and_splice_cannot_resurrect_the_monitor() {
    let (store, projector, sink, view, version) = seeded();
    store.stats("m1", stats(42.0));

    let racer: Arc<Mutex<Option<thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let (s, p, slot) = (store.clone(), projector.clone(), racer.clone());
    publish_hook::set_after_drain(move || {
        let (done_tx, done_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            s.close("m1");
            publish_monitors(&p, &s);
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

    publish_monitors(&projector, &store);
    let handle = racer.lock().unwrap().take().expect("hook ran");
    handle.join().expect("racer must not panic");

    let converged = replay(&sink, view, version);
    assert!(converged["monitors"].get("m1").is_none(), "monitor closed");
    assert_eq!(converged, store.snapshot(), "subscriber must converge");
    assert_eq!(
        projector.snapshot(SYSTEM_MONITORS_REGION).view,
        store.snapshot(),
        "region view must converge"
    );
}

/// The cross-check keeps its teeth: a genuine dirty-tracking miss or a stale
/// drained value is detected, and the publish resyncs to the whole-region diff
/// instead of emitting the bad one.
#[test]
fn the_cross_check_catches_a_real_divergence_and_resyncs() {
    let store = SystemMonitorStore::new();
    store.open("a", None, None);
    store.open("b", None, None);
    let (_, mut view) = store.drain_delta_with_snapshot();
    let old_full = view.clone();

    store.opened("a");
    store.stats("b", stats(7.0));
    let (full_delta, truth) = store.drain_delta_with_snapshot();
    // Simulate a dirty-tracking miss: drop "b" from the monitors delta.
    let missed = RegionDelta {
        monitors: full_delta
            .monitors
            .into_iter()
            .filter(|(key, _)| key != "b")
            .collect(),
        stats_cache: full_delta.stats_cache,
    };

    let (ops, divergence) =
        apply_monitor_delta(&mut view, &missed, Some(&truth), || unreachable!());
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

    // A stale value (right key, wrong content) is caught too.
    let mut view = old_full.clone();
    let stale = RegionDelta {
        monitors: vec![
            ("a".to_string(), old_full["monitors"].get("a").cloned()),
            ("b".to_string(), truth["monitors"].get("b").cloned()),
        ],
        stats_cache: vec![("b".to_string(), truth["statsCache"].get("b").cloned())],
    };
    let (_, divergence) = apply_monitor_delta(&mut view, &stale, Some(&truth), || unreachable!());
    assert!(
        divergence.is_some(),
        "a stale drained value must be detected"
    );
    assert_eq!(view, truth);
}

/// A consistent delta passes the cross-check untouched (no false positive).
#[test]
fn the_cross_check_accepts_a_consistent_delta() {
    let store = SystemMonitorStore::new();
    store.open("a", None, None);
    let (_, mut view) = store.drain_delta_with_snapshot();
    let old_full = view.clone();
    store.opened("a");
    store.stats("a", stats(3.0));
    store.close("zz");
    let (delta, truth) = store.drain_delta_with_snapshot();
    let (ops, divergence) = apply_monitor_delta(&mut view, &delta, Some(&truth), || unreachable!());
    assert_eq!(divergence, None);
    assert_eq!(ops, compute_ops(&old_full, &truth));
    assert_eq!(view, truth);
}
