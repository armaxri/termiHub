//! State-machine unit tests for the shadow [`SessionLifecycleStore`] (#2152).
//!
//! Drives the store directly (no projector) to pin the connect / reconnect /
//! disconnect / error transitions, including the composed ported #2144 backoff
//! engine. A deterministic jitter source (`rand() == 0.5` → zero swing) makes the
//! backoff delays exact: attempt 1 → 1000 ms, attempt 2 → 2000 ms, ….

use super::*;
use termihub_core::reconnect_backoff::ReconnectPhase;

/// A store whose jitter source always returns 0.5, so the symmetric jitter swing
/// is exactly 0 and each backoff delay equals its uncapped base.
fn deterministic_store() -> SessionLifecycleStore {
    let store = SessionLifecycleStore::new();
    store.set_rand_for_test(Box::new(|| 0.5));
    store
}

#[test]
fn connect_enters_connecting_with_an_idle_loop() {
    let store = deterministic_store();
    store.connect("s1");
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Connecting);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
    assert_eq!(s.end_reason, None);
    assert_eq!(s.error, None);
}

#[test]
fn connected_settles_live_and_clears_error() {
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Connected);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
    assert_eq!(s.error, None);
    assert_eq!(s.end_reason, None);
}

#[test]
fn connect_failed_is_terminal_with_the_message() {
    let store = deterministic_store();
    store.connect("s1");
    store.connect_failed("s1", Some("auth denied".to_string()));
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Failed);
    assert_eq!(s.end_reason, Some(EndReason::Error));
    assert_eq!(s.error.as_deref(), Some("auth denied"));
}

#[test]
fn user_disconnect_lands_idle_with_reason_user() {
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.disconnect("s1");
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Disconnected);
    assert_eq!(s.end_reason, Some(EndReason::User));
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
}

#[test]
fn unexpected_drop_lands_idle_with_reason_unexpected_and_no_loop() {
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.dropped("s1", Some("connection reset".to_string()));
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Disconnected);
    assert_eq!(s.end_reason, Some(EndReason::Unexpected));
    assert_eq!(s.error.as_deref(), Some("connection reset"));
    // A drop does not arm the loop on its own — that is an opt-in reconnect.
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
}

#[test]
fn reconnect_arms_the_first_backoff_window() {
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.reconnect("s1");
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Reconnecting);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Waiting);
    assert_eq!(s.reconnect.attempt, 0, "no attempt started yet");
    assert_eq!(s.reconnect.delay_ms, 1_000, "first window = base delay");
}

#[test]
fn a_successful_reconnect_attempt_settles_live_and_resets_the_loop() {
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.reconnect("s1"); // waiting, delay 1000
    store.reconnect_attempt("s1"); // connecting, attempt 1
    let mid = store.get("s1").unwrap();
    assert_eq!(mid.status, SessionStatus::Reconnecting);
    assert_eq!(mid.reconnect.phase, ReconnectPhase::Connecting);
    assert_eq!(mid.reconnect.attempt, 1);

    store.connected("s1"); // success
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Connected);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Connected);
    assert_eq!(s.reconnect.attempt, 0, "attempt counter reset on success");
}

#[test]
fn a_failed_attempt_backs_off_to_the_next_window() {
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.reconnect("s1"); // waiting, delay 1000
    store.reconnect_attempt("s1"); // connecting, attempt 1
    store.reconnect_failed("s1", None); // back off to attempt 2's window
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Reconnecting);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Waiting);
    assert_eq!(s.reconnect.attempt, 1, "one attempt used so far");
    assert_eq!(s.reconnect.delay_ms, 2_000, "next window doubled");
}

#[test]
fn the_loop_gives_up_after_the_attempt_budget_and_lands_failed() {
    // DEFAULT_BACKOFF.maxAttempts == 10: give up on the 10th failure.
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.reconnect("s1");
    for _ in 0..9 {
        store.reconnect_attempt("s1");
        store.reconnect_failed("s1", None);
        assert_eq!(
            store.get("s1").unwrap().status,
            SessionStatus::Reconnecting,
            "still retrying within budget"
        );
    }
    // 10th attempt and failure exhausts the budget.
    store.reconnect_attempt("s1");
    store.reconnect_failed("s1", Some("host unreachable".to_string()));
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Failed);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Gaveup);
    assert_eq!(s.reconnect.attempt, 10);
    assert_eq!(s.end_reason, Some(EndReason::Error));
    assert_eq!(s.error.as_deref(), Some("host unreachable"));
}

#[test]
fn cancel_stops_the_loop_and_returns_to_idle_disconnected() {
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.reconnect("s1");
    store.reconnect_attempt("s1");
    store.cancel_reconnect("s1");
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Disconnected);
    assert_eq!(s.end_reason, Some(EndReason::User));
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
}

#[test]
fn remove_drops_the_session_from_the_region() {
    let store = deterministic_store();
    store.connect("s1");
    store.remove("s1");
    assert_eq!(store.get("s1"), None);
    // Idempotent: removing an unknown session is fine.
    store.remove("s1");
}

#[test]
fn snapshot_shape_maps_session_ids_to_lifecycles() {
    let store = deterministic_store();
    store.connect("s1");
    store.connect("s2");
    store.connected("s2");
    let view = store.snapshot();
    assert_eq!(view["sessions"]["s1"]["status"], serde_json::json!("connecting"));
    assert_eq!(view["sessions"]["s2"]["status"], serde_json::json!("connected"));
    // Reconnect detail is always present; optional fields are omitted when unset.
    assert_eq!(view["sessions"]["s1"]["reconnect"]["phase"], serde_json::json!("idle"));
    assert!(view["sessions"]["s1"].get("error").is_none());
}

#[test]
fn status_and_reconnect_phase_stay_consistent_through_a_full_loop() {
    // Invariant: whenever a loop is actively trying, status is Reconnecting; when
    // it settles or is torn down, the two agree (Connected/Failed/Disconnected).
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.reconnect("s1");
    store.reconnect_attempt("s1");
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Reconnecting);
    assert!(matches!(
        s.reconnect.phase,
        ReconnectPhase::Waiting | ReconnectPhase::Connecting
    ));
    store.connected("s1");
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Connected);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Connected);
}
