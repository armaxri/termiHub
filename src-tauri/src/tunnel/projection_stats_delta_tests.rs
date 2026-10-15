//! Tests for the stats-only `tunnels` projection delta (#4574).
//!
//! The 1 Hz live-stats tick publishes via [`publish_stats_delta`] instead of a
//! full [`publish_tunnels`] rebuild. These tests pin that:
//!
//! * a stats tick emits one diff whose ops touch only `states.<id>.stats`;
//! * the delta is exactly the whole-region diff, so a client applying it holds
//!   the same view a full publish would produce (parity), and a following full
//!   publish of the same truth is a no-op;
//! * unchanged / non-connected / unknown samples emit nothing;
//! * deltas interleave in version order with full publishes, and a client that
//!   misses a delta detects the gap and resyncs to the full view.

use std::sync::Arc;

use serde_json::Value;

use super::tests::{dynamic_tunnel, local_tunnel, state, ClientCache, VecSink};
use super::*;
use crate::projection::{compute_ops, DiffOp};
use crate::tunnel::config::{TunnelConfig, TunnelState, TunnelStats, TunnelStatus};

fn stats(sent: u64, received: u64, active: u32, total: u64) -> TunnelStats {
    TunnelStats {
        bytes_sent: sent,
        bytes_received: received,
        active_connections: active,
        total_connections: total,
    }
}

fn configs() -> Vec<TunnelConfig> {
    vec![
        local_tunnel("t1", "db"),
        dynamic_tunnel("t2", "socks"),
        local_tunnel("t3", "web"),
    ]
}

/// The authoritative states: t1 and t3 connected with the given stats, t2 idle.
fn states(t1: TunnelStats, t3: TunnelStats) -> Vec<TunnelState> {
    vec![
        TunnelState::desktop("t1".into(), TunnelStatus::Connected, None, t1),
        state("t2", TunnelStatus::Disconnected),
        TunnelState::desktop("t3".into(), TunnelStatus::Connected, None, t3),
    ]
}

/// The full view [`build_tunnel_view`] would produce for these stats.
fn full_view(t1: TunnelStats, t3: TunnelStats) -> Value {
    tunnel_view_from(configs(), states(t1, t3))
}

/// A projector seeded with the zero-stats view and one subscribed sink.
fn seeded() -> (Projector, Arc<VecSink>, ClientCache) {
    let projector = Projector::new();
    projector.register_region(
        TUNNELS_REGION,
        full_view(TunnelStats::default(), TunnelStats::default()),
    );
    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(TUNNELS_REGION, "sub-a", "A", sink.clone());
    let cache = ClientCache::from_snapshot(&snap);
    (projector, sink, cache)
}

