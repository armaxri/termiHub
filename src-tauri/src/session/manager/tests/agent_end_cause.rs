//! An agent-hosted session that ends with a cause the agent reported reads
//! like a direct one (#5732): the agent manager records the `connection.exit`
//! `end_cause` in the proxy's slot and drops the output route, and the
//! session's `terminal-exit` carries that cause.
//!
//! A shell on the agent that exits on its own (#5742) carries its real exit
//! status the same way: the tab ends with "[Process exited with code N]" and
//! is never reconnected, while a lost link still reconnects a resilient tab.

use super::*;

use std::time::{Duration, Instant};

use termihub_core::connection::SessionEndCause;

/// Upper bound for one wait. The exit usually lands within milliseconds.
const CEILING: Duration = Duration::from_secs(20);

/// Open a telnet tab hosted on `agent-1`.
async fn open_agent_tab(manager: &SessionManager, emitter: &MockEventEmitter) -> String {
    open_tab(manager, emitter, "telnet", false).await
}

/// Open a `type_id` tab hosted on `agent-1`; `resilient` as the client
/// computes it (every agent-hosted shell tab is resilient, #2476).
async fn open_tab(
    manager: &SessionManager,
    emitter: &MockEventEmitter,
    type_id: &str,
    resilient: bool,
) -> String {
    manager
        .create_connection(
            type_id,
            serde_json::json!({ "config": { "host": "10.0.0.5", "port": 23 } }),
            Some("agent-1"),
            Some("tab-1:0"),
            false,
            resilient,
            emitter.clone(),
        )
        .await
        .expect("the agent-hosted session opens")
}

/// End the agent session the way the I/O task does on `connection.exit`:
/// record `cause` (when there is one), then drop the output route.
fn end_on_agent(agent: &FakeAgent, cause: Option<SessionEndCause>) {
    end_on_agent_with(agent, cause, None);
}

/// [`end_on_agent`] with the real exit status the exit carries (#5742).
fn end_on_agent_with(agent: &FakeAgent, cause: Option<SessionEndCause>, status: Option<i32>) {
    agent
        .session_end_slots
        .lock()
        .unwrap()
        .last()
        .expect("the proxy registered its slot")
        .record(cause, status);
    agent.session_outputs.lock().unwrap().clear();
}

async fn wait_for_exit(emitter: &MockEventEmitter, session_id: &str) -> TerminalExitEvent {
    let deadline = Instant::now() + CEILING;
    loop {
        if let Some(exit) = emitter
            .exits
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.session_id == session_id)
        {
            return exit.clone();
        }
        assert!(
            Instant::now() < deadline,
            "no terminal-exit for {session_id}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_closed_agent_session_exits_with_remote_closed() {
    let agent = Arc::new(FakeAgent::session_host());
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), agent.clone());
    let emitter = MockEventEmitter::new();
    let session_id = open_agent_tab(&manager, &emitter).await;

    end_on_agent(&agent, Some(SessionEndCause::RemoteClosed));

    let exit = wait_for_exit(&emitter, &session_id).await;
    assert_eq!(exit.end_cause, Some(SessionEndCause::RemoteClosed));
    assert_eq!(exit.exit_code, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_session_lost_without_a_cause_has_none() {
    // A lost agent link (or an agent older than 0.38.0) records nothing, so
    // the tab still reads "connection lost".
    let agent = Arc::new(FakeAgent::session_host());
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), agent.clone());
    let emitter = MockEventEmitter::new();
    let session_id = open_agent_tab(&manager, &emitter).await;

    end_on_agent(&agent, None);

    let exit = wait_for_exit(&emitter, &session_id).await;
    assert_eq!(exit.end_cause, None);
}

/// The tab's drop folds once its session is gone from the manager (the fold
/// runs just after `terminal-exit`, before the entry is removed).
async fn folds_after_exit(
    manager: &SessionManager,
    emitter: &MockEventEmitter,
    session_id: &str,
) -> Vec<(String, DropFold)> {
    let deadline = Instant::now() + CEILING;
    while manager.sessions.lock().await.get(session_id).is_some() {
        assert!(Instant::now() < deadline, "{session_id} never cleaned up");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    emitter.session_drops.lock().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shell_the_user_exited_on_the_agent_ends_without_a_reconnect() {
    // The user typed `exit` (or `exit 3`) in a resilient agent shell tab: the
    // tab ends like a process exit — clean for 0, dropped otherwise — and is
    // never reconnected.
    for (status, expected) in [
        (0, vec![]),
        (3, vec![("tab-1".to_string(), DropFold::Dropped)]),
    ] {
        let agent = Arc::new(FakeAgent::session_host());
        let manager = SessionManager::new(ConnectionTypeRegistry::new(), agent.clone());
        let emitter = MockEventEmitter::new();
        let session_id = open_tab(&manager, &emitter, "local", true).await;

        end_on_agent_with(&agent, None, Some(status));

        let exit = wait_for_exit(&emitter, &session_id).await;
        assert_eq!(exit.exit_code, Some(status));
        assert_eq!(exit.end_cause, None);
        assert_eq!(
            folds_after_exit(&manager, &emitter, &session_id).await,
            expected
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lost_agent_shell_still_reconnects_a_resilient_tab() {
    let agent = Arc::new(FakeAgent::session_host());
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), agent.clone());
    let emitter = MockEventEmitter::new();
    let session_id = open_tab(&manager, &emitter, "local", true).await;

    end_on_agent(&agent, None);

    let exit = wait_for_exit(&emitter, &session_id).await;
    assert_eq!(exit.exit_code, None);
    assert_eq!(
        folds_after_exit(&manager, &emitter, &session_id).await,
        vec![("tab-1".to_string(), DropFold::Reconnect)]
    );
}
