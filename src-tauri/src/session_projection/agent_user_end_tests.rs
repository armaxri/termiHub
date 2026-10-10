//! #4459: a user agent Disconnect/Shutdown ends every hosted tab at the backend.
//!
//! `disconnect_agent` / `shutdown_agent` fold each live hosted tab's
//! `session-lifecycle` entry to `Disconnected(User)`, cancel its redrive timer
//! and scrub its retained request — once for every window, before the
//! `agent-state-change` "disconnected" event, which lists the tabs it ended. A
//! late drop of a hosted session (its output closing after the teardown) can no
//! longer arm a redrive: the store refuses to reconnect a `Disconnected(User)`
//! tab. A suspend (agent update, Force reconnect) and a loss keep the tabs
//! resumable.
//!
//! These drive the production `AgentConnectionManager` user end against the
//! production `SessionManager`, store, projection and timer driver (manual
//! scheduler), with the shared `FakeAgent` hosting the sessions.

use super::*;

use crate::session::manager::{DropFold, EventEmitter};
use crate::terminal::agent_manager::AgentConnectionManager;
use crate::terminal::backend::AgentEndReason;

type MockHandle = tauri::AppHandle<tauri::test::MockRuntime>;

/// The wiring every test here shares.
struct Rig {
    _app: tauri::App<tauri::test::MockRuntime>,
    handle: MockHandle,
    store: Arc<SessionLifecycleStore>,
    scheduler: Arc<ManualScheduler>,
    agents: AgentConnectionManager<tauri::test::MockRuntime>,
}

impl Rig {
    /// A mock app with the production `SessionManager`, store, projection and
    /// timer driver, one Connected resilient session per tab in `tabs` hosted
    /// by `agent-1`, and `agent-1` live in the agent manager.
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

        let agents = AgentConnectionManager::new(handle.clone());
        tauri::async_runtime::block_on(async { agents.insert_wedged_agent_for_test("agent-1") });

        Self {
            _app: app,
            handle,
            store,
            scheduler,
            agents,
        }
    }

    /// Arm the backend redrive for `tab` the way a resilient drop does.
    fn arm_redrive(&self, tab: &str) {
        self.handle.fold_session_drop(tab, DropFold::Reconnect);
        assert!(
            self.scheduler.armed(tab),
            "{tab}: redrive armed before the end"
        );
    }

    fn has_retained(&self, tab: &str) -> bool {
        self.handle
            .state::<SessionManager>()
            .has_retained_request(tab)
    }

    /// End `agent-1` with `reason`, returning every `agent-state-change`
    /// payload emitted while it ran.
    fn end_agent(&self, reason: AgentEndReason) -> Vec<Value> {
        use tauri::Listener;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let id = self.handle.listen_any("agent-state-change", move |event| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str::<Value>(event.payload()).unwrap());
        });
        self.agents
            .disconnect_agent_with_reason("agent-1", reason)
            .expect("the live agent disconnects");
        self.handle.unlisten(id);
        let out = seen.lock().unwrap().clone();
        out
    }

    fn assert_user_ended(&self, tab: &str) {
        let life = self.store.get(tab).expect("tab still tracked");
        assert_eq!(life.status, SessionStatus::Disconnected, "{tab} status");
        assert_eq!(life.end_reason, Some(EndReason::User), "{tab} end reason");
        assert!(!self.scheduler.armed(tab), "{tab}: no redrive armed");
        assert!(!self.has_retained(tab), "{tab}: retained request scrubbed");
    }
}

/// A user Disconnect and a user Shutdown fold every live hosted tab to
/// `Disconnected(User)` — including one whose redrive was already armed — and
/// the event lists exactly those tabs, not one the user had stopped earlier.
#[test]
fn user_end_folds_live_hosted_tabs_and_lists_them() {
    for reason in [AgentEndReason::User, AgentEndReason::Shutdown] {
        let rig = Rig::new(&["tab-a", "tab-b", "tab-stopped"]);
        rig.arm_redrive("tab-b");
        rig.store.cancel_reconnect("tab-stopped");

        let events = rig.end_agent(reason);

        rig.assert_user_ended("tab-a");
        rig.assert_user_ended("tab-b");
        rig.assert_user_ended("tab-stopped");
        assert_eq!(events.len(), 1, "{reason:?}: one event: {events:?}");
        assert_eq!(events[0]["state"], "disconnected");
        assert_eq!(
            events[0]["ended_tabs"],
            serde_json::json!(["tab-a", "tab-b"]),
            "{reason:?}: only the tabs this end folded are listed"
        );
    }
}

/// After a user Disconnect no redrive can be armed for the ended tabs: a hosted
/// session closing afterwards (the `terminal-exit` drop fold) and a late
/// `session.reconnect` both leave the tab `Disconnected(User)` with no timer.
#[test]
fn no_redrive_after_a_user_disconnect() {
    let rig = Rig::new(&["tab-a"]);
    rig.end_agent(AgentEndReason::User);

    rig.handle.fold_session_drop("tab-a", DropFold::Reconnect);
    rig.assert_user_ended("tab-a");

    rig.store.reconnect("tab-a");
    rig.handle
        .state::<Arc<ReconnectTimerDriver>>()
        .sync("tab-a");
    rig.assert_user_ended("tab-a");
}

/// A suspend (agent update, Force reconnect) and a loss keep the hosted tabs
/// resumable: nothing is folded, the retained requests stay, an armed redrive
/// stays armed, and the event lists no ended tabs.
#[test]
fn suspend_and_lost_do_not_fold_hosted_tabs() {
    for reason in [AgentEndReason::Suspend, AgentEndReason::Lost] {
        let rig = Rig::new(&["tab-a", "tab-b"]);
        rig.arm_redrive("tab-b");

        let events = rig.end_agent(reason);

        assert_eq!(
            rig.store.status("tab-a"),
            Some(SessionStatus::Connected),
            "{reason:?}"
        );
        assert!(rig.has_retained("tab-a"), "{reason:?}: request kept");
        assert_eq!(
            rig.store.status("tab-b"),
            Some(SessionStatus::Reconnecting),
            "{reason:?}"
        );
        assert!(rig.scheduler.armed("tab-b"), "{reason:?}: redrive kept");
        assert_eq!(events.len(), 1, "{reason:?}: {events:?}");
        assert!(
            events[0].get("ended_tabs").is_none(),
            "{reason:?}: no ended tabs on a resumable end: {events:?}"
        );
    }
}
