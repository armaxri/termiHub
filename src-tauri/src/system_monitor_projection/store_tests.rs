//! Unit tests for the shadow [`SystemMonitorStore`] transitions (#2224).
//!
//! Drives the store directly and asserts on the serialised view model (the type
//! carries a `SystemStats` field, which has no `PartialEq`, so records are
//! compared via their JSON projection).

use serde_json::json;

use termihub_core::monitoring::{MonitorStatus, SystemStats};

use super::{SystemMonitorStore, DEFAULT_MONITORING_INTERVAL_MS};

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
    }
}

#[test]
fn a_fresh_store_snapshots_empty() {
    let store = SystemMonitorStore::new();
    assert_eq!(store.snapshot(), json!({ "monitors": {}, "statsCache": {} }));
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
    store.set_status("s1", MonitorStatus::Stale);
    store.clear_error("s1");

    let entry = store.get("s1").unwrap();
    assert_eq!(entry.interval_ms, 10_000);
    assert_eq!(entry.status, Some(MonitorStatus::Stale));
    assert_eq!(entry.error, None);
}

#[test]
fn transitions_on_an_unknown_key_are_no_ops() {
    let store = SystemMonitorStore::new();
    // None of these should panic or create an entry.
    store.opened("ghost");
    store.stats("ghost", sample("x", 1.0));
    store.set_status("ghost", MonitorStatus::Live);
    store.set_paused("ghost", true);
    store.set_interval("ghost", 1000);
    store.clear_error("ghost");
    store.close("ghost");
    assert!(store.get("ghost").is_none());
    // `stats` still records the cache even without an entry (matches the
    // frontend cache write).
    assert!(store.cached_stats("ghost").is_some());
}
