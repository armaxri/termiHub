//! Unattended `connection.create` (#3877): the agent advertises the
//! `unattendedConnect` capability, routes the `unattended` member to the
//! session manager, reads a create without it (an older desktop) as attended,
//! and relays each typed refusal in the error `data`.

use super::*;
use crate::ki_prompt::relay::ClassifiedConnectFailure;
use termihub_core::errors::ConnectFailureKind;

/// A handler over `session_manager`, which the test keeps to read back.
fn handler_over(session_manager: Arc<MockSessionManager>) -> AgentHandler {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let tmp = std::env::temp_dir().join(format!("termihub-unatt-{}.json", uuid::Uuid::new_v4()));
    let conn_store = Arc::new(ConnectionStore::new_temp(tmp));
    let monitoring = Arc::new(crate::monitoring::MonitoringManager::new(
        tx,
        conn_store.clone(),
    ));
    AgentHandler::new(
        session_manager as Arc<dyn SessionManagerApi>,
        conn_store as Arc<dyn ConnectionStoreApi>,
        monitoring as Arc<dyn MonitoringManagerApi>,
    )
    .unwrap()
}

fn create_params(unattended: Option<bool>) -> Value {
    let mut params = json!({
        "type": "ssh",
        "config": {"host": "bastion", "username": "ops", "authMethod": "key"},
    });
    if let Some(flag) = unattended {
        params["unattended"] = json!(flag);
    }
    params
}

#[tokio::test]
async fn initialize_advertises_unattended_connect() {
    let handler = make_mock_handler();
    let result = dispatch(&handler, "initialize", init_params(), 1).await;
    assert_eq!(result["result"]["capabilities"]["unattendedConnect"], true);
}

#[tokio::test]
async fn an_unattended_create_reaches_the_session_manager_unattended() {
    let mgr = Arc::new(MockSessionManager::new());
    let handler = handler_over(mgr.clone());
    init_handler(&handler).await;

    let result = dispatch(&handler, "connection.create", create_params(Some(true)), 2).await;
    assert!(result.get("result").is_some(), "create failed: {result}");
    assert_eq!(*mgr.unattended_seen.lock().await, vec![true]);
}

/// An older desktop never sends the member, and a new desktop sends it only
/// when set: both read as an attended create.
#[tokio::test]
async fn a_create_without_the_flag_stays_attended() {
    let mgr = Arc::new(MockSessionManager::new());
    let handler = handler_over(mgr.clone());
    init_handler(&handler).await;

    dispatch(&handler, "connection.create", create_params(None), 2).await;
    dispatch(&handler, "connection.create", create_params(Some(false)), 3).await;
    assert_eq!(*mgr.unattended_seen.lock().await, vec![false, false]);
}

/// Each refusal of an unattended connect reaches the desktop typed, in the
/// `connection.create` error `data`.
#[tokio::test]
async fn unattended_refusals_are_relayed_typed() {
    for kind in [
        ConnectFailureKind::HostKeyUntrusted,
        ConnectFailureKind::InteractionRequired,
        ConnectFailureKind::AuthFailed,
    ] {
        let handler = make_mock_handler_failing(SessionCreateError::ConnectFailed(
            ClassifiedConnectFailure {
                kind,
                message: "refused".to_string(),
            },
        ));
        init_handler(&handler).await;
        let result = dispatch(&handler, "connection.create", create_params(Some(true)), 2).await;
        assert_eq!(
            result["error"]["code"],
            errors::SESSION_CREATION_FAILED,
            "{kind:?}: {result}"
        );
        assert_eq!(
            result["error"]["data"]["connect_failure"],
            kind.code(),
            "{kind:?}: {result}"
        );
    }
}
