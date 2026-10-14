//! End-to-end give-up of an in-task agent reconnect that never completes (#4404).
//!
//! #4304 bounded each reconnect attempt's handshake and moved the give-up into
//! [`give_up_after_exhausted_reconnect`]; both are covered on their own. This
//! drives the whole shipped path in one go, headless, against the in-process
//! [`FakeAgentSshd`]: connect through [`AgentConnectionManager::connect_agent`],
//! open one agent-hosted tab through the production [`SessionManager`], sever
//! the transport, and let the I/O task's [`reconnect_agent`] loop run every
//! attempt into an agent that never answers `initialize` again. The loop runs
//! on a short handshake bound and a two-attempt, 10 ms policy
//! ([`AgentConnectionManager::set_reconnect_tuning_for_test`]), so it gives up
//! in well under a second instead of the production minutes.
//!
//! Unix-only, like the transport sever it relies on.
//!
//! [`give_up_after_exhausted_reconnect`]: super::io_task::give_up_after_exhausted_reconnect
//! [`reconnect_agent`]: super::reconnect::reconnect_agent

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::{Listener, Manager};
use termihub_core::connection::ConnectionTypeRegistry;
use termihub_core::reconnect_backoff::BackoffConfig;

use super::fake_agent_sshd::{FakeAgentSshd, InitBehavior};
use super::reconnect::ReconnectTuning;
use super::{AgentConnectionManager, AgentRpcClient};
use crate::session::manager::SessionManager;
use crate::session_projection::store::{SessionLifecycle, SessionLifecycleStore, SessionStatus};

const AGENT: &str = "agent-give-up";
const TAB: &str = "tab-give-up";

/// Ceiling for any one step against the loopback fake agent. The whole give-up
/// takes well under a second; this only keeps a regression from hanging CI.
const STEP: Duration = Duration::from_secs(15);

/// Two attempts, 10 ms apart, no jitter: deterministic and fast.
const FAST_POLICY: BackoffConfig = BackoffConfig {
    base_delay_ms: 10.0,
    factor: 1.0,
    max_delay_ms: 10.0,
    max_attempts: 2,
    jitter_ratio: 0.0,
};

/// The give-up error the loop reports for [`FAST_POLICY`].
const GIVE_UP_ERROR: &str = "Failed to reconnect after 2 attempts";

fn trust_all_host_keys() {
    use termihub_core::backends::ssh::host_key::{
        set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    };
    struct TrustAll;
    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustAll {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }
    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

/// One `agent-state-change` "disconnected" event for [`AGENT`]: its `error`,
/// and the tab's region entry as it stood when the event fired.
type Disconnect = (Value, Option<SessionLifecycle>);

/// Record every "disconnected" event for [`AGENT`] (see [`Disconnect`]).
fn record_disconnects(
    app: &tauri::App<MockRuntime>,
    store: &Arc<SessionLifecycleStore>,
) -> Arc<Mutex<Vec<Disconnect>>> {
    let seen: Arc<Mutex<Vec<Disconnect>>> = Arc::default();
    let (sink, store) = (seen.clone(), store.clone());
    app.handle().listen_any("agent-state-change", move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        if payload["session_id"].as_str() == Some(AGENT)
            && payload["state"].as_str() == Some("disconnected")
        {
            sink.lock()
                .unwrap()
                .push((payload["error"].clone(), store.get(TAB)));
        }
    });
    seen
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_never_answering_reconnect_gives_up_and_folds_the_hosted_tab_failed() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::StallOnReconnect).await;
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let store = Arc::new(SessionLifecycleStore::new());
    handle.manage(store.clone());

    let mut manager = AgentConnectionManager::new(handle.clone());
    manager.set_reconnect_tuning_for_test(ReconnectTuning {
        handshake_timeout: Duration::from_millis(200),
        policy: FAST_POLICY,
    });
    let manager = Arc::new(manager);
    handle.manage(SessionManager::new(
        ConnectionTypeRegistry::new(),
        manager.clone() as Arc<dyn AgentRpcClient>,
    ));

    // Connect: the fake agent answers this first `initialize`.
    let (m, cfg) = (manager.clone(), server.agent_config());
    tokio::time::timeout(
        STEP,
        tokio::task::spawn_blocking(move || m.connect_agent(AGENT, &cfg, None)),
    )
    .await
    .expect("connect settles")
    .expect("connect join")
    .expect("the fake agent connects");

    // One agent-hosted tab, opened through the production session path.
    let sessions = handle.state::<SessionManager>();
    tokio::time::timeout(
        STEP,
        sessions.create_connection(
            "shell",
            json!({ "config": {} }),
            Some(AGENT),
            Some(&format!("{TAB}:0")),
            false,
            true,
            handle.clone(),
        ),
    )
    .await
    .expect("the hosted session opens in time")
    .expect("the hosted session opens");
    store.connect(TAB);
    store.connected(TAB);
    assert_eq!(
        sessions
            .agent_hosted_sessions(AGENT)
            .await
            .into_iter()
            .map(|h| h.tab_id)
            .collect::<Vec<_>>(),
        vec![TAB.to_string()]
    );
    assert!(manager.io_budgets.lock().unwrap().contains_key(AGENT));

    let disconnects = record_disconnects(&app, &store);

    // Sever: every reconnect attempt now reaches `initialize` and stalls.
    assert!(manager.test_sever_transport(AGENT));
    let deadline = tokio::time::Instant::now() + STEP;
    while disconnects.lock().unwrap().is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the reconnect never gave up (tab is {:?})",
            store.status(TAB)
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Both attempts reached the handshake and timed out there.
    assert_eq!(server.inits(), 3, "one connect + two reconnect attempts");

    // `disconnected` was announced once, carrying the give-up error, and by
    // then the hosted tab had folded `Failed` at the backend source with the
    // same error. Read at the emit: the hosted session's own late drop (its
    // output channel closes when the task ends) refolds the tab afterwards —
    // see the follow-up filed from #4404.
    let disconnects = disconnects.lock().unwrap().clone();
    assert_eq!(
        disconnects.len(),
        1,
        "one disconnected event: {disconnects:?}"
    );
    let (error, life) = &disconnects[0];
    assert_eq!(error, &json!(GIVE_UP_ERROR));
    let life = life.as_ref().expect("the tab is tracked at the give-up");
    assert_eq!(life.status, SessionStatus::Failed);
    assert_eq!(life.error.as_deref(), Some(GIVE_UP_ERROR));

    // The task reaps its own entry and its data-credit budget right after the
    // emit.
    let reaped = || {
        !manager.agents.lock().unwrap().contains_key(AGENT)
            && !manager.io_budgets.lock().unwrap().contains_key(AGENT)
    };
    while !reaped() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the gave-up agent's entry or io_budget was never reaped"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!manager.is_connected(AGENT));
}
