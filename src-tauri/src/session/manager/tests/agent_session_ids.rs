//! #5960: the frontend marks the agent's "Active sessions" row an open tab
//! shows, so it needs each tab's agent session id. The tab knows only its
//! desktop session id; `agent_session_ids` maps those to the agent's ids.

use super::*;

#[tokio::test]
async fn maps_agent_hosted_sessions_to_their_agent_session_ids() {
    let (manager, _agent) = make_test_manager_with_retain_agent();
    let agent_tab = open_agent_tab(&manager, "tab-a:0", true).await;
    let direct = manager
        .create_connection(
            "mock",
            serde_json::json!({}),
            None,
            Some("tab-d:0"),
            false,
            false,
            MockEventEmitter::new(),
        )
        .await
        .expect("direct session opens");

    let ids = manager
        .agent_session_ids(&[
            agent_tab.clone(),
            direct.clone(),
            "gone-session".to_string(),
        ])
        .await;

    let remote = manager
        .sessions
        .lock()
        .await
        .get(&agent_tab)
        .and_then(|entry| entry.remote_session_id.clone())
        .expect("the agent session has an agent id");
    assert_eq!(ids.get(&agent_tab), Some(&remote));
    assert!(!ids.contains_key(&direct), "a direct session has none");
    assert!(!ids.contains_key("gone-session"), "an unknown id is skipped");
    assert_eq!(ids.len(), 1);
}
