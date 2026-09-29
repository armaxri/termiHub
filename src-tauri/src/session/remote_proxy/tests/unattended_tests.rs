//! Unattended connects of agent-hosted targets (#3877).
//!
//! A scheduled run connects inside core's never-prompt scope. The proxy then
//! asks the agent to connect unattended — `connection.create` with
//! `unattended: true` — but only an agent that advertises `unattendedConnect`
//! (protocol 0.23.0): an older agent would ignore the flag and could prompt,
//! so the connect is refused before anything is created on it.

use super::*;
use termihub_core::backends::ssh::unattended::run_unattended;

fn mock_agent(unattended_connect: Option<bool>) -> Arc<MockAgentRpcClient> {
    let mut mock = MockAgentRpcClient::new();
    mock.unattended_connect = unattended_connect;
    Arc::new(mock)
}

fn ssh_settings() -> serde_json::Value {
    json!({ "type": "ssh", "config": {"host": "server", "authMethod": "key"} })
}

#[tokio::test]
async fn unattended_connect_on_a_new_agent_sends_the_flag() {
    let mock = mock_agent(Some(true));
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    run_unattended(proxy.connect(ssh_settings()))
        .await
        .expect("a 0.23.0+ agent connects unattended");
    assert_eq!(*mock.created_unattended.lock().unwrap(), vec![true]);
}

#[tokio::test]
async fn unattended_connect_on_an_old_agent_is_refused_as_agent_outdated() {
    let mock = mock_agent(Some(false));
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    let err = run_unattended(proxy.connect(ssh_settings()))
        .await
        .expect_err("an old agent is never asked to connect unattended");
    let text = err.to_string();
    assert!(text.contains("[thub-code:agent_outdated]"), "{text}");
    assert!(text.contains(AGENT_TOO_OLD_FOR_UNATTENDED), "{text}");
    assert!(
        mock.created_sessions.lock().unwrap().is_empty(),
        "nothing was created on the agent"
    );
}

/// With no capabilities known the agent is not connected: refused plainly,
/// never as "too old", and nothing is sent.
#[tokio::test]
async fn unattended_connect_on_a_disconnected_agent_is_refused() {
    let mock = mock_agent(None);
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    let err = run_unattended(proxy.connect(ssh_settings()))
        .await
        .expect_err("refused");
    let text = err.to_string();
    assert!(text.contains("not connected"), "{text}");
    assert!(!text.contains("agent_outdated"), "{text}");
    assert!(mock.created_sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn attended_connect_never_sends_the_flag() {
    for caps in [Some(true), Some(false)] {
        let mock = mock_agent(caps);
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
        proxy
            .connect(ssh_settings())
            .await
            .expect("attended connect");
        assert_eq!(*mock.created_unattended.lock().unwrap(), vec![false]);
    }
}
