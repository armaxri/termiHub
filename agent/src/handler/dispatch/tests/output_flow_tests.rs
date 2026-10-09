//! `connection.output_flow` (#4416): the agent advertises the `outputFlow`
//! capability and routes the desktop's pause/resume to the session manager,
//! which stops reading that session's output.

use super::*;

#[tokio::test]
async fn initialize_advertises_output_flow() {
    let handler = make_handler();
    let result = dispatch(&handler, "initialize", init_params(), 1).await;
    assert_eq!(result["result"]["capabilities"]["outputFlow"], true);
}

#[tokio::test]
async fn output_flow_pause_and_resume_succeed_for_a_live_session() {
    let (handler, mgr) = make_handler_with_manager();
    init_handler(&handler).await;
    let sid = mgr
        .create_stub_session("local", "flow".to_string(), json!({}))
        .await
        .unwrap()
        .id;

    for (id, paused) in [(2, true), (3, false)] {
        let result = dispatch(
            &handler,
            "connection.output_flow",
            json!({"session_id": sid, "paused": paused}),
            id,
        )
        .await;
        assert!(result.get("result").is_some(), "{result}");
    }
}

#[tokio::test]
async fn output_flow_for_an_unknown_session_is_session_not_found() {
    let handler = make_handler();
    init_handler(&handler).await;
    let result = dispatch(
        &handler,
        "connection.output_flow",
        json!({"session_id": "nonexistent", "paused": true}),
        2,
    )
    .await;
    assert_eq!(result["error"]["code"], errors::SESSION_NOT_FOUND);
}

#[tokio::test]
async fn output_flow_without_paused_is_invalid_params() {
    let handler = make_handler();
    init_handler(&handler).await;
    let result = dispatch(
        &handler,
        "connection.output_flow",
        json!({"session_id": "s"}),
        2,
    )
    .await;
    assert_eq!(result["error"]["code"], errors::INVALID_PARAMS);
}
