//! Store tests for mirroring an agent-side reconnect loop (#5396).

use termihub_core::protocol::methods::SessionReconnectStatus;
use termihub_core::reconnect_backoff::{ReconnectPhase, ReconnectState};

use super::super::{
    EndReason, SessionLifecycleStore, SessionStatus, TerminalExit, TerminalExitReason,
};

const TAB: &str = "tab-1";

/// A store with `TAB` connected to backend session `sid-1`.
fn connected_store() -> SessionLifecycleStore {
    let store = SessionLifecycleStore::new();
    store.set_rand_for_test(Box::new(|| 0.0));
    store.connect(TAB);
    store.connected(TAB);
    store.set_backend_session_id(TAB, Some("sid-1".into()));
    store
}

fn waiting(attempt: i64, delay_ms: i64, reason: &str) -> SessionReconnectStatus {
    SessionReconnectStatus::Waiting {
        attempt,
        delay_ms,
        reason: Some(reason.into()),
    }
}

fn connecting(attempt: i64) -> SessionReconnectStatus {
    SessionReconnectStatus::Connecting {
        attempt,
        reason: None,
    }
}

#[test]
fn waiting_and_connecting_show_on_the_tab_and_keep_the_session() {
    let store = connected_store();
    assert!(store.agent_session_reconnect(TAB, 1, &waiting(0, 1000, "unplugged")));
    let entry = store.get(TAB).unwrap();
    assert_eq!(entry.status, SessionStatus::Reconnecting);
    assert_eq!(
        entry.reconnect,
        ReconnectState {
            phase: ReconnectPhase::Waiting,
            attempt: 0,
            delay_ms: 1000,
        }
    );
    assert_eq!(entry.reconnect_error.as_deref(), Some("unplugged"));
    assert_eq!(
        entry.backend_session_id.as_deref(),
        Some("sid-1"),
        "the agent session lives on"
    );
    assert!(store.agent_owns_reconnect(TAB));
    assert_eq!(store.agent_reconnect_session(TAB).as_deref(), Some("sid-1"));

    assert!(store.agent_session_reconnect(TAB, 2, &connecting(1)));
    let entry = store.get(TAB).unwrap();
    assert_eq!(entry.reconnect.phase, ReconnectPhase::Connecting);
    assert_eq!(entry.reconnect.attempt, 1);
}

#[test]
fn reconnected_settles_the_tab_live() {
    let store = connected_store();
    store.agent_session_reconnect(TAB, 1, &waiting(0, 1000, "unplugged"));
    store.agent_session_reconnect(TAB, 2, &connecting(1));
    assert!(store.agent_session_reconnect(TAB, 3, &SessionReconnectStatus::Reconnected));
    let entry = store.get(TAB).unwrap();
    assert_eq!(entry.status, SessionStatus::Connected);
    assert_eq!(entry.reconnect.phase, ReconnectPhase::Idle);
    assert_eq!(entry.reconnect_error, None);
    assert_eq!(entry.backend_session_id.as_deref(), Some("sid-1"));
    assert!(!store.agent_owns_reconnect(TAB));
}

#[test]
fn a_late_or_replayed_step_never_undoes_a_newer_one() {
    let store = connected_store();
    store.agent_session_reconnect(TAB, 2, &connecting(1));
    store.agent_session_reconnect(TAB, 3, &SessionReconnectStatus::Reconnected);
    // The connecting step folded on another task arrives after the reopen.
    assert!(!store.agent_session_reconnect(TAB, 2, &connecting(1)));
    assert!(!store.agent_session_reconnect(TAB, 1, &waiting(0, 1000, "x")));
    assert_eq!(store.status(TAB), Some(SessionStatus::Connected));
}

