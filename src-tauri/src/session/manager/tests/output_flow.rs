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
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
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
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager.set_output_flow("missing", true).await;
    assert!(manager.output_flow_gate("missing").await.is_none());
}

// ── Agent-proxied sessions (#4416) ───────────────────────────────────────────

type FlowCalls = Arc<std::sync::Mutex<Vec<(String, String, bool)>>>;

/// An agent client whose agent does (or does not) support output flow control,
/// recording every `set_session_output_paused` it is asked for.
struct FlowAgent {
    output_flow: bool,
    calls: FlowCalls,
}

impl FlowAgent {
    fn new(output_flow: bool) -> (Arc<Self>, FlowCalls) {
        let calls = FlowCalls::default();
        (
            Arc::new(Self {
                output_flow,
                calls: calls.clone(),
            }),
            calls,
        )
    }
}

impl AgentRpcClient for FlowAgent {
    fn connect_agent(
        &self,
        _: &str,
        _: &RemoteAgentConfig,
        _: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        unimplemented!()
    }
    fn cancel_connect(&self, _: &str) -> bool {
        false
    }
    fn disconnect_agent(&self, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn is_connected(&self, _: &str) -> bool {
        true
    }
    fn get_capabilities(&self, _: &str) -> Option<AgentCapabilities> {
        let mut caps: AgentCapabilities = serde_json::from_value(serde_json::json!({
            "connectionTypes": [],
            "maxSessions": 10,
        }))
        .expect("minimal capabilities parse");
        caps.output_flow = self.output_flow;
        Some(caps)
    }
    fn shutdown_agent(&self, _: &str, _: Option<&str>) -> Result<u32, TerminalError> {
        unimplemented!()
    }
    fn send_request(&self, _: &str, _: &str, _: Value) -> Result<Value, TerminalError> {
        unimplemented!()
    }
    fn create_session(
        &self,
        _: &str,
        _: &str,
        _: Value,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        unimplemented!()
    }
    fn attach_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn close_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn list_sessions(&self, _: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        unimplemented!()
    }
    fn list_connections_and_folders(&self, _: &str) -> Result<AgentConnectionsData, TerminalError> {
        unimplemented!()
    }
    fn save_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn update_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionUpdateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_definition(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn create_folder(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn update_folder(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::FolderUpdateParams,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_folder(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_session_output(
        &self,
        _: &str,
        _: &str,
        _: OutputSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_session_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn register_monitoring_output(
        &self,
        _: &str,
        _: &str,
        _: MonitoringSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_monitoring_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn send_session_input(&self, _: &str, _: &str, _: &[u8]) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn resize_session(&self, _: &str, _: &str, _: u16, _: u16) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn apply_agent_settings(&self, _: &str, _: &AgentSettings) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn set_session_output_paused(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        paused: bool,
    ) -> Result<(), TerminalError> {
        self.calls.lock().unwrap().push((
            agent_id.to_string(),
            remote_session_id.to_string(),
            paused,
        ));
        Ok(())
    }
}

async fn agent_session_manager(output_flow: bool) -> (SessionManager, FlowCalls) {
    let (agent, calls) = FlowAgent::new(output_flow);
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), agent);
    manager
        .insert_test_agent_session(
            "desk-1",
            "agent-a",
            "remote-1",
            Box::new(MockConnection::default()),
        )
        .await;
    (manager, calls)
}

#[tokio::test]
async fn set_output_flow_forwards_pause_and_resume_to_a_flow_capable_agent() {
    let (manager, calls) = agent_session_manager(true).await;
    let gate = manager.output_flow_gate("desk-1").await.expect("gate");

    manager.set_output_flow("desk-1", true).await;
    assert!(gate.is_paused(), "the desktop reader pauses with the agent");
    manager.set_output_flow("desk-1", false).await;
    assert!(!gate.is_paused());

    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            ("agent-a".to_string(), "remote-1".to_string(), true),
            ("agent-a".to_string(), "remote-1".to_string(), false),
        ],
        "pause/resume must reach the agent for the remote session, in order"
    );
}

#[tokio::test]
async fn set_output_flow_leaves_an_older_agent_session_unpaused_without_error() {
    let (manager, calls) = agent_session_manager(false).await;
    let gate = manager.output_flow_gate("desk-1").await.expect("gate");

    manager.set_output_flow("desk-1", true).await;

    assert!(
        !gate.is_paused(),
        "a desktop reader in front of an agent that keeps streaming must not pause"
    );
    assert!(
        calls.lock().unwrap().is_empty(),
        "an older agent must not be asked to pause"
    );
}

#[tokio::test]
async fn output_flow_is_wired_for_direct_and_flow_capable_agent_sessions_only() {
    let (capable, _) = FlowAgent::new(true);
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), capable);
    let io = SessionIo::default();
    assert!(manager.output_flow_for(None, &io).is_some(), "direct");
    assert!(
        manager.output_flow_for(Some("agent-a"), &io).is_some(),
        "flow-capable agent"
    );

    let (older, _) = FlowAgent::new(false);
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), older);
    assert!(
        manager.output_flow_for(Some("agent-a"), &io).is_none(),
        "an older agent's session must stay unpaused"
    );
}
