//! The negotiated SSH algorithms of agent-hosted sessions (#5896).
//!
//! The proxy asks the agent with `connection.sshAlgorithms`, scoped to the
//! remote session id; a `null` answer, an older agent's method-not-found and
//! a disconnected proxy all report nothing, so the popover falls back.

use super::*;

fn algorithms_requests(mock: &FakeAgent) -> Vec<serde_json::Value> {
    mock.requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m == CONNECTION_SSH_ALGORITHMS)
        .map(|(_, p)| p.clone())
        .collect()
}

async fn connected(mock: &Arc<FakeAgent>) -> RemoteProxy {
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    proxy
        .connect(json!({ "type": "ssh", "config": {"host": "server"} }))
        .await
        .expect("connect should succeed");
    proxy
}

#[tokio::test]
async fn the_agents_answer_reaches_the_session() {
    let mock = Arc::new(proxy_agent(json!(null)).always(
        CONNECTION_SSH_ALGORITHMS,
        Step::Reply(json!({
            "algorithms": {
                "kex": "curve25519-sha256",
                "hostKey": "ssh-ed25519",
                "cipher": "aes256-ctr",
                "mac": "hmac-sha2-256-etm@openssh.com"
            }
        })),
    ));
    let mut proxy = connected(&mock).await;
    let algorithms = proxy.ssh_algorithms().await.expect("the agent knows them");
    assert_eq!(
        algorithms,
        SshNegotiatedAlgorithms::new(
            "curve25519-sha256",
            "ssh-ed25519",
            "aes256-ctr",
            "hmac-sha2-256-etm@openssh.com"
        )
    );
    assert_eq!(
        algorithms_requests(&mock),
        vec![json!({ "session_id": "mock-session-1" })]
    );
    proxy.disconnect().await.ok();
}

#[tokio::test]
async fn a_null_answer_or_an_older_agent_reports_nothing() {
    let null = Arc::new(proxy_agent(json!(null)).always(
        CONNECTION_SSH_ALGORITHMS,
        Step::Reply(json!({ "algorithms": null })),
    ));
    let mut proxy = connected(&null).await;
    assert_eq!(proxy.ssh_algorithms().await, None);
    proxy.disconnect().await.ok();

    let old = Arc::new(
        proxy_agent(json!(null)).always(CONNECTION_SSH_ALGORITHMS, Step::fail("Method not found")),
    );
    let mut proxy = connected(&old).await;
    assert_eq!(
        proxy.ssh_algorithms().await,
        None,
        "method not found falls back"
    );
    proxy.disconnect().await.ok();
}

#[tokio::test]
async fn a_disconnected_proxy_asks_nobody() {
    let mock = Arc::new(proxy_agent(json!(null)));
    let proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    assert_eq!(proxy.ssh_algorithms().await, None);
    assert!(algorithms_requests(&mock).is_empty());
}
