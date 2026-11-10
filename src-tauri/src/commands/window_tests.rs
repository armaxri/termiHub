//! Tests for the multi-window command handshakes (#5168).
//!
//! The commands' logic runs over a recording [`WindowEventSink`] that also
//! snapshots the ownership map at each event, so the tests pin both *which*
//! events fire and that the state change is visible *before* the event.

use std::cell::RefCell;

use serde_json::json;

use super::{
    cancel_quit_for, claim_session_for, release_session_for, report_window_layout_for,
    report_window_tab_count_for, send_handoff_to_window_for,
};
use crate::window::events::WindowEventSink;
use crate::window::quit::{BeginOutcome, QuitCoordinator};
use crate::window::{HandoffRecord, OwnershipSupersededPayload, WindowManager};

/// Records each event with the owner of `s1` at the moment it fired.
struct RecordingSink<'a> {
    manager: &'a WindowManager,
    events: RefCell<Vec<(String, Option<String>)>>,
    fail: bool,
}

impl<'a> RecordingSink<'a> {
    fn new(manager: &'a WindowManager) -> Self {
        Self {
            manager,
            events: RefCell::new(Vec::new()),
            fail: false,
        }
    }

    fn failing(manager: &'a WindowManager) -> Self {
        Self {
            fail: true,
            ..Self::new(manager)
        }
    }

    fn record(&self, event: String) -> Result<(), String> {
        self.events
            .borrow_mut()
            .push((event, self.manager.owner_of("s1")));
        if self.fail {
            Err("emit failed".to_string())
        } else {
            Ok(())
        }
    }

    fn names(&self) -> Vec<String> {
        self.events
            .borrow()
            .iter()
            .map(|(n, _)| n.clone())
            .collect()
    }
}

impl WindowEventSink for RecordingSink<'_> {
    fn windows_changed(&self) -> Result<(), String> {
        self.record("windows-changed".into())
    }
    fn session_ownership_changed(&self) -> Result<(), String> {
        self.record("session-ownership-changed".into())
    }
    fn session_ownership_superseded(
        &self,
        target: &str,
        payload: OwnershipSupersededPayload,
    ) -> Result<(), String> {
        self.record(format!(
            "session-ownership-superseded->{target}:{}:{}",
            payload.session_id, payload.new_owner
        ))
    }
    fn window_handoff(&self) -> Result<(), String> {
        self.record("window-handoff".into())
    }
    fn window_layout_changed(&self) -> Result<(), String> {
        self.record("window-layout-changed".into())
    }
    fn quit_cancelled(&self) -> Result<(), String> {
        self.record("app-quit-cancelled".into())
    }
}

#[test]
fn a_first_claim_updates_the_map_before_notifying_and_supersedes_nobody() {
    let wm = WindowManager::new();
    let sink = RecordingSink::new(&wm);

    assert_eq!(claim_session_for(&wm, &sink, "s1", "main"), None);

    assert_eq!(
        *sink.events.borrow(),
        vec![(
            "session-ownership-changed".to_string(),
            Some("main".to_string())
        )]
    );
}

#[test]
fn a_takeover_notifies_everyone_then_tells_only_the_evicted_window() {
    let wm = WindowManager::new();
    claim_session_for(&wm, &RecordingSink::new(&wm), "s1", "main");
    let sink = RecordingSink::new(&wm);

    assert_eq!(
        claim_session_for(&wm, &sink, "s1", "win-1"),
        Some("main".to_string())
    );

    // Both events fire after the map already names the new owner.
    assert_eq!(
        *sink.events.borrow(),
        vec![
            (
                "session-ownership-changed".to_string(),
                Some("win-1".to_string())
            ),
            (
                "session-ownership-superseded->main:s1:win-1".to_string(),
                Some("win-1".to_string())
            ),
        ]
    );
    assert!(!wm.may_resize("s1", "main"));
    assert!(wm.may_resize("s1", "win-1"));
}

#[test]
fn a_reclaim_by_the_same_window_supersedes_nobody() {
    let wm = WindowManager::new();
    claim_session_for(&wm, &RecordingSink::new(&wm), "s1", "main");
    let sink = RecordingSink::new(&wm);

    assert_eq!(
        claim_session_for(&wm, &sink, "s1", "main"),
        Some("main".to_string())
    );
    assert_eq!(sink.names(), vec!["session-ownership-changed"]);
}

#[test]
fn a_failed_emit_never_undoes_the_claim() {
    let wm = WindowManager::new();
    claim_session_for(&wm, &RecordingSink::new(&wm), "s1", "main");
    let sink = RecordingSink::failing(&wm);

    assert_eq!(
        claim_session_for(&wm, &sink, "s1", "win-1"),
        Some("main".to_string())
    );
    // Both notifications were still attempted, and the claim stands.
    assert_eq!(sink.names().len(), 2);
    assert_eq!(wm.owner_of("s1"), Some("win-1".to_string()));
}

