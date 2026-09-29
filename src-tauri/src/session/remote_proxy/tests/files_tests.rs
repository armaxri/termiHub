//! File browsing of agent-hosted sessions (#3242).
//!
//! A current agent (`sessionFiles`) browses an SSH, Docker, FTP or WSL session
//! inside that session's own remote host, container, server or distribution,
//! keyed by the remote session id. On an older agent the file browser says
//! "update the agent" — every operation fails with the `agent_outdated` code —
//! without a request the agent would only reject.

use super::*;

/// Mock agent whose `connection.types` reply marks `type_id` browsable and
/// whose `initialize` capabilities carry `session_files`.
fn mock_agent(type_id: &str, session_files: bool) -> Arc<MockAgentRpcClient> {
    let mut mock = MockAgentRpcClient::with_capabilities(json!({
        "types": [{
            "typeId": type_id,
            "displayName": type_id,
            "icon": "terminal",
            "schema": {"groups": []},
            "capabilities": {
                "monitoring": false,
                "fileBrowser": true,
                "resize": true,
                "persistent": true
            }
        }]
    }));
    mock.session_files = Some(session_files);
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

fn file_requests(mock: &MockAgentRpcClient) -> Vec<(String, serde_json::Value)> {
    mock.sent_requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m.starts_with("connection.files."))
        .cloned()
        .collect()
}

/// Every file operation of an agent-hosted session goes to the agent under the
/// remote session id, so the agent browses inside that session — never on the
/// agent host.
#[tokio::test]
async fn agent_hosted_sessions_browse_under_their_remote_session_id() {
    for session_type in ["ssh", "docker", "ftp", "wsl"] {
        let mock = mock_agent(session_type, true);
        let mut proxy = connected_proxy(&mock, session_type).await;
        let browser = proxy
            .file_browser()
            .expect("an agent-hosted browsable session has a file browser");

        // The mock answers every request with the same canned value, so only
        // the routing is asserted here, not the parsed replies.
        let _ = browser.list_dir("/srv").await;
        let _ = browser.stat("/srv/a.txt").await;
        let _ = browser.read_file("/srv/a.txt").await;
        let _ = browser.write_file("/srv/b.txt", b"hello").await;
        let _ = browser.mkdir("/srv/new").await;
        let _ = browser.rename("/srv/b.txt", "/srv/c.txt").await;
        let _ = browser.delete("/srv/c.txt").await;

        let sent = file_requests(&mock);
        let methods: Vec<&str> = sent.iter().map(|(m, _)| m.as_str()).collect();
        assert_eq!(
            methods,
            [
                "connection.files.list",
                "connection.files.stat",
                "connection.files.read",
                "connection.files.write",
                "connection.files.mkdir",
                "connection.files.rename",
                "connection.files.delete",
            ],
            "{session_type}"
        );
        for (method, params) in &sent {
            let id = params
                .get("connection_id")
                .or_else(|| params.get("connectionId"))
                .unwrap_or(&serde_json::Value::Null);
            assert_eq!(id, "mock-session-1", "{session_type}: {method} {params}");
        }

        proxy.disconnect().await.ok();
    }
}

/// Old-agent fallback: every operation fails with the `agent_outdated` code —
/// which the file browser shows as "update the agent" — and nothing reaches
/// an agent that would only answer "not supported".
#[tokio::test]
async fn an_outdated_agent_fails_file_operations_as_agent_outdated_without_a_request() {
    for session_type in ["ssh", "docker", "ftp", "wsl"] {
        let mock = mock_agent(session_type, false);
        let mut proxy = connected_proxy(&mock, session_type).await;
        let browser = proxy
            .file_browser()
            .expect("the capability stays visible so the file browser can explain");

        let err = browser
            .list_dir("/")
            .await
            .expect_err("an outdated agent must not browse the session");
        let terminal = TerminalError::RemoteError(err.to_string());
        assert_eq!(
            terminal.code(),
            crate::utils::errors::IpcErrorCode::AgentOutdated,
            "{session_type}: {terminal}"
        );
        assert!(
            terminal.to_string().contains("update the agent"),
            "{session_type}: {terminal}"
        );
        assert!(browser.read_file("/a").await.is_err());
        assert!(browser.write_file("/a", b"x").await.is_err());
        assert!(file_requests(&mock).is_empty(), "{session_type}");

        proxy.disconnect().await.ok();
    }
}

/// A local agent session was browsable before #3242 and keeps working on an
/// older agent.
#[tokio::test]
async fn a_local_session_on_an_older_agent_still_browses() {
    let mock = mock_agent("local", false);
    let mut proxy = connected_proxy(&mock, "local").await;
    let browser = proxy.file_browser().expect("local sessions browse");

    let _ = browser.list_dir("/home").await;
    let sent = file_requests(&mock);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].0, "connection.files.list");
    assert_eq!(sent[0].1["connection_id"], "mock-session-1");

    proxy.disconnect().await.ok();
}