#[test]
fn a_give_up_is_failed_and_survives_the_exit_that_follows() {
    let store = connected_store();
    store.agent_session_reconnect(TAB, 1, &waiting(0, 1000, "unplugged"));
    let gave_up = SessionReconnectStatus::GaveUp {
        reason: Some("Serial port /dev/ttyUSB0 is not present.".into()),
    };
    assert!(store.agent_session_reconnect(TAB, 2, &gave_up));
    let entry = store.get(TAB).unwrap();
    assert_eq!(entry.status, SessionStatus::Failed);
    assert_eq!(entry.end_reason, Some(EndReason::Error));
    assert_eq!(
        entry.error.as_deref(),
        Some("Serial port /dev/ttyUSB0 is not present.")
    );

    // The agent ends the session right after with a clean exit, then the
    // hosted session's output closes: the give-up stays the tab's ending.
    store.set_exit(
        TAB,
        Some(TerminalExit {
            reason: TerminalExitReason::Clean,
            code: Some(0),
        }),
    );
    store.dropped(TAB, None);
    store.reconnect(TAB);
    assert_eq!(store.status(TAB), Some(SessionStatus::Failed));
    assert_eq!(
        store.get(TAB).unwrap().error.as_deref(),
        Some("Serial port /dev/ttyUSB0 is not present.")
    );
}

#[test]
fn stop_ends_the_agent_loop_and_late_steps_do_not_revive_it() {
    let store = connected_store();
    store.agent_session_reconnect(TAB, 1, &waiting(0, 1000, "unplugged"));
    let to_close = store.agent_reconnect_session(TAB);
    store.cancel_reconnect(TAB);
    assert_eq!(to_close.as_deref(), Some("sid-1"));
    assert_eq!(store.status(TAB), Some(SessionStatus::Disconnected));
    assert!(!store.agent_owns_reconnect(TAB));
    // A step already in flight when the user stopped changes nothing.
    assert!(!store.agent_session_reconnect(TAB, 2, &connecting(1)));
    assert!(!store.agent_session_reconnect(TAB, 3, &SessionReconnectStatus::Reconnected));
    assert_eq!(store.status(TAB), Some(SessionStatus::Disconnected));
}

#[test]
fn a_desktop_loop_is_not_an_agent_loop() {
    // An agent that never sends steps (older than 0.37.0) leaves the tab on
    // the desktop's own loop, as before.
    let store = connected_store();
    store.reconnect(TAB);
    assert_eq!(store.status(TAB), Some(SessionStatus::Reconnecting));
    assert!(!store.agent_owns_reconnect(TAB));
    assert_eq!(store.agent_reconnect_session(TAB), None);

    // And the desktop's loop taking over clears a mirrored agent loop.
    let store = connected_store();
    store.agent_session_reconnect(TAB, 1, &waiting(0, 1000, "unplugged"));
    store.reconnect(TAB);
    assert!(!store.agent_owns_reconnect(TAB));
}

#[test]
fn ended_evicted_and_unknown_tabs_are_left_alone() {
    let store = connected_store();
    store.disconnect(TAB);
    assert!(!store.agent_session_reconnect(TAB, 1, &waiting(0, 1000, "x")));
    assert_eq!(store.status(TAB), Some(SessionStatus::Disconnected));

    let store = connected_store();
    store.evicted(TAB, None);
    assert!(!store.agent_session_reconnect(TAB, 1, &waiting(0, 1000, "x")));
    assert_eq!(store.status(TAB), Some(SessionStatus::Evicted));

    let store = connected_store();
    assert!(!store.agent_session_reconnect("nope", 1, &waiting(0, 1000, "x")));
    assert!(store.get("nope").is_none());
}

#[test]
fn a_new_backend_session_numbers_its_steps_afresh() {
    let store = connected_store();
    store.agent_session_reconnect(TAB, 7, &waiting(0, 1000, "x"));
    store.agent_session_reconnect(TAB, 8, &SessionReconnectStatus::Reconnected);
    store.set_backend_session_id(TAB, Some("sid-2".into()));
    assert!(store.agent_session_reconnect(TAB, 1, &waiting(0, 1000, "again")));
}
