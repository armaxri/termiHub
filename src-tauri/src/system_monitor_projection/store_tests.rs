//! Unit tests for the [`SystemMonitorStore`] transitions (#2224).
//!
//! Drives the store directly and asserts on the serialised view model (the type
//! carries a `SystemStats` field, which has no `PartialEq`, so records are
//! compared via their JSON projection).

use serde_json::json;

use termihub_core::monitoring::{MonitorStatus, MonitorStatusReason, SystemStats};

use super::{
    HistoryDelta, MonitorHistorySample, SystemMonitorStore, DEFAULT_MONITORING_INTERVAL_MS,
    MONITOR_HISTORY_CAPACITY,
};

/// A deterministic sample for a host.
fn sample(hostname: &str, cpu: f64) -> SystemStats {
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
        swap_total_kb: 4_000_000,
        swap_used_kb: 1_000_000,
        swap_used_percent: 25.0,
        net_rx_bytes_per_sec: 1024.0,
        net_tx_bytes_per_sec: 512.0,
        per_core_cpu_percent: vec![25.0, 75.0],
        ..Default::default()
    }
}

#[test]
fn a_fresh_store_snapshots_empty() {
    let store = SystemMonitorStore::new();
    assert_eq!(
        store.snapshot(),
        json!({ "history": {}, "monitors": {}, "statsCache": {} })
    );
}

#[test]
fn open_creates_a_loading_connecting_entry() {
    let store = SystemMonitorStore::new();
    store.open("s1", Some("host-a".to_string()), None);

    let entry = store.get("s1").expect("entry exists");
    assert_eq!(entry.host.as_deref(), Some("host-a"));
    assert!(entry.loading);
    assert_eq!(entry.status, Some(MonitorStatus::Connecting));
    assert_eq!(entry.monitor_session_id, None);
    assert_eq!(entry.interval_ms, DEFAULT_MONITORING_INTERVAL_MS);
}

#[test]
fn open_honours_a_custom_interval() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, Some(5000));
    assert_eq!(store.get("s1").unwrap().interval_ms, 5000);
}

#[test]
fn opened_settles_the_entry_live() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.opened("s1");

    let entry = store.get("s1").unwrap();
    assert!(!entry.loading);
    assert_eq!(entry.status, Some(MonitorStatus::Live));
    assert_eq!(entry.monitor_session_id.as_deref(), Some("s1"));
}

#[test]
fn open_failed_clears_loading_and_records_the_error() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.open_failed("s1", Some("connection refused".to_string()));

    let entry = store.get("s1").unwrap();
    assert!(!entry.loading);
    assert_eq!(entry.status, None);
    assert_eq!(entry.monitor_session_id, None);
    assert_eq!(entry.error.as_deref(), Some("connection refused"));
}

#[test]
fn stats_update_entry_and_cache_and_bump_sample_count() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.opened("s1");

    store.stats("s1", sample("host-a", 10.0));
    store.stats("s1", sample("host-a", 20.0));

    let entry = store.get("s1").unwrap();
    assert_eq!(entry.sample_count, 2);
    assert_eq!(entry.stats.as_ref().unwrap().cpu_usage_percent, 20.0);
    // Cache mirrors the latest sample for instant reconnect priming.
    assert_eq!(store.cached_stats("s1").unwrap().cpu_usage_percent, 20.0);
}

#[test]
fn close_drops_the_entry_but_retains_the_cache() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.opened("s1");
    store.stats("s1", sample("host-a", 33.0));

    store.close("s1");
    assert!(store.get("s1").is_none(), "entry dropped");
    assert!(
        store.cached_stats("s1").is_some(),
        "cache retained across close for instant reconnect"
    );
}

#[test]
fn reopen_primes_stats_from_the_retained_cache() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.opened("s1");
    store.stats("s1", sample("host-a", 55.0));
    store.close("s1");

    store.open("s1", None, None);
    let entry = store.get("s1").unwrap();
    assert_eq!(
        entry.stats.as_ref().unwrap().cpu_usage_percent,
        55.0,
        "a reopened monitor shows the last cached stats immediately"
    );
    assert!(entry.loading, "still connecting though");
}

#[test]
fn pause_and_resume_flip_status_and_flag() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.opened("s1");

    store.set_paused("s1", true);
    let entry = store.get("s1").unwrap();
    assert!(entry.paused);
    assert_eq!(entry.status, Some(MonitorStatus::Paused));

    store.set_paused("s1", false);
    let entry = store.get("s1").unwrap();
    assert!(!entry.paused);
    assert_eq!(entry.status, Some(MonitorStatus::Live));
}

