//! Session → saved-connection bindings (#3876): which saved connection a live
//! session was opened for, so a relaunched transfer can find it again.

use super::*;

fn manager() -> SessionManager {
    SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent))
}

async fn open(manager: &SessionManager, session_id: &str) {
    manager
        .insert_test_session(session_id, Box::new(MockConnection { writes: None }))
        .await;
}

#[tokio::test]
async fn a_bound_session_reports_its_saved_connection() {
    let manager = manager();
    open(&manager, "sess-1").await;
    manager.bind_saved_connection("sess-1", "Work/files").await;

    assert_eq!(
        manager.saved_connection_of("sess-1").as_deref(),
        Some("Work/files")
    );
    assert_eq!(manager.saved_connection_of("sess-2"), None);
    assert_eq!(
        manager.sessions_for_saved_connection("Work/files").await,
        vec!["sess-1".to_string()]
    );
}

/// A session that ended is never offered to a relaunch, and its binding is
/// dropped the next time the bindings are touched.
#[tokio::test]
async fn an_ended_session_is_not_offered_and_its_binding_is_pruned() {
    let manager = manager();
    open(&manager, "sess-old").await;
    manager
        .bind_saved_connection("sess-old", "Work/files")
        .await;
    manager.sessions.lock().await.remove("sess-old");

    open(&manager, "sess-new").await;
    manager
        .bind_saved_connection("sess-new", "Work/files")
        .await;

    assert_eq!(
        manager.sessions_for_saved_connection("Work/files").await,
        vec!["sess-new".to_string()]
    );
    assert_eq!(manager.saved_connection_of("sess-old"), None, "pruned");
}

/// Only sessions of the same saved connection are offered.
#[tokio::test]
async fn sessions_of_other_connections_are_not_offered() {
    let manager = manager();
    open(&manager, "sess-a").await;
    open(&manager, "sess-b").await;
    manager.bind_saved_connection("sess-a", "Work/a").await;
    manager.bind_saved_connection("sess-b", "Work/b").await;

    assert_eq!(
        manager.sessions_for_saved_connection("Work/a").await,
        vec!["sess-a".to_string()]
    );
    assert!(manager
        .sessions_for_saved_connection("Work/c")
        .await
        .is_empty());
}

// ── Session-opened side effects (#4301) ────────────────────────────

use crate::files::transfer::relaunch_auto::WaitTrigger;
use crate::session::manager::{SessionOpenedHook, SessionOrigin};
use crate::session::retained_request::RetainedConnectionRequest;

/// A hook that records every trigger it is handed.
fn recording_hook() -> (SessionOpenedHook, Arc<std::sync::Mutex<Vec<WaitTrigger>>>) {
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = seen.clone();
    let hook: SessionOpenedHook = Arc::new(move |trigger| sink.lock().unwrap().push(trigger));
    (hook, seen)
}

/// Give `session_id` the tab `tab_id` with a retained resilient request, as
/// `create_connection` does for a resilient tab.
fn retain_for_tab(manager: &SessionManager, session_id: &str, tab_id: &str) {
    manager.session_tab_ids.lock().unwrap().insert(
        session_id.to_string(),
        TabBinding {
            tab_id: tab_id.to_string(),
            resilient: true,
        },
    );
    manager.retained_requests.retain(
        tab_id,
        RetainedConnectionRequest {
            type_id: "ssh".to_string(),
            settings: serde_json::json!({ "host": "lab" }),
            agent_id: None,
            agent_session_id: None,
            saved_connection_id: None,
            resilient: true,
        },
    );
}

#[test]
fn origin_reads_the_agent_definition_only_for_an_agent_session() {
    let top = serde_json::json!({ "definitionId": "def-a" });
    let nested = serde_json::json!({ "config": { "definition_id": "def-b" } });
    assert_eq!(
        SessionOrigin::new(None, Some("agent-1"), &top).agent_definition_id,
        Some("def-a".to_string())
    );
    assert_eq!(
        SessionOrigin::new(None, Some("agent-1"), &nested).agent_definition_id,
        Some("def-b".to_string())
    );
    assert_eq!(
        SessionOrigin::new(None, Some("agent-1"), &serde_json::json!({})).agent_definition_id,
        None
    );
    assert_eq!(
        SessionOrigin::new(None, None, &top).agent_definition_id,
        None
    );
    assert_eq!(
        SessionOrigin::new(Some(""), None, &top).saved_connection_id,
        None,
        "an empty saved-connection id is no saved connection"
    );
}

/// Opening a session binds it and fires the same resume triggers the
/// `create_connection` command used to fire inline.
#[tokio::test]
async fn opening_a_session_binds_it_and_fires_its_resume_triggers() {
    let manager = manager();
    let (hook, seen) = recording_hook();
    manager.set_session_opened_hook(hook);
    open(&manager, "sess-1").await;

    let origin = SessionOrigin::new(
        Some("Work/box"),
        Some("agent-1"),
        &serde_json::json!({ "definitionId": "def-1" }),
    );
    manager.on_session_opened("sess-1", &origin).await;

    assert_eq!(
        manager.saved_connection_of("sess-1").as_deref(),
        Some("Work/box")
    );
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            WaitTrigger::ConnectionOpened("Work/box".to_string()),
            WaitTrigger::AgentSessionOpened {
                agent_id: "agent-1".to_string(),
                definition_id: Some("def-1".to_string()),
            },
        ]
    );
}

/// An ad-hoc direct session has nothing to bind and nothing to resume.
#[tokio::test]
async fn an_ad_hoc_direct_session_fires_nothing() {
    let manager = manager();
    let (hook, seen) = recording_hook();
    manager.set_session_opened_hook(hook);
    open(&manager, "sess-1").await;

    manager
        .on_session_opened("sess-1", &SessionOrigin::default())
        .await;

    assert_eq!(manager.saved_connection_of("sess-1"), None);
    assert!(seen.lock().unwrap().is_empty());
}

/// The saved connection is stamped on the tab's retained request, so the
/// backend redrive can carry it to the re-created session.
#[tokio::test]
async fn opening_a_resilient_session_stamps_its_retained_request() {
    let manager = manager();
    open(&manager, "sess-1").await;
    retain_for_tab(&manager, "sess-1", "tab-1");

    let origin = SessionOrigin::new(Some("Work/box"), None, &serde_json::json!({}));
    manager.on_session_opened("sess-1", &origin).await;

    let request = manager.retained_request("tab-1").expect("still retained");
    assert_eq!(request.saved_connection_id.as_deref(), Some("Work/box"));
}

/// Binding without firing (a re-attach held by another desktop) still stamps
/// and binds, but resumes nothing.
#[tokio::test]
async fn binding_an_origin_fires_no_triggers() {
    let manager = manager();
    let (hook, seen) = recording_hook();
    manager.set_session_opened_hook(hook);
    open(&manager, "sess-1").await;
    retain_for_tab(&manager, "sess-1", "tab-1");

    let origin = SessionOrigin::new(Some("Work/box"), None, &serde_json::json!({}));
    manager.bind_session_origin("sess-1", &origin).await;

    assert_eq!(
        manager.saved_connection_of("sess-1").as_deref(),
        Some("Work/box")
    );
    assert_eq!(
        manager
            .retained_request("tab-1")
            .and_then(|r| r.saved_connection_id.clone())
            .as_deref(),
        Some("Work/box")
    );
    assert!(seen.lock().unwrap().is_empty());
}
