//! SM2-002 (#4305): every agent-recovery fold respects the tab's current status.
//!
//! The SM-002 fix guarded only the recovered-in-place branch. The sibling folds
//! that run around the same agent transport break — session lost, session
//! unconfirmed (`connection.list` unavailable), reconnect gave up, and a new
//! transport break — folded whatever status the tab had. So a tab the user
//! Stopped, or one that had already ended, was relabelled or revived.
//!
//! These drive the production `SessionManager` + the real recovery helpers
//! against the shared `FakeAgent`, with the real `ReconnectTimerDriver` on a
//! manual scheduler, and check that:
//!  - a user-Stopped tab stays `Disconnected(User)` through every fold, and its
//!    still-registered agent session is torn down;
//!  - an ended tab (`SessionLost`, `Failed`) is never folded back to
//!    `Reconnecting` by a new transport break;
//!  - a tab genuinely awaiting recovery (`Reconnecting`) still gets the fold.

use super::*;

use crate::terminal::agent_manager::{
    fold_agent_hosted_reconnect_failed, fold_agent_hosted_reconnecting,
    resolve_agent_hosted_sessions, resolve_hosted_sessions_after_reconnect,
};

/// The wiring every test here shares.
struct Rig {
    _app: tauri::App<tauri::test::MockRuntime>,
    handle: tauri::AppHandle<tauri::test::MockRuntime>,
    store: Arc<SessionLifecycleStore>,
    scheduler: Arc<ManualScheduler>,
}

impl Rig {
    /// A mock app with the production `SessionManager`, store, projection and
    /// timer driver, plus one Connected agent-hosted session per tab in `tabs`
    /// on `agent-1` (tab N ↔ `remote-N`, in order).
    fn new(tabs: &[&str]) -> Self {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        let agent = Arc::new(FakeAgent::new());
        handle.manage(SessionManager::new(
            ConnectionTypeRegistry::new(),
            agent as Arc<dyn AgentRpcClient>,
        ));

        let store = Arc::new(SessionLifecycleStore::new());
        store.set_rand_for_test(Box::new(|| 0.0));
        handle.manage(store.clone());

        let projection = ProjectionState::new();
        projection
            .projector
            .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
        let projector = projection.projector.clone();
        handle.manage(projection);

        let scheduler = Arc::new(ManualScheduler::default());
        let store_for_publish = store.clone();
        handle.manage(Arc::new(ReconnectTimerDriver::new(
            store.clone(),
            scheduler.clone(),
            Arc::new(move || {
                publish_sessions(&projector, &store_for_publish);
            }),
        )));

        let manager = handle.state::<SessionManager>();
        let settings = serde_json::json!({ "config": {} });
        for tab in tabs {
            tauri::async_runtime::block_on(manager.create_connection(
                "shell",
                settings.clone(),
                Some("agent-1"),
                Some(&format!("{tab}:0")),
                false,
                true, // resilient
                handle.clone(),
            ))
            .expect("initial connect succeeds");
            store.connect(tab);
            store.connected(tab);
        }

        Self {
            _app: app,
            handle,
            store,
            scheduler,
        }
    }

    fn hosted(&self) -> Vec<crate::session::manager::AgentHostedSession> {
        let manager = self.handle.state::<SessionManager>();
        tauri::async_runtime::block_on(manager.agent_hosted_sessions("agent-1"))
    }

    fn hosted_tabs(&self) -> Vec<String> {
        self.hosted().into_iter().map(|h| h.tab_id).collect()
    }

    /// A transient transport break: every hosted tab folds `Reconnecting`.
    fn transport_break(&self) {
        tauri::async_runtime::block_on(fold_agent_hosted_reconnecting(
            &self.handle,
            "agent-1",
            Some("connection reset"),
        ));
    }

    fn assert_user_stopped(&self, tab: &str) {
        let life = self.store.get(tab).expect("tab still tracked");
        assert_eq!(life.status, SessionStatus::Disconnected, "{tab} status");
        assert_eq!(life.end_reason, Some(EndReason::User), "{tab} end reason");
        assert!(!self.scheduler.armed(tab), "{tab}: no redrive armed");
    }
}

/// Stop during a break, then `connection.list` is unavailable: the Stopped tab
/// stays `Disconnected(User)` (not relabelled `SessionLost`) and its agent
/// session is torn down; the control tab still settles `SessionLost`.
#[test]
fn stop_then_list_unavailable_keeps_the_user_stop_and_closes_the_session() {
    let rig = Rig::new(&["tab-1", "tab-2"]);
    let hosted = rig.hosted();
    rig.transport_break();
    rig.store.cancel_reconnect("tab-1");

    tauri::async_runtime::block_on(resolve_hosted_sessions_after_reconnect(
        &rig.handle,
        &hosted,
        None,
    ));

    rig.assert_user_stopped("tab-1");
    assert_eq!(rig.store.status("tab-2"), Some(SessionStatus::SessionLost));
    let remaining = rig.hosted_tabs();
    assert!(
        !remaining.contains(&"tab-1".to_string()),
        "the Stopped tab's agent session is torn down: {remaining:?}"
    );
    assert!(
        remaining.contains(&"tab-2".to_string()),
        "an awaiting tab's session is not torn down by the settle"
    );
}

