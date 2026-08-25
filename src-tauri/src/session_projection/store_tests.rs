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
    assert_eq!(
        view["sessions"]["s1"]["status"],
        serde_json::json!("connecting")
    );
    assert_eq!(
        view["sessions"]["s2"]["status"],
        serde_json::json!("connected")
    );
    // Reconnect detail is always present; optional fields are omitted when unset.
    assert_eq!(
        view["sessions"]["s1"]["reconnect"]["phase"],
        serde_json::json!("idle")
    );
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

#[test]
fn set_reconnect_trigger_records_and_clears_the_cause() {
    // #2442: the reconnect-trigger cause is region-owned, set/cleared by its own
    // pure-metadata write without perturbing status or the reconnect engine.
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.set_reconnect_trigger("s1", Some("connection reset".to_string()));
    let s = store.get("s1").unwrap();
    assert_eq!(s.reconnect_error.as_deref(), Some("connection reset"));
    // Status / reconnect detail untouched — this is not the agentless backoff loop.
    assert_eq!(s.status, SessionStatus::Connected);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
    // A None clears it.
    store.set_reconnect_trigger("s1", None);
    assert_eq!(store.get("s1").unwrap().reconnect_error, None);
}

#[test]
fn set_reconnect_trigger_is_a_no_op_for_an_unknown_session() {
    let store = deterministic_store();
    store.set_reconnect_trigger("ghost", Some("boom".to_string()));
    assert!(store.get("ghost").is_none());
}

#[test]
fn lifecycle_resolutions_clear_the_reconnect_trigger_cause() {
    // Any resolution transition clears reconnect_error so a stale cause never
    // lingers into the next connect cycle (the guarantee #2205 PR-B relies on).
    for resolve in [
        SessionLifecycleStore::connected as fn(&SessionLifecycleStore, &str),
        SessionLifecycleStore::disconnect,
    ] {
        let store = deterministic_store();
        store.connect("s1");
        store.connected("s1");
        store.set_reconnect_trigger("s1", Some("cause".to_string()));
        resolve(&store, "s1");
        assert_eq!(store.get("s1").unwrap().reconnect_error, None);
    }
    // dropped / connect_failed carry their own message into `error`, not `reconnect_error`.
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.set_reconnect_trigger("s1", Some("cause".to_string()));
    store.dropped("s1", Some("link lost".to_string()));
    let s = store.get("s1").unwrap();
    assert_eq!(s.reconnect_error, None);
    assert_eq!(s.error.as_deref(), Some("link lost"));
}

#[test]
fn reconnect_trigger_cause_is_serialized_only_when_set() {
    let store = deterministic_store();
    store.connect("s1");
    assert!(store.snapshot()["sessions"]["s1"]
        .get("reconnectError")
        .is_none());
    store.set_reconnect_trigger("s1", Some("why".to_string()));
    assert_eq!(
        store.snapshot()["sessions"]["s1"]["reconnectError"],
        serde_json::json!("why")
    );
}

#[test]
fn set_backend_session_id_records_and_clears_the_id() {
    // #2457: the backend session id is region-owned, set/cleared by its own pure
    // metadata write without perturbing status or the reconnect engine.
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.set_backend_session_id("s1", Some("backend-42".to_string()));
    let s = store.get("s1").unwrap();
    assert_eq!(s.backend_session_id.as_deref(), Some("backend-42"));
    // Status / reconnect detail untouched — this is pure metadata.
    assert_eq!(s.status, SessionStatus::Connected);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
    // A None clears it.
    store.set_backend_session_id("s1", None);
    assert_eq!(store.get("s1").unwrap().backend_session_id, None);
}

#[test]
fn set_backend_session_id_is_a_no_op_for_an_unknown_session() {
    let store = deterministic_store();
    store.set_backend_session_id("ghost", Some("backend-1".to_string()));
    assert!(store.get("ghost").is_none());
}

#[test]
fn backend_session_id_is_serialized_only_when_set() {
    // Twin of the Rust field `backend_session_id`, serialized as `sessionId`.
    let store = deterministic_store();
    store.connect("s1");
    assert!(store.snapshot()["sessions"]["s1"]
        .get("sessionId")
        .is_none());
    store.set_backend_session_id("s1", Some("backend-7".to_string()));
    assert_eq!(
        store.snapshot()["sessions"]["s1"]["sessionId"],
        serde_json::json!("backend-7")
    );
}

#[test]
fn teardown_transitions_clear_the_backend_session_id() {
    // The re-attach id must never outlive the live session it names, so the
    // region never advertises a dead backend session (#2457). Each teardown
    // transition drops it.
    for teardown in [
        SessionLifecycleStore::disconnect as fn(&SessionLifecycleStore, &str),
        SessionLifecycleStore::reconnect,
        SessionLifecycleStore::cancel_reconnect,
    ] {
        let store = deterministic_store();
        store.connect("s1");
        store.connected("s1");
        store.set_backend_session_id("s1", Some("backend-live".to_string()));
        teardown(&store, "s1");
        assert_eq!(
            store.get("s1").unwrap().backend_session_id,
            None,
            "teardown transition should clear the backend session id"
        );
    }
    // dropped / connect_failed take a message arg — exercise them separately.
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.set_backend_session_id("s1", Some("backend-live".to_string()));
    store.dropped("s1", Some("link lost".to_string()));
    assert_eq!(store.get("s1").unwrap().backend_session_id, None);

    let store = deterministic_store();
    store.connect("s2");
    store.set_backend_session_id("s2", Some("backend-live".to_string()));
    store.connect_failed("s2", Some("auth denied".to_string()));
    assert_eq!(store.get("s2").unwrap().backend_session_id, None);
}