#[test]
fn set_interval_and_status_and_clear_error() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.open_failed("s1", Some("boom".to_string()));

    store.set_interval("s1", 10_000);
    store.set_status("s1", MonitorStatus::Stale, None);
    store.clear_error("s1");

    let entry = store.get("s1").unwrap();
    assert_eq!(entry.interval_ms, 10_000);
    assert_eq!(entry.status, Some(MonitorStatus::Stale));
    assert_eq!(entry.error, None);
}

#[test]
fn replace_overwrites_the_whole_map_and_cache() {
    let store = SystemMonitorStore::new();
    // Prime some existing state that `replace` must fully overwrite.
    store.open("old", Some("gone".to_string()), None);
    store.stats("old", sample("gone", 99.0));

    // A snapshot mirroring `appStore`: build it by driving a second store, then
    // hand its serialised view straight back through `replace`.
    let source = SystemMonitorStore::new();
    source.open("s1", Some("host-a".to_string()), None);
    source.opened("s1");
    source.stats("s1", sample("host-a", 42.0));
    let view = source.snapshot();

    let monitors = serde_json::from_value(view["monitors"].clone()).unwrap();
    let stats_cache = serde_json::from_value(view["statsCache"].clone()).unwrap();
    let history = serde_json::from_value(view["history"].clone()).unwrap();
    store.replace(monitors, stats_cache, history);

    // The old entry is gone; the mirrored one is present and byte-identical to
    // the source's projection.
    assert!(store.get("old").is_none(), "replace drops prior entries");
    assert_eq!(
        store.snapshot(),
        source.snapshot(),
        "replace makes the store a faithful copy of the source"
    );
}

#[test]
fn replace_with_empty_maps_clears_everything() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.stats("s1", sample("host-a", 1.0));

    store.replace(
        std::collections::HashMap::new(),
        std::collections::HashMap::new(),
        std::collections::HashMap::new(),
    );
    assert_eq!(
        store.snapshot(),
        json!({ "history": {}, "monitors": {}, "statsCache": {} })
    );
}

#[test]
fn transitions_on_an_unknown_key_are_no_ops() {
    let store = SystemMonitorStore::new();
    // None of these should panic or create an entry.
    store.opened("ghost");
    store.stats("ghost", sample("x", 1.0));
    store.set_status("ghost", MonitorStatus::Live, None);
    store.set_paused("ghost", true);
    store.set_interval("ghost", 1000);
    store.clear_error("ghost");
    store.close("ghost");
    assert!(store.get("ghost").is_none());
    // `stats` still records the cache even without an entry (matches the
    // frontend cache write).
    assert!(store.cached_stats("ghost").is_some());
}

// ── Status reason (#3301) ────────────────────────────────────────────────────

#[test]
fn set_status_records_the_offline_reason_and_serializes_it() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.opened("s1");
    assert_eq!(
        store.snapshot()["monitors"]["s1"]["statusReason"],
        json!(null),
        "a healthy monitor projects a null reason"
    );

    store.set_status(
        "s1",
        MonitorStatus::Offline,
        Some(MonitorStatusReason::Parse),
    );
    let entry = store.get("s1").unwrap();
    assert_eq!(entry.status, Some(MonitorStatus::Offline));
    assert_eq!(entry.status_reason, Some(MonitorStatusReason::Parse));
    assert_eq!(
        store.snapshot()["monitors"]["s1"]["statusReason"],
        json!("parse")
    );

    store.set_status(
        "s1",
        MonitorStatus::Offline,
        Some(MonitorStatusReason::Silent),
    );
    assert_eq!(
        store.snapshot()["monitors"]["s1"]["statusReason"],
        json!("silent")
    );
}

#[test]
fn a_healthy_transition_clears_the_reason() {
    for clear in ["opened", "live", "paused", "open_failed"] {
        let store = SystemMonitorStore::new();
        store.open("s1", None, None);
        store.set_status(
            "s1",
            MonitorStatus::Offline,
            Some(MonitorStatusReason::Transport),
        );
        match clear {
            "opened" => store.opened("s1"),
            "live" => store.set_status("s1", MonitorStatus::Live, None),
            "paused" => store.set_paused("s1", true),
            _ => store.open_failed("s1", Some("boom".to_string())),
        }
        assert_eq!(
            store.get("s1").unwrap().status_reason,
            None,
            "{clear} must clear a stale offline reason"
        );
    }
}

