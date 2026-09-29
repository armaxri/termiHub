//! Process list + kill routing for agent-hosted sessions (#3210).
//!
//! A current agent (`sessionProcesses`) serves SSH/Docker/WSL sessions scoped
//! to the remote session id; an older one makes the process table say "update
//! the agent" without sending a request it would reject.

use super::*;

/// Mock agent whose `connection.types` reply marks `type_id` monitorable and
/// whose `initialize` capabilities carry `session_processes`.
fn mock_agent(type_id: &str, session_processes: bool) -> Arc<MockAgentRpcClient> {
    let mut mock = MockAgentRpcClient::with_capabilities(json!({
        "types": [{
            "typeId": type_id,
            "displayName": type_id,
            "icon": "terminal",
            "schema": {"groups": []},
            "capabilities": {
                "monitoring": true,
                "fileBrowser": false,
                "resize": true,
                "persistent": true
            }
        }]
    }));
    mock.session_processes = Some(session_processes);
    Arc::new(mock)
}

async fn connected_proxy(mock: &Arc<MockAgentRpcClient>, session_type: &str) -> RemoteProxy {
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    proxy
        .connect(json!({ "type": session_type, "config": {"host": "server"} }))
        .await
        .expect("connect should succeed");
    proxy
}

fn process_requests(mock: &MockAgentRpcClient) -> Vec<(String, serde_json::Value)> {
    mock.sent_requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m.starts_with("connection.processes."))
        .cloned()
        .collect()
}

#[tokio::test]
async fn agent_hosted_sessions_route_list_and_kill_to_their_remote_session() {
    for session_type in ["ssh", "docker", "wsl"] {
        let mock = mock_agent(session_type, true);
        let mut proxy = connected_proxy(&mock, session_type).await;
        let manager = proxy
            .process_manager()
            .expect("an agent-hosted monitorable session has processes");

        // The mock answers every request with the same canned reply, so the
        // outcome is irrelevant here — only what was asked of the agent.
        let _ = manager.list_processes().await;
        let _ = manager.kill_process(77, KillSignal::Int).await;

        let sent = process_requests(&mock);
        assert_eq!(sent.len(), 2, "{session_type}: {sent:?}");
        assert_eq!(sent[0].0, "connection.processes.list");
        assert_eq!(sent[0].1["connection_id"], "mock-session-1");
        assert_eq!(sent[1].0, "connection.processes.kill");
        assert_eq!(sent[1].1["connection_id"], "mock-session-1");
        assert_eq!(sent[1].1["pid"], 77);
        assert_eq!(sent[1].1["signal"], "int");

        proxy.disconnect().await.ok();
    }
}

/// Old-agent fallback: the panel still opens and reports that the agent must
/// be updated; nothing is sent to an agent that would only reject it.
#[tokio::test]
async fn an_outdated_agent_reports_update_required_without_a_request() {
    let mock = mock_agent("ssh", false);
    let mut proxy = connected_proxy(&mock, "ssh").await;
    let manager = proxy
        .process_manager()
        .expect("the capability stays visible so the panel can explain");

    assert_eq!(
        manager.list_processes().await,
        Err(ProcessError::AgentOutdated)
    );
    assert_eq!(
        manager.kill_process(5, KillSignal::Term).await,
        Err(ProcessError::AgentOutdated)
    );
    assert!(process_requests(&mock).is_empty());

    proxy.disconnect().await.ok();
}

/// A local agent session was supported before #3210 and keeps working on an
/// older agent: it targets the agent host itself (`connection_id: null`).
#[tokio::test]
async fn a_local_session_on_an_older_agent_still_targets_the_agent_host() {
    let mock = mock_agent("local", false);
    let mut proxy = connected_proxy(&mock, "local").await;
    let manager = proxy
        .process_manager()
        .expect("local sessions have processes");

    let _ = manager.list_processes().await;
    let sent = process_requests(&mock);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(sent[0].1["connection_id"].is_null(), "{sent:?}");

    proxy.disconnect().await.ok();
}