#[test]
fn the_owner_releasing_notifies_after_the_entry_is_gone() {
    let wm = WindowManager::new();
    claim_session_for(&wm, &RecordingSink::new(&wm), "s1", "main");
    let sink = RecordingSink::new(&wm);

    assert!(release_session_for(&wm, &sink, "s1", "main"));
    assert_eq!(
        *sink.events.borrow(),
        vec![("session-ownership-changed".to_string(), None)]
    );
}

#[test]
fn a_non_owner_release_is_a_silent_no_op() {
    let wm = WindowManager::new();
    claim_session_for(&wm, &RecordingSink::new(&wm), "s1", "main");
    let sink = RecordingSink::new(&wm);

    assert!(!release_session_for(&wm, &sink, "s1", "win-1"));
    assert!(!release_session_for(&wm, &sink, "unknown", "main"));
    assert!(sink.names().is_empty());
    assert_eq!(wm.owner_of("s1"), Some("main".to_string()));
}

#[test]
fn a_handoff_is_queued_before_the_nudge_and_drains_only_for_its_target() {
    let wm = WindowManager::new();
    let sink = RecordingSink::new(&wm);
    let record = HandoffRecord {
        tab: json!({"title": "moved"}),
    };

    send_handoff_to_window_for(&wm, &sink, "win-2", record).unwrap();

    assert_eq!(sink.names(), vec!["window-handoff"]);
    assert!(wm.take_handoffs("main").is_empty());
    let drained = wm.take_handoffs("win-2");
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].tab, json!({"title": "moved"}));
    assert!(wm.take_handoffs("win-2").is_empty(), "the drain clears it");
}

#[test]
fn a_failed_handoff_nudge_is_reported_but_the_record_stays_queued() {
    let wm = WindowManager::new();
    let sink = RecordingSink::failing(&wm);
    let record = HandoffRecord { tab: json!({}) };

    assert!(send_handoff_to_window_for(&wm, &sink, "win-2", record).is_err());
    // The target drains it on its next boot / nudge.
    assert_eq!(wm.take_handoffs("win-2").len(), 1);
}

#[test]
fn a_tab_count_report_is_recorded_then_nudges() {
    let wm = WindowManager::new();
    let sink = RecordingSink::new(&wm);

    report_window_tab_count_for(&wm, &sink, "win-1", 3).unwrap();

    assert_eq!(wm.tab_count_of("win-1"), Some(3));
    assert_eq!(sink.names(), vec!["windows-changed"]);
    assert!(report_window_tab_count_for(&wm, &RecordingSink::failing(&wm), "win-1", 4).is_err());
    assert_eq!(wm.tab_count_of("win-1"), Some(4));
}

#[test]
fn only_a_changed_secondary_layout_nudges() {
    let wm = WindowManager::new();
    let sink = RecordingSink::new(&wm);
    let groups = json!([{"tabs": []}]);

    // The main window never nudges itself (no re-save loop).
    report_window_layout_for(&wm, &sink, "main", groups.clone(), 0).unwrap();
    assert!(sink.names().is_empty());

    report_window_layout_for(&wm, &sink, "win-1", groups.clone(), 0).unwrap();
    assert_eq!(sink.names(), vec!["window-layout-changed"]);

    // An unchanged report is quiet.
    report_window_layout_for(&wm, &sink, "win-1", groups, 0).unwrap();
    assert_eq!(sink.names(), vec!["window-layout-changed"]);
}

#[test]
fn cancelling_a_pending_quit_emits_quit_cancelled_once() {
    let wm = WindowManager::new();
    let sink = RecordingSink::new(&wm);
    let quit = QuitCoordinator::new();
    assert!(matches!(
        quit.begin(["main".to_string(), "win-1".to_string()]),
        BeginOutcome::Started { .. }
    ));

    assert!(cancel_quit_for(&quit, &sink));
    assert_eq!(sink.names(), vec!["app-quit-cancelled"]);

    // A second cancel (another window's dialog) has nothing left to cancel.
    assert!(!cancel_quit_for(&quit, &sink));
    assert_eq!(sink.names(), vec!["app-quit-cancelled"]);
}

#[test]
fn cancelling_with_no_quit_pending_is_silent() {
    let wm = WindowManager::new();
    let sink = RecordingSink::new(&wm);

    assert!(!cancel_quit_for(&QuitCoordinator::new(), &sink));
    assert!(sink.names().is_empty());
}