#[test]
fn a_replace_seed_without_a_reason_still_deserializes() {
    // A `monitor.replace` payload from a frontend that predates the field.
    let monitors = serde_json::from_value(json!({
        "s1": {
            "key": "s1", "host": null, "monitorSessionId": "s1", "stats": null,
            "loading": false, "error": null, "status": "offline", "sampleCount": 0,
            "paused": false, "intervalMs": 2000
        }
    }))
    .expect("an entry without statusReason must deserialize");
    let store = SystemMonitorStore::new();
    store.replace(monitors, std::collections::HashMap::new());
    assert_eq!(store.get("s1").unwrap().status_reason, None);
}

// ── History ring (#3204) ─────────────────────────────────────────────────────

/// The CPU values retained in a monitor's history ring, oldest first.
fn history_cpus(store: &SystemMonitorStore, key: &str) -> Vec<f64> {
    store
        .history(key)
        .iter()
        .map(|s| s.stats.cpu_usage_percent)
        .collect()
}

/// The `sampleCount` ordinals retained in a monitor's history ring.
fn history_ordinals(store: &SystemMonitorStore, key: &str) -> Vec<u32> {
    store.history(key).iter().map(|s| s.sample_count).collect()
}

#[test]
fn the_default_history_bound_matches_the_client_window() {
    // The ring replaces the client-side rolling window (`MONITOR_HISTORY_CAP`
    // in `useMonitorHistory.ts`), so it retains exactly as many samples.
    assert_eq!(MONITOR_HISTORY_CAPACITY, 90);
    assert_eq!(
        SystemMonitorStore::new().history_capacity(),
        MONITOR_HISTORY_CAPACITY
    );
}

#[test]
fn stats_append_to_the_history_ring_with_their_sample_ordinal() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    assert!(store.history("s1").is_empty(), "open starts an empty ring");
    store.stats("s1", sample("h", 1.0));
    store.stats("s1", sample("h", 2.0));
    store.stats("s1", sample("h", 3.0));
    assert_eq!(history_cpus(&store, "s1"), vec![1.0, 2.0, 3.0]);
    assert_eq!(history_ordinals(&store, "s1"), vec![1, 2, 3]);
    assert_eq!(
        store.snapshot()["history"]["s1"][2]["stats"]["cpuUsagePercent"],
        json!(3.0)
    );
    assert_eq!(store.snapshot()["history"]["s1"][2]["sampleCount"], json!(3));
}

#[test]
fn the_ring_is_bounded_and_evicts_the_oldest_sample() {
    let store = SystemMonitorStore::with_history_capacity(3);
    store.open("s1", None, None);
    for cpu in 1..=5 {
        store.stats("s1", sample("h", f64::from(cpu)));
    }
    assert_eq!(history_cpus(&store, "s1"), vec![3.0, 4.0, 5.0]);
    assert_eq!(history_ordinals(&store, "s1"), vec![3, 4, 5]);

    // The default bound holds too: 2x capacity samples retain exactly capacity.
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    for cpu in 0..(2 * MONITOR_HISTORY_CAPACITY) {
        store.stats("s1", sample("h", cpu as f64));
    }
    let ring = store.history("s1");
    assert_eq!(ring.len(), MONITOR_HISTORY_CAPACITY);
    assert_eq!(
        ring.first().unwrap().stats.cpu_usage_percent,
        MONITOR_HISTORY_CAPACITY as f64
    );
    assert_eq!(
        ring.last().unwrap().stats.cpu_usage_percent,
        (2 * MONITOR_HISTORY_CAPACITY - 1) as f64
    );
}

#[test]
fn history_retains_the_source_and_unavailable_metrics_of_each_sample() {
    use termihub_core::monitoring::{StatsMetric, StatsSource};
    let store = SystemMonitorStore::new();
    store.open("docker", None, None);
    let mut docker = sample("container", 12.0);
    docker.source = StatsSource::DockerStats;
    docker.unavailable_metrics = vec![StatsMetric::Disk];
    store.stats("docker", docker);

    let view = store.snapshot();
    let retained = &view["history"]["docker"][0]["stats"];
    assert_eq!(retained["source"], json!("dockerStats"));
    assert_eq!(retained["unavailableMetrics"], json!(["disk"]));
}

