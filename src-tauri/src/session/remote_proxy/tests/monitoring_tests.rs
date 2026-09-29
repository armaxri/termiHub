//! Session monitoring routing for agent-hosted sessions (#3871).
//!
//! A current agent (`sessionMonitoring`) monitors SSH/Docker/WSL sessions keyed
//! by the remote session id; an older one makes the status bar say "update the
//! agent" — the subscribe fails with the `agent_outdated` code — without a
//! request it would reject.

use super::*;

/// Mock agent whose `connection.types` reply marks `type_id` monitorable and
/// whose `initialize` capabilities carry `session_monitoring`.
fn mock_agent(type_id: &str, session_monitoring: bool) -> Arc<MockAgentRpcClient> {
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
    mock.session_monitoring = Some(session_monitoring);
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

fn monitoring_requests(mock: &MockAgentRpcClient) -> Vec<(String, serde_json::Value)> {
    mock.sent_requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m.starts_with("connection.monitoring."))
        .cloned()
        .collect()
}

#[tokio::test]
async fn agent_hosted_sessions_subscribe_under_their_remote_session_id() {
    for session_type in ["ssh", "docker", "wsl"] {
        let mock = mock_agent(session_type, true);
        let mut proxy = connected_proxy(&mock, session_type).await;
        let provider = proxy
            .monitoring_handle()
            .expect("an agent-hosted monitorable session has a monitor");

        let _subscription = provider
            .subscribe()
            .await
            .unwrap_or_else(|e| panic!("{session_type}: subscribe failed: {e}"));
        provider.unsubscribe().await.expect("unsubscribe");

        let sent = monitoring_requests(&mock);
        assert_eq!(sent.len(), 2, "{session_type}: {sent:?}");
        assert_eq!(sent[0].0, "connection.monitoring.subscribe");
        assert_eq!(sent[0].1["host"], "mock-session-1", "{session_type}");
        assert_eq!(sent[1].0, "connection.monitoring.unsubscribe");
        assert_eq!(sent[1].1["host"], "mock-session-1", "{session_type}");
        assert_eq!(
            mock.registered_monitoring_hosts.lock().unwrap().as_slice(),
            ["mock-session-1"],
            "{session_type}: samples are routed by the remote session id"
        );

        proxy.disconnect().await.ok();
    }
}

/// Old-agent fallback: the subscribe fails with the `agent_outdated` marker
/// (the status bar turns it into "update the agent"), and nothing reaches an
/// agent that would only reject the session id.
#[tokio::test]
async fn an_outdated_agent_fails_the_subscribe_as_agent_outdated_without_a_request() {
    for session_type in ["ssh", "docker", "wsl"] {
        let mock = mock_agent(session_type, false);
        let mut proxy = connected_proxy(&mock, session_type).await;
        let provider = proxy
            .monitoring_handle()
            .expect("the capability stays visible so the status bar can explain");

        let err = match provider.subscribe().await {
            Ok(_) => panic!("{session_type}: an outdated agent must not subscribe"),
            Err(e) => e,
        };
        let terminal = TerminalError::RemoteError(err.to_string());
        assert_eq!(
            terminal.code(),
            crate::utils::errors::IpcErrorCode::AgentOutdated,
            "{session_type}: {terminal}"
        );

        // Pause / interval / unsubscribe stay quiet too.
        provider.set_interval(Duration::from_secs(5)).await;
        provider.set_paused(true).await;
        provider.unsubscribe().await.expect("nothing to stop");
        assert!(monitoring_requests(&mock).is_empty(), "{session_type}");
        assert!(mock.registered_monitoring_hosts.lock().unwrap().is_empty());

        proxy.disconnect().await.ok();
    }
}

/// A local agent session was monitored before #3871 ("self") and keeps
/// working on an older agent.
#[tokio::test]
async fn a_local_session_on_an_older_agent_still_monitors_the_agent_host() {
    let mock = mock_agent("local", false);
    let mut proxy = connected_proxy(&mock, "local").await;
    let provider = proxy.monitoring_handle().expect("local sessions monitor");

    let _subscription = provider.subscribe().await.expect("subscribe");
    let sent = monitoring_requests(&mock);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].1["host"], "self");

    proxy.disconnect().await.ok();
}
