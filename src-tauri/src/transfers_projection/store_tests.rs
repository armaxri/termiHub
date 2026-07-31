//! Unit tests for the shadow [`TransferStore`] transitions and folds (#2229).
//!
//! Drives the store directly and asserts on the typed [`TransferEntry`] records,
//! covering the `queued → active → completed | failed | cancelled` lifecycle, the
//! derived percent/throughput folds (mirroring `src/types/transfer.ts`), the
//! reconcile backstop, and the whole-slice `replace` mirror.

use std::collections::HashMap;

use serde_json::json;

use super::{
    TransferDirection, TransferProgress, TransferQueueState, TransferSeed, TransferSnapshot,
    TransferStore,
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

fn seed(id: &str) -> TransferSeed {
    TransferSeed {
        id: id.to_string(),
        session_id: "sess-1".to_string(),
        direction: TransferDirection::Download,
        name: "data.csv".to_string(),
        path: Some("/remote/data.csv".to_string()),
        total_bytes: Some(1000),
    }
}

/// A `transfer-progress` event using the rich #1336 fields.
fn progress(id: &str, state: TransferQueueState, transferred: u64) -> TransferProgress {
    TransferProgress {
        transfer_id: id.to_string(),
        session_id: "sess-1".to_string(),
        direction: TransferDirection::Download,
        file_name: "data.csv".to_string(),
        path: Some("/remote/data.csv".to_string()),
        transferred,
        total: 1000,
        phase: super::TransferPhase::Transferring,
        message: None,
        state: Some(state),
        speed: None,
        total_bytes: Some(1000),
        attempt: None,
        max_attempts: None,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn a_fresh_store_snapshots_empty() {
    let store = TransferStore::new();
    assert_eq!(store.snapshot(), json!({ "queue": {}, "minimized": false }));
}

#[test]
fn seed_creates_a_queued_row() {
    let store = TransferStore::new();
    store.seed(&seed("t1"), 1_000);

    let entry = store.get("t1").expect("row exists");
    assert_eq!(entry.state, TransferQueueState::Queued);
    assert_eq!(entry.transferred, 0);
    assert_eq!(entry.total_bytes, Some(1000));
    assert_eq!(entry.percent, None);
    assert_eq!(entry.speed_bytes_per_sec, None);
    assert_eq!(entry.path.as_deref(), Some("/remote/data.csv"));
    assert_eq!(entry.updated_at, 1_000);
}

#[test]
fn seed_is_idempotent_and_never_overwrites_an_advanced_row() {
    let store = TransferStore::new();
    store.seed(&seed("t1"), 1_000);
    store.progress(&progress("t1", TransferQueueState::Active, 500), 2_000);

    // A late seed for the same id must not clobber the active row back to queued.
    store.seed(&seed("t1"), 3_000);
    let entry = store.get("t1").unwrap();
    assert_eq!(entry.state, TransferQueueState::Active);
    assert_eq!(entry.transferred, 500);
}

#[test]
fn progress_upserts_and_derives_percent() {
    let store = TransferStore::new();
    store.progress(&progress("t1", TransferQueueState::Active, 250), 1_000);

    let entry = store.get("t1").unwrap();
    assert_eq!(entry.state, TransferQueueState::Active);
    assert_eq!(entry.percent, Some(25));
    assert_eq!(entry.total_bytes, Some(1000));
}

#[test]
fn progress_derives_throughput_from_the_byte_time_delta() {
    let store = TransferStore::new();
    // First active sample at t=1000ms, 100 bytes.
    store.progress(&progress("t1", TransferQueueState::Active, 100), 1_000);
    // Second at t=2000ms, 1100 bytes → 1000 bytes / 1000 ms = 1000 B/s.
    let mut p = progress("t1", TransferQueueState::Active, 1_100);
    p.total = 4000;
    p.total_bytes = Some(4000);
    store.progress(&p, 2_000);

    let entry = store.get("t1").unwrap();
    assert_eq!(entry.speed_bytes_per_sec, Some(1000));
}

#[test]
fn progress_prefers_backend_measured_speed() {
    let store = TransferStore::new();
    let mut p = progress("t1", TransferQueueState::Active, 500);
    p.speed = Some(4242);
    store.progress(&p, 1_000);

    assert_eq!(store.get("t1").unwrap().speed_bytes_per_sec, Some(4242));
}

#[test]
fn completed_forces_percent_100_and_clears_speed() {
    let store = TransferStore::new();
    store.progress(&progress("t1", TransferQueueState::Active, 900), 1_000);
    store.progress(&progress("t1", TransferQueueState::Completed, 1_000), 2_000);

    let entry = store.get("t1").unwrap();
    assert_eq!(entry.state, TransferQueueState::Completed);
    assert_eq!(entry.percent, Some(100));
    assert_eq!(entry.speed_bytes_per_sec, None);
}

#[test]
fn failed_records_the_error_message() {
    let store = TransferStore::new();
    let mut p = progress("t1", TransferQueueState::Failed, 300);
    p.message = Some("connection reset".to_string());
    store.progress(&p, 1_000);

    let entry = store.get("t1").unwrap();
    assert_eq!(entry.state, TransferQueueState::Failed);
    assert_eq!(entry.error.as_deref(), Some("connection reset"));
}

#[test]
fn failed_without_a_message_uses_the_default() {
    let store = TransferStore::new();
    store.progress(&progress("t1", TransferQueueState::Failed, 300), 1_000);
    assert_eq!(
        store.get("t1").unwrap().error.as_deref(),
        Some("Transfer failed")
    );
}

#[test]
fn legacy_phase_drives_state_when_rich_state_is_absent() {
    let store = TransferStore::new();
    let mut p = progress("t1", TransferQueueState::Active, 400);
    p.state = None;
    p.phase = super::TransferPhase::Done;
    store.progress(&p, 1_000);

    let entry = store.get("t1").unwrap();
    assert_eq!(entry.state, TransferQueueState::Completed);
    assert_eq!(entry.percent, Some(100));
}

#[test]
fn progress_carries_retry_counters_and_preserves_them_across_events() {
    let store = TransferStore::new();
    let mut p = progress("t1", TransferQueueState::Active, 200);
    p.attempt = Some(2);
    p.max_attempts = Some(5);
    store.progress(&p, 1_000);

    // A later event that omits the counters keeps the previous values.
    store.progress(&progress("t1", TransferQueueState::Active, 600), 2_000);
    let entry = store.get("t1").unwrap();
    assert_eq!(entry.attempt, Some(2));
    assert_eq!(entry.max_attempts, Some(5));
}

#[test]
fn indeterminate_total_yields_null_percent() {
    let store = TransferStore::new();
    let mut p = progress("t1", TransferQueueState::Active, 500);
    p.total = 0;
    p.total_bytes = None;
    store.progress(&p, 1_000);

    let entry = store.get("t1").unwrap();
    assert_eq!(entry.total_bytes, None);
    assert_eq!(entry.percent, None);
}

#[test]
fn remove_drops_a_row_and_is_idempotent() {
    let store = TransferStore::new();
    store.seed(&seed("t1"), 1_000);
    store.remove("t1");
    assert!(store.get("t1").is_none());
    store.remove("t1"); // no panic on an absent id
    store.remove("ghost");
}

#[test]
fn clear_completed_drops_only_completed_rows() {
    let store = TransferStore::new();
    store.progress(
        &progress("done", TransferQueueState::Completed, 1_000),
        1_000,
    );
    store.progress(&progress("fail", TransferQueueState::Failed, 300), 1_000);
    store.progress(&progress("live", TransferQueueState::Active, 500), 1_000);

    store.clear_completed();
    assert!(store.get("done").is_none(), "completed dropped");
    assert!(store.get("fail").is_some(), "failed retained");
    assert!(store.get("live").is_some(), "active retained");
}

#[test]
fn set_minimized_toggles_the_panel_flag() {
    let store = TransferStore::new();
    assert_eq!(store.snapshot()["minimized"], json!(false));
    store.set_minimized(true);
    assert_eq!(store.snapshot()["minimized"], json!(true));
    store.set_minimized(false);
    assert_eq!(store.snapshot()["minimized"], json!(false));
}

fn snapshot_of(id: &str, state: TransferQueueState, settled: bool) -> TransferSnapshot {
    TransferSnapshot {
        transfer_id: id.to_string(),
        session_id: "sess-1".to_string(),
        direction: TransferDirection::Download,
        file_name: "data.csv".to_string(),
        path: None,
        state,
        settled,
        transferred: 1_000,
        total: 1_000,
        speed: 0,
        attempt: 0,
        max_attempts: 0,
    }
}

#[test]
fn reconcile_settles_a_stuck_row_from_a_settled_terminal_snapshot() {
    let store = TransferStore::new();
    // A row stuck `active` because its terminal event was dropped.
    store.progress(&progress("t1", TransferQueueState::Active, 1_000), 1_000);

    store.reconcile(
        &[snapshot_of("t1", TransferQueueState::Completed, true)],
        2_000,
    );
    assert_eq!(
        store.get("t1").unwrap().state,
        TransferQueueState::Completed
    );
}

#[test]
fn reconcile_ignores_unsettled_and_non_terminal_and_missing_rows() {
    let store = TransferStore::new();
    store.progress(&progress("t1", TransferQueueState::Active, 1_000), 1_000);

    // Unsettled terminal snapshot (mid auto-retry) must not settle the row.
    store.reconcile(
        &[snapshot_of("t1", TransferQueueState::Failed, false)],
        2_000,
    );
    assert_eq!(store.get("t1").unwrap().state, TransferQueueState::Active);

    // A snapshot for a row the user already removed must not resurrect it.
    store.reconcile(
        &[snapshot_of("ghost", TransferQueueState::Completed, true)],
        2_000,
    );
    assert!(store.get("ghost").is_none());
}

#[test]
fn reconcile_never_regresses_an_already_terminal_row() {
    let store = TransferStore::new();
    store.progress(&progress("t1", TransferQueueState::Completed, 1_000), 1_000);
    store.reconcile(
        &[snapshot_of("t1", TransferQueueState::Failed, true)],
        2_000,
    );
    // Already terminal → untouched.
    assert_eq!(
        store.get("t1").unwrap().state,
        TransferQueueState::Completed
    );
}

#[test]
fn replace_overwrites_the_whole_slice() {
    let store = TransferStore::new();
    store.seed(&seed("old"), 1_000);
    store.set_minimized(false);

    // Build a mirror snapshot by driving a second store, then hand its rows back.
    let source = TransferStore::new();
    source.progress(&progress("t1", TransferQueueState::Active, 400), 5_000);
    let view = source.snapshot();
    let queue: HashMap<String, super::TransferEntry> =
        serde_json::from_value(view["queue"].clone()).unwrap();

    store.replace(queue, true);
    assert!(store.get("old").is_none(), "prior rows dropped");
    assert_eq!(store.get("t1").unwrap().state, TransferQueueState::Active);
    assert_eq!(store.snapshot(), source_snapshot_minimized(&source));
}

/// The source snapshot with `minimized: true`, for comparison against a
/// `replace(_, true)`.
fn source_snapshot_minimized(source: &TransferStore) -> serde_json::Value {
    let mut view = source.snapshot();
    view["minimized"] = json!(true);
    view
}

#[test]
fn replace_with_an_empty_map_clears_everything() {
    let store = TransferStore::new();
    store.seed(&seed("t1"), 1_000);
    store.replace(HashMap::new(), false);
    assert_eq!(store.len(), 0);
    assert_eq!(store.snapshot(), json!({ "queue": {}, "minimized": false }));
}

#[test]
fn entry_json_omits_absent_optional_fields_but_keeps_nullable_ones() {
    // Parity with the frontend `TransferEntry` JSON: `path`/`error`/`attempt`/
    // `maxAttempts` are omitted when absent, while `totalBytes`/`percent`/
    // `speedBytesPerSec` serialize as `null`.
    let store = TransferStore::new();
    let mut p = progress("t1", TransferQueueState::Active, 500);
    p.path = None;
    p.total = 0;
    p.total_bytes = None;
    store.progress(&p, 1_000);

    let row = &store.snapshot()["queue"]["t1"];
    assert!(row.get("error").is_none(), "error omitted when absent");
    assert!(row.get("attempt").is_none(), "attempt omitted when absent");
    assert!(row.get("path").is_none(), "path omitted when absent");
    assert_eq!(
        row["totalBytes"],
        json!(null),
        "nullable field present as null"
    );
    assert_eq!(row["percent"], json!(null));
    assert_eq!(row["speedBytesPerSec"], json!(null));
}
