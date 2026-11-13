//! An agent-hosted session that ends with a cause the agent reported reads
//! like a direct one (#5732): the agent manager records the `connection.exit`
//! `end_cause` in the proxy's slot and drops the output route, and the
//! session's `terminal-exit` carries that cause.

use super::*;

use std::time::{Duration, Instant};

use termihub_core::connection::SessionEndCause;

/// Upper bound for one wait. The exit usually lands within milliseconds.
const CEILING: Duration = Duration::from_secs(20);

/// Open a telnet tab hosted on `agent-1`.
async fn open_agent_tab(manager: &SessionManager, emitter: &MockEventEmitter) -> String {
    manager
        .create_connection(
            "telnet",
            serde_json::json!({ "config": { "host": "10.0.0.5", "port": 23 } }),
            Some("agent-1"),
            Some("tab-1:0"),
            false,
            false,
            emitter.clone(),
        )
        .await
        .expect("the agent-hosted session opens")
}

/// End the agent session the way the I/O task does on `connection.exit`:
/// record `cause` (when there is one), then drop the output route.
fn end_on_agent(agent: &FakeAgent, cause: Option<SessionEndCause>) {
    if let Some(cause) = cause {
        let slots = agent.session_end_slots.lock().unwrap();
        slots
            .last()
            .expect("the proxy registered its slot")
            .record(cause);
    }
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
