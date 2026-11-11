//! #5396: an agent-hosted serial tab mirrors its agent's in-place port reopen.
//!
//! The agent reports each step of the reopen as a `connection.reconnect`
//! notification. These drive the production desktop path — the notification
//! routed to its hosted tab, folded into the store, the timer reconciled, and
//! the Stop closing the agent session — against the production
//! `SessionManager`, store, projection and timer driver (manual scheduler),
//! with the shared `FakeAgent` hosting the session.

use super::*;

use termihub_core::protocol::methods::{ConnectionReconnectNotification, SessionReconnectStatus};

use crate::session::manager::AgentHostedSession;
use crate::session_projection::projection::close_agent_reconnecting_session;
use crate::terminal::agent_manager::fold_reconnect_hosted_sessions;

type MockHandle = tauri::AppHandle<tauri::test::MockRuntime>;

const TAB: &str = "tab-1";

struct Rig {
    _app: tauri::App<tauri::test::MockRuntime>,
    handle: MockHandle,
    agent: Arc<FakeAgent>,
    store: Arc<SessionLifecycleStore>,
    scheduler: Arc<ManualScheduler>,
    hosted: Vec<AgentHostedSession>,
}

impl Rig {
    /// One Connected resilient serial tab hosted by `agent-1` (remote-0).
    fn new() -> Self {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        let agent = Arc::new(FakeAgent::new());
        handle.manage(SessionManager::new(
            ConnectionTypeRegistry::new(),
            agent.clone() as Arc<dyn AgentRpcClient>,
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
        let sid = tauri::async_runtime::block_on(manager.create_connection(
            "serial",
            serde_json::json!({ "port": "/dev/ttyUSB0" }),
            Some("agent-1"),
            Some(&format!("{TAB}:0")),
            false,
            true, // resilient
            handle.clone(),
        ))
        .expect("initial connect succeeds");
        store.connect(TAB);
        store.connected(TAB);
        store.set_backend_session_id(TAB, Some(sid));
        let hosted = tauri::async_runtime::block_on(manager.agent_hosted_sessions("agent-1"));
        assert_eq!(hosted.len(), 1);

        Self {
            _app: app,
            handle,
            agent,
            store,
            scheduler,
            hosted,
        }
    }

    /// The agent reports `status` (sequence `seq`) for remote-0.
    fn notify(&self, seq: u64, status: SessionReconnectStatus) {
        let notification = ConnectionReconnectNotification {
            session_id: "remote-0".into(),
            seq,
            status,
        };
        fold_reconnect_hosted_sessions(&self.handle, &self.hosted, &notification);
    }
}

fn waiting(attempt: i64, delay_ms: i64) -> SessionReconnectStatus {
    SessionReconnectStatus::Waiting {
        attempt,
        delay_ms,
        reason: Some("Serial port /dev/ttyUSB0 is not present.".into()),
    }
}

#[test]
fn the_tab_shows_the_agent_reopen_and_arms_no_desktop_redrive() {
    let rig = Rig::new();
    rig.notify(1, waiting(0, 1000));

    let entry = rig.store.get(TAB).unwrap();
    assert_eq!(entry.status, SessionStatus::Reconnecting);
    assert_eq!(entry.reconnect.phase, ReconnectPhase::Waiting);
    assert_eq!(entry.reconnect.delay_ms, 1000);
    assert_eq!(
        entry.reconnect_error.as_deref(),
        Some("Serial port /dev/ttyUSB0 is not present.")
    );
    assert!(
        !rig.scheduler.armed(TAB),
        "the agent times its own attempts; the desktop must not redrive"
    );

    rig.notify(
        2,
        SessionReconnectStatus::Connecting {
            attempt: 1,
            reason: None,
        },
    );
    assert_eq!(
        rig.store.get(TAB).unwrap().reconnect.phase,
        ReconnectPhase::Connecting
    );

    rig.notify(3, SessionReconnectStatus::Reconnected);
    assert_eq!(rig.store.status(TAB), Some(SessionStatus::Connected));
    assert!(!rig.scheduler.armed(TAB));
    assert_eq!(
        rig.agent.create_count.load(Ordering::SeqCst),
        1,
        "the same agent session continues; nothing is re-created"
    );
}

#[test]
fn a_give_up_fails_the_tab_with_its_reason() {
    let rig = Rig::new();
    rig.notify(1, waiting(0, 1000));
    rig.notify(
        21,
        SessionReconnectStatus::GaveUp {
            reason: Some("Serial port /dev/ttyUSB0 is not present.".into()),
        },
    );
    let entry = rig.store.get(TAB).unwrap();
    assert_eq!(entry.status, SessionStatus::Failed);
    assert_eq!(
        entry.error.as_deref(),
        Some("Serial port /dev/ttyUSB0 is not present.")
    );
    assert!(!rig.scheduler.armed(TAB));
}

#[test]
fn stop_closes_the_agent_session_so_the_agent_stops_reopening() {
    let rig = Rig::new();
    rig.notify(1, waiting(0, 1000));

    // What the `session.cancelReconnect` route does for an agent-owned loop.
    let to_close = rig
        .store
        .agent_reconnect_session(TAB)
        .expect("an agent-owned loop names its session");
    rig.store.cancel_reconnect(TAB);
    close_agent_reconnecting_session(&rig.handle, to_close);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while rig.agent.closed.lock().unwrap().is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "the agent session must be closed"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(*rig.agent.closed.lock().unwrap(), vec!["remote-0".to_string()]);
    assert_eq!(rig.store.status(TAB), Some(SessionStatus::Disconnected));
}

#[test]
fn a_step_for_another_remote_session_is_ignored() {
    let rig = Rig::new();
    let notification: ConnectionReconnectNotification = serde_json::from_value(
        serde_json::json!({ "session_id": "remote-9", "seq": 1, "state": "reconnected" }),
    )
    .unwrap();
    fold_reconnect_hosted_sessions(&rig.handle, &rig.hosted, &notification);
    assert_eq!(rig.store.status(TAB), Some(SessionStatus::Connected));
}

#[test]
fn without_agent_steps_the_desktop_loop_runs_as_before() {
    // An agent older than 0.37.0 sends no steps: a drop of the tab arms the
    // desktop's own redrive exactly as it did.
    let rig = Rig::new();
    rig.store.reconnect(TAB);
    let handle = &rig.handle;
    handle.state::<Arc<ReconnectTimerDriver>>().sync(TAB);
    assert!(rig.scheduler.armed(TAB));
}
