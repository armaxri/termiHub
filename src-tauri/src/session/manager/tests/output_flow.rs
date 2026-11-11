//! Frontend flow control (PERF2-002, #4307): the frontend's pause/resume
//! reaches the session's output reader, which then stops reading the output
//! channel so the PTY reader is backpressured.

use super::*;

use std::time::Duration;

/// Poll `cond` until it holds or a generous deadline passes.
async fn eventually(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    cond()
}

fn emitted(emitter: &MockEventEmitter) -> Vec<u8> {
    emitter
        .outputs
        .lock()
        .unwrap()
        .iter()
        .flat_map(|e| e.data.iter().copied())
        .collect()
}

#[tokio::test]
async fn set_output_flow_pauses_and_resumes_the_session_reader() {
    let manager = SessionManager::new(
        ConnectionTypeRegistry::new(),
        Arc::new(FakeAgent::offline()),
    );
    manager
        .insert_test_session("s", Box::new(MockConnection::default()))
        .await;
    let gate = manager
        .output_flow_gate("s")
        .await
        .expect("a live session has a flow gate");

    let emitter = MockEventEmitter::new();
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);
    let reader_emitter = emitter.clone();
    let sessions = manager.sessions.clone();
    let handle = tokio::spawn(async move {
        SessionManager::run_output_reader(
            "s".to_string(),
            rx,
            reader_emitter,
            sessions,
            None,
            new_capture(),
            new_output_buffers(),
            new_session_loggers(),
            new_session_tab_ids(),
            CancellationToken::new(),
            Some(gate),
        )
        .await;
    });

    manager.set_output_flow("s", true).await;
    tx.send(b"held".to_vec()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        emitted(&emitter).is_empty(),
        "paused session still emitted output"
    );

    manager.set_output_flow("s", false).await;
    assert!(
        eventually(|| emitted(&emitter) == b"held").await,
        "resumed session did not emit the held output"
    );

    drop(tx);
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("reader did not finish")
        .expect("reader panicked");
}

#[tokio::test]
async fn set_output_flow_on_unknown_session_is_a_no_op() {
    let manager = SessionManager::new(
        ConnectionTypeRegistry::new(),
        Arc::new(FakeAgent::offline()),
    );
    manager.set_output_flow("missing", true).await;
    assert!(manager.output_flow_gate("missing").await.is_none());
}

// ── Agent-proxied sessions (#4416) ───────────────────────────────────────────

/// An agent client whose agent does (or does not) support output flow control;
/// it records every `set_session_output_paused` it is asked for.
fn flow_agent(output_flow: bool) -> Arc<FakeAgent> {
    Arc::new(FakeAgent {
        output_flow,
        ..FakeAgent::default()
    })
}

/// The `(agent, remote session, paused)` of every pause/resume the agent got.
fn pause_calls(agent: &FakeAgent) -> Vec<(String, String, bool)> {
    agent
        .calls_to("set_session_output_paused")
        .into_iter()
        .map(|args| (args[0].clone(), args[1].clone(), args[2] == "true"))
        .collect()
}

async fn agent_session_manager(output_flow: bool) -> (SessionManager, Arc<FakeAgent>) {
    let agent = flow_agent(output_flow);
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), agent.clone());
    manager
        .insert_test_agent_session(
            "desk-1",
            "agent-a",
            "remote-1",
            Box::new(MockConnection::default()),
        )
        .await;
    (manager, agent)
}

#[tokio::test]
async fn set_output_flow_forwards_pause_and_resume_to_a_flow_capable_agent() {
    let (manager, agent) = agent_session_manager(true).await;
    let gate = manager.output_flow_gate("desk-1").await.expect("gate");

    manager.set_output_flow("desk-1", true).await;
    assert!(gate.is_paused(), "the desktop reader pauses with the agent");
    manager.set_output_flow("desk-1", false).await;
    assert!(!gate.is_paused());

    assert_eq!(
        pause_calls(&agent),
        vec![
            ("agent-a".to_string(), "remote-1".to_string(), true),
            ("agent-a".to_string(), "remote-1".to_string(), false),
        ],
        "pause/resume must reach the agent for the remote session, in order"
    );
}

#[tokio::test]
async fn set_output_flow_leaves_an_older_agent_session_unpaused_without_error() {
    let (manager, agent) = agent_session_manager(false).await;
    let gate = manager.output_flow_gate("desk-1").await.expect("gate");

    manager.set_output_flow("desk-1", true).await;

    assert!(
        !gate.is_paused(),
        "a desktop reader in front of an agent that keeps streaming must not pause"
    );
    assert!(
        pause_calls(&agent).is_empty(),
        "an older agent must not be asked to pause"
    );
}

#[tokio::test]
async fn output_flow_is_wired_for_direct_and_flow_capable_agent_sessions_only() {
    let capable = flow_agent(true);
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), capable);
    let io = SessionIo::default();
    assert!(manager.output_flow_for(None, &io).is_some(), "direct");
    assert!(
        manager.output_flow_for(Some("agent-a"), &io).is_some(),
        "flow-capable agent"
    );

    let older = flow_agent(false);
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), older);
    assert!(
        manager.output_flow_for(Some("agent-a"), &io).is_none(),
        "an older agent's session must stay unpaused"
    );
}