#[test]
fn a_stats_sample_for_an_unknown_monitor_is_not_retained() {
    // History is bounded by the *live* monitors: a sample for a key with no
    // entry only refreshes the last-known cache, as before.
    let store = SystemMonitorStore::new();
    store.stats("ghost", sample("h", 1.0));
    assert!(store.history("ghost").is_empty());
    assert_eq!(store.snapshot()["history"], json!({}));
}

#[test]
fn reopening_a_monitor_resets_its_history() {
    // A reconnect is a fresh session (its sampleCount restarts at 0), so the
    // ring restarts rather than graphing across the gap as continuous — the
    // same rule the client-side window applied.
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.stats("s1", sample("h", 1.0));
    store.open("s1", None, None);
    assert!(store.history("s1").is_empty());
    assert_eq!(store.snapshot()["history"]["s1"], json!([]));
}

#[test]
fn closing_a_monitor_drops_its_history() {
    let store = SystemMonitorStore::new();
    store.open("s1", None, None);
    store.stats("s1", sample("h", 1.0));
    store.close("s1");
    assert!(store.history("s1").is_empty());
    assert_eq!(store.snapshot()["history"], json!({}));
    // The last-known cache still survives the close (unchanged behaviour).
    assert!(store.cached_stats("s1").is_some());
}

#[test]
fn replace_keeps_history_only_for_mirrored_monitors_and_bounds_it() {
    let store = SystemMonitorStore::with_history_capacity(2);
    let mut monitors = std::collections::HashMap::new();
    let source = SystemMonitorStore::new();
    source.open("s1", None, None);
    monitors.insert("s1".to_string(), source.get("s1").unwrap());

    let ring: Vec<MonitorHistorySample> = (1..=4)
        .map(|n| MonitorHistorySample {
            sample_count: n,
            stats: sample("h", f64::from(n)),
        })
        .collect();
    let mut history = std::collections::HashMap::new();
    history.insert("s1".to_string(), ring.clone());
    history.insert("orphan".to_string(), ring);

    store.replace(monitors, std::collections::HashMap::new(), history);
    assert_eq!(history_cpus(&store, "s1"), vec![3.0, 4.0], "newest kept");
    assert!(
        store.history("orphan").is_empty(),
        "a ring with no monitor entry is not retained"
    );
}

#[test]
fn the_drained_history_delta_is_append_only_between_resets() {
    let store = SystemMonitorStore::with_history_capacity(3);
    store.open("s1", None, None);
    // The open itself publishes the (empty) ring whole.
    let delta = store.drain_delta();
    assert!(matches!(
        delta.history.as_slice(),
        [(key, HistoryDelta::Reset(Some(v)))] if key == "s1" && v == &json!([])
    ));

    // Two samples between drains → one append of both, nothing evicted.
    store.stats("s1", sample("h", 1.0));
    store.stats("s1", sample("h", 2.0));
    let delta = store.drain_delta();
    match delta.history.as_slice() {
        [(key, HistoryDelta::Append {
            evicted,
            start,
            appended,
        })] => {
            assert_eq!(key, "s1");
            assert_eq!((*evicted, *start, appended.len()), (0, 0, 2));
        }
        other => panic!("expected one append, got {other:?}"),
    }

    // Filling past the bound evicts from the front and appends only the new one.
    store.stats("s1", sample("h", 3.0));
    let _ = store.drain_delta();
    store.stats("s1", sample("h", 4.0));
    match store.drain_delta().history.as_slice() {
        [(_, HistoryDelta::Append {
            evicted,
            start,
            appended,
        })] => {
            assert_eq!((*evicted, *start, appended.len()), (1, 2, 1));
            assert_eq!(appended[0]["stats"]["cpuUsagePercent"], json!(4.0));
        }
        other => panic!("expected one append, got {other:?}"),
    }

    // More samples than the bound between two drains collapses to a reset.
    for cpu in 5..=9 {
        store.stats("s1", sample("h", f64::from(cpu)));
    }
    assert!(matches!(
        store.drain_delta().history.as_slice(),
        [(_, HistoryDelta::Reset(Some(_)))]
    ));

    // A close publishes the ring's removal.
    store.close("s1");
    assert!(matches!(
        store.drain_delta().history.as_slice(),
        [(_, HistoryDelta::Reset(None))]
    ));
}