/// Stop during a break, then the agent recovers its transport but the session
/// is gone: the Stopped tab stays `Disconnected(User)` and is torn down; the
/// control tab folds `SessionLost`.
#[test]
fn stop_then_session_absent_keeps_the_user_stop_and_closes_the_session() {
    let rig = Rig::new(&["tab-1", "tab-2"]);
    let hosted = rig.hosted();
    rig.transport_break();
    rig.store.cancel_reconnect("tab-1");

    let live_ids = std::collections::HashSet::new();
    tauri::async_runtime::block_on(resolve_agent_hosted_sessions(
        &rig.handle,
        &hosted,
        &live_ids,
    ));

    rig.assert_user_stopped("tab-1");
    assert_eq!(rig.store.status("tab-2"), Some(SessionStatus::SessionLost));
    assert!(!rig.hosted_tabs().contains(&"tab-1".to_string()));
}

/// Stop during a break, then the agent gives up: the Stopped tab stays
/// `Disconnected(User)` rather than being relabelled `Failed`.
#[test]
fn stop_then_agent_gives_up_keeps_the_user_stop() {
    let rig = Rig::new(&["tab-1", "tab-2"]);
    rig.transport_break();
    rig.store.cancel_reconnect("tab-1");

    tauri::async_runtime::block_on(fold_agent_hosted_reconnect_failed(
        &rig.handle,
        "agent-1",
        "reconnection failed: connection refused",
    ));

    rig.assert_user_stopped("tab-1");
    let failed = rig.store.get("tab-2").unwrap();
    assert_eq!(failed.status, SessionStatus::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some("reconnection failed: connection refused")
    );
}

/// A tab that already ended (`SessionLost`, `Failed`, `Disconnected(User)`) is
/// not folded back to `Reconnecting` by the next transport break, so a later
/// recovery that lists its session live cannot resurrect it (the two-step
/// SM-002 resurrection). A live tab still enters `Reconnecting`.
#[test]
fn new_break_never_refolds_an_ended_tab() {
    let rig = Rig::new(&["lost", "failed", "stopped", "live"]);
    rig.store.session_lost("lost", Some("gone".to_string()));
    rig.store
        .connect_failed("failed", Some("refused".to_string()));
    rig.store.disconnect("stopped");

    rig.transport_break();

    assert_eq!(rig.store.status("lost"), Some(SessionStatus::SessionLost));
    assert_eq!(rig.store.status("failed"), Some(SessionStatus::Failed));
    rig.assert_user_stopped("stopped");
    assert_eq!(rig.store.status("live"), Some(SessionStatus::Reconnecting));

    // The recovery then lists every session live: only the awaiting tab folds
    // back to Connected; the ended ones stay ended.
    let live_ids: std::collections::HashSet<String> =
        (0..4).map(|n| format!("remote-{n}")).collect();
    let hosted = rig.hosted();
    tauri::async_runtime::block_on(resolve_agent_hosted_sessions(
        &rig.handle,
        &hosted,
        &live_ids,
    ));
    assert_eq!(rig.store.status("lost"), Some(SessionStatus::SessionLost));
    assert_eq!(rig.store.status("failed"), Some(SessionStatus::Failed));
    rig.assert_user_stopped("stopped");
    assert_eq!(rig.store.status("live"), Some(SessionStatus::Connected));
}

/// An ended tab is also left alone by the give-up and unconfirmed folds — only
/// a `Reconnecting` tab is awaiting their outcome.
#[test]
fn give_up_and_unconfirmed_folds_skip_ended_tabs() {
    let rig = Rig::new(&["lost", "failed"]);
    rig.store.session_lost("lost", Some("gone".to_string()));
    rig.store
        .connect_failed("failed", Some("refused".to_string()));

    tauri::async_runtime::block_on(fold_agent_hosted_reconnect_failed(
        &rig.handle,
        "agent-1",
        "gave up",
    ));
    let lost = rig.store.get("lost").unwrap();
    assert_eq!(lost.status, SessionStatus::SessionLost);
    assert_eq!(lost.error.as_deref(), Some("gone"));

    let hosted = rig.hosted();
    tauri::async_runtime::block_on(resolve_hosted_sessions_after_reconnect(
        &rig.handle,
        &hosted,
        None,
    ));
    let failed = rig.store.get("failed").unwrap();
    assert_eq!(failed.status, SessionStatus::Failed);
    assert_eq!(failed.error.as_deref(), Some("refused"));
}