fn op_path(op: &DiffOp) -> String {
    serde_json::to_value(op).unwrap()["path"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn stats_tick_emits_one_delta_touching_only_stats_paths() {
    let (projector, sink, _) = seeded();

    let version = publish_stats_delta(&projector, || vec![("t1".into(), stats(10, 20, 1, 1))]);

    assert_eq!(version, Some(1));
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one tick = one frame");
    assert_eq!((diffs[0].base_version, diffs[0].version), (0, 1));
    assert!(!diffs[0].ops.is_empty());
    for op in &diffs[0].ops {
        let path = op_path(op);
        assert!(
            path.starts_with("/states/t1/stats/"),
            "stats tick touched a non-stats path: {path}"
        );
    }
}

#[test]
fn delta_ops_equal_the_whole_region_diff() {
    let (projector, sink, _) = seeded();
    let old = full_view(TunnelStats::default(), TunnelStats::default());
    let (s1, s3) = (stats(1, 2, 3, 4), stats(5, 6, 0, 7));

    // Feed the samples out of key order: the ops must still match the
    // whole-view diff, which visits keys sorted.
    publish_stats_delta(&projector, || {
        vec![("t3".into(), s3.clone()), ("t1".into(), s1.clone())]
    });

    let expected = compute_ops(&old, &full_view(s1, s3));
    assert_eq!(sink.diffs()[0].ops, expected);
}

#[test]
fn client_applying_the_delta_equals_the_full_publish_view() {
    let (projector, sink, mut cache) = seeded();
    let ticks = [
        (stats(100, 50, 1, 1), stats(0, 0, 0, 0)),
        (stats(400, 90, 2, 3), stats(7, 8, 1, 1)),
        (stats(400, 90, 0, 3), stats(70, 80, 1, 2)),
    ];

    for (s1, s3) in &ticks {
        publish_stats_delta(&projector, || {
            vec![("t1".into(), s1.clone()), ("t3".into(), s3.clone())]
        });
        let diff = sink.diffs().pop().unwrap();
        cache.apply(&diff);
        let truth = full_view(s1.clone(), s3.clone());
        assert_eq!(
            cache.view, truth,
            "client view diverged from a full publish"
        );
        assert_eq!(projector.snapshot(TUNNELS_REGION).view, truth);
    }

    // The spliced region already equals the truth, so a full rebuild of the
    // same state has nothing to say.
    let (s1, s3) = ticks[2].clone();
    let frames_before = sink.diffs().len();
    assert_eq!(projector.publish(TUNNELS_REGION, full_view(s1, s3)), None);
    assert_eq!(sink.diffs().len(), frames_before);
}

#[test]
fn unchanged_stats_emit_nothing_and_do_not_bump_the_version() {
    let (projector, sink, _) = seeded();

    let version = publish_stats_delta(&projector, || {
        vec![
            ("t1".into(), TunnelStats::default()),
            ("t3".into(), TunnelStats::default()),
        ]
    });

    assert_eq!(version, None);
    assert!(sink.diffs().is_empty());
    assert_eq!(projector.region_version(TUNNELS_REGION), Some(0));
}

#[test]
fn non_connected_and_unknown_tunnels_are_skipped() {
    let mut view = full_view(TunnelStats::default(), TunnelStats::default());
    let before = view.clone();

    // t2 is disconnected (get_statuses never reports live stats for it) and
    // "ghost" has no projected state yet: the full publish carries both.
    let ops = apply_tunnel_stats_delta(
        &mut view,
        &[
            ("t2".into(), stats(9, 9, 9, 9)),
            ("ghost".into(), stats(1, 1, 1, 1)),
        ],
    );

    assert!(ops.is_empty());
    assert_eq!(view, before, "a skipped sample must not touch the view");
}

#[test]
fn view_without_states_is_a_no_op() {
    let mut view = Value::Null;
    let ops = apply_tunnel_stats_delta(&mut view, &[("t1".into(), stats(1, 1, 1, 1))]);
    assert!(ops.is_empty());
    assert_eq!(view, Value::Null);
}

#[test]
fn deltas_interleave_in_order_with_full_publishes() {
    let (projector, sink, mut cache) = seeded();

    // Tick → status change (full publish: t3 drops to error) → tick.
    publish_stats_delta(&projector, || vec![("t1".into(), stats(1, 1, 1, 1))]);
    let mut after_error = states(stats(1, 1, 1, 1), TunnelStats::default());
    after_error[2] = TunnelState::desktop(
        "t3".into(),
        TunnelStatus::Error,
        Some("bind lost".into()),
        TunnelStats::default(),
    );
    projector.publish_with(TUNNELS_REGION, || {
        tunnel_view_from(configs(), after_error.clone())
    });
    // t3 is no longer connected, so a stale sample for it is ignored.
    publish_stats_delta(&projector, || {
        vec![
            ("t1".into(), stats(2, 2, 1, 1)),
            ("t3".into(), stats(99, 99, 1, 1)),
        ]
    });

    let diffs = sink.diffs();
    let versions: Vec<_> = diffs.iter().map(|d| (d.base_version, d.version)).collect();
    assert_eq!(versions, vec![(0, 1), (1, 2), (2, 3)]);
    for diff in &diffs {
        cache.apply(diff);
    }
    after_error[0] = TunnelState::desktop(
        "t1".into(),
        TunnelStatus::Connected,
        None,
        stats(2, 2, 1, 1),
    );
    assert_eq!(cache.view, tunnel_view_from(configs(), after_error));
}

#[test]
fn a_missed_delta_is_detected_and_resync_restores_the_full_view() {
    let (projector, sink, mut cache) = seeded();

    publish_stats_delta(&projector, || vec![("t1".into(), stats(1, 1, 1, 1))]);
    publish_stats_delta(&projector, || vec![("t1".into(), stats(2, 2, 1, 1))]);

    // The client lost frame v1: the v2 frame no longer fits its cache.
    let diffs = sink.diffs();
    assert_ne!(
        diffs[1].base_version, cache.version,
        "a dropped delta must surface as a version gap"
    );

    let snap = projector
        .resync(TUNNELS_REGION, Some(cache.version))
        .expect("a stale client gets a fresh snapshot");
    cache = ClientCache::from_snapshot(&snap);
    assert_eq!(cache.version, 2);
    assert_eq!(
        cache.view,
        full_view(stats(2, 2, 1, 1), TunnelStats::default())
    );
    // A current client's resync is a no-op.
    assert!(projector
        .resync(TUNNELS_REGION, Some(cache.version))
        .is_none());
}
