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