#[test]
fn a_fresh_connect_starts_without_a_stale_backend_session_id() {
    // `connect` replaces the whole entry, so a prior id never leaks into a new
    // connect cycle for a reused tab id (#2457).
    let store = deterministic_store();
    store.connect("s1");
    store.connected("s1");
    store.set_backend_session_id("s1", Some("old-backend".to_string()));
    store.connect("s1");
    assert_eq!(store.get("s1").unwrap().backend_session_id, None);
}

#[test]
fn session_lost_enters_the_terminal_session_lost_state() {
    // #2512: when a resilient agent tab re-establishes its transport but the live
    // agent session could not be recovered, `session_lost` folds a distinct
    // terminal state — NOT a reconnect loop, NOT a silent new session. It carries
    // the error, resets the loop to idle, and drops any stale re-attach id.
    let store = deterministic_store();
    store.connect("tab-1");
    store.connected("tab-1");
    store.set_backend_session_id("tab-1", Some("backend-live".to_string()));
    // Arm a reconnect loop, as a real drop would.
    store.reconnect("tab-1");
    assert_eq!(
        store.get("tab-1").unwrap().status,
        SessionStatus::Reconnecting
    );

    store.session_lost(
        "tab-1",
        Some("the live agent session could not be recovered".to_string()),
    );

    let s = store.get("tab-1").unwrap();
    assert_eq!(s.status, SessionStatus::SessionLost);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
    assert_eq!(s.end_reason, Some(EndReason::Unexpected));
    assert_eq!(
        s.error.as_deref(),
        Some("the live agent session could not be recovered")
    );
    assert_eq!(
        s.backend_session_id, None,
        "the lost live session leaves no backend id to re-attach to"
    );
}

#[test]
fn session_lost_serializes_as_session_lost_for_the_frontend() {
    // The frontend keys off the serialized status string; pin it so the renderer
    // and this backend state stay in agreement (#2512).
    let store = deterministic_store();
    store.connect("tab-1");
    store.session_lost("tab-1", Some("gone".to_string()));
    let snapshot = store.snapshot();
    assert_eq!(
        snapshot["sessions"]["tab-1"]["status"],
        serde_json::json!("sessionLost")
    );
}

// ── Agent transient-transport-break reconnecting (#2555) ─────────────────────────

#[test]
fn agent_transport_reconnecting_shows_reconnecting_without_arming_the_loop() {
    // A transient agent-transport break (the in-task `reconnect_agent` case)
    // recovers the hosted session **in place** — no backoff loop runs. So the
    // fold must show `Reconnecting` for the overlay yet keep the reconnect engine
    // **Idle**, so the backend timer driver never arms (it arms only on a
    // `Waiting` phase) and never double-drives the transport the agent I/O task is
    // already re-establishing (#2555).
    let store = deterministic_store();
    store.connect("tab-1");
    store.connected("tab-1");
    store.set_backend_session_id("tab-1", Some("backend-sess-1".to_string()));

    store.agent_transport_reconnecting("tab-1", Some("connection reset".to_string()));

    let s = store.get("tab-1").unwrap();
    assert_eq!(s.status, SessionStatus::Reconnecting);
    assert_eq!(
        s.reconnect.phase,
        ReconnectPhase::Idle,
        "the loop must stay idle so the backend timer never arms (no double-drive)"
    );
    assert_eq!(
        s.reconnect_error.as_deref(),
        Some("connection reset"),
        "the trigger cause is surfaced while reconnecting"
    );
    assert_eq!(
        s.backend_session_id.as_deref(),
        Some("backend-sess-1"),
        "the live session survives the transient break in place — keep the re-attach id"
    );
    assert_eq!(s.end_reason, None);
}

#[test]
fn agent_transport_reconnecting_then_connected_recovers_in_place() {
    // The transport came back and the live agent session survived: fold back to
    // `Connected`, clearing the reconnect-trigger cause and keeping the re-attach
    // id (the same live session resumes output).
    let store = deterministic_store();
    store.connect("tab-1");
    store.connected("tab-1");
    store.set_backend_session_id("tab-1", Some("backend-sess-1".to_string()));
    store.agent_transport_reconnecting("tab-1", Some("connection reset".to_string()));

    store.connected("tab-1");

    let s = store.get("tab-1").unwrap();
    assert_eq!(s.status, SessionStatus::Connected);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
    assert_eq!(
        s.reconnect_error, None,
        "the trigger cause clears on recovery"
    );
    assert_eq!(
        s.backend_session_id.as_deref(),
        Some("backend-sess-1"),
        "the surviving live session keeps its re-attach id"
    );
}

#[test]
fn agent_transport_reconnecting_then_dropped_resolves_off_reconnecting() {
    // The transport came back but the live agent session was gone (recovery
    // failed): the resolver folds the session off `Reconnecting` — the region is
    // never left stuck reconnecting (#2555).
    let store = deterministic_store();
    store.connect("tab-1");
    store.connected("tab-1");
    store.agent_transport_reconnecting("tab-1", Some("connection reset".to_string()));

    store.dropped("tab-1", None);

    let s = store.get("tab-1").unwrap();
    assert_eq!(s.status, SessionStatus::Disconnected);
    assert_eq!(s.end_reason, Some(EndReason::Unexpected));
    assert_eq!(s.reconnect_error, None);
}

#[test]
fn agent_transport_reconnecting_is_a_noop_status_for_an_unknown_session() {
    // Lazily creates the entry (mirrors the other fold methods) so a fold that
    // races ahead of the connect record still lands a coherent reconnecting state.
    let store = deterministic_store();
    store.agent_transport_reconnecting("tab-unknown", None);
    let s = store.get("tab-unknown").unwrap();
    assert_eq!(s.status, SessionStatus::Reconnecting);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Idle);
}
