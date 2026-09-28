//! Per-RPC authorization of the agent-update RPCs (AGT-003 / SEC-006, #3213):
//! `agent.request_update` / `agent.request_deferred_update` require this agent
//! instance's update auth token on top of `initialize`, and a
//! matched-downgrade pin must equal the requesting desktop's own version.
//! Driven against the mock session manager, so a request that passes the gate
//! reports `applied: true`.

use super::*;

const TOKEN: &str = "per-instance-update-token";
const UPDATE_METHODS: [&str; 2] = [pm::AGENT_REQUEST_UPDATE, pm::AGENT_REQUEST_DEFERRED_UPDATE];

/// A mock-backed handler gated by [`TOKEN`], initialized as desktop 0.1.0
/// (see `init_params`).
async fn authorized_handler() -> AgentHandler {
    let handler = make_mock_handler().with_update_auth(UpdateAuth::for_test(TOKEN));
    init_handler(&handler).await;
    handler
}

fn error_code(response: &Value) -> Option<i64> {
    response["error"]["code"].as_i64()
}

#[tokio::test]
async fn update_rpcs_without_a_token_are_refused() {
    let handler = authorized_handler().await;
    for method in UPDATE_METHODS {
        let result = dispatch(&handler, method, json!({}), 2).await;
        assert_eq!(
            error_code(&result),
            Some(errors::UPDATE_UNAUTHORIZED),
            "{method} without a token must be refused: {result}"
        );
    }
}

#[tokio::test]
async fn update_rpcs_with_a_wrong_token_are_refused() {
    let handler = authorized_handler().await;
    for method in UPDATE_METHODS {
        for wrong in ["", "per-instance-update-tokeN", "nope"] {
            let result = dispatch(&handler, method, json!({ "authToken": wrong }), 2).await;
            assert_eq!(
                error_code(&result),
                Some(errors::UPDATE_UNAUTHORIZED),
                "{method} with token {wrong:?} must be refused: {result}"
            );
        }
    }
}

/// Fail closed: a handler that no transport gave a token refuses every update,
/// whatever the caller presents.
#[tokio::test]
async fn a_handler_without_a_configured_token_refuses_every_update() {
    let handler = make_mock_handler();
    init_handler(&handler).await;
    for method in UPDATE_METHODS {
        let result = dispatch(&handler, method, json!({ "authToken": TOKEN }), 2).await;
        assert_eq!(
            error_code(&result),
            Some(errors::UPDATE_UNAUTHORIZED),
            "{method}: {result}"
        );
    }
}

/// The `initialized` gate still comes first.
#[tokio::test]
async fn an_uninitialized_caller_is_refused_even_with_the_token() {
    let handler = make_mock_handler().with_update_auth(UpdateAuth::for_test(TOKEN));
    for method in UPDATE_METHODS {
        let result = dispatch(&handler, method, json!({ "authToken": TOKEN }), 2).await;
        assert_eq!(
            error_code(&result),
            Some(errors::NOT_INITIALIZED),
            "{method}"
        );
    }
}

#[tokio::test]
async fn update_rpcs_with_the_right_token_proceed() {
    for method in UPDATE_METHODS {
        let handler = authorized_handler().await;
        let result = dispatch(&handler, method, json!({ "authToken": TOKEN }), 2).await;
        assert_eq!(
            result["result"]["applied"], true,
            "{method} with the right token must reach the apply: {result}"
        );
    }
}

#[tokio::test]
async fn a_pin_that_is_not_the_desktop_version_is_refused() {
    let handler = authorized_handler().await;
    for method in UPDATE_METHODS {
        for pin in ["0.0.9", "0.2.0", "garbage"] {
            let result = dispatch(
                &handler,
                method,
                json!({ "authToken": TOKEN, "binaryPath": "/tmp/x", "pinnedVersion": pin }),
                2,
            )
            .await;
            assert_eq!(
                error_code(&result),
                Some(errors::UPDATE_DOWNGRADE_REFUSED),
                "{method} pinned to {pin} by desktop 0.1.0 must be refused: {result}"
            );
        }
    }
}

#[tokio::test]
async fn a_pin_matching_the_desktop_version_proceeds() {
    for method in UPDATE_METHODS {
        let handler = authorized_handler().await;
        let result = dispatch(
            &handler,
            method,
            json!({ "authToken": TOKEN, "binaryPath": "/tmp/x", "pinnedVersion": "0.1.0" }),
            2,
        )
        .await;
        assert_eq!(result["result"]["applied"], true, "{method}: {result}");
    }
}

/// The token check runs before the pin check: an unauthorized caller learns
/// nothing about the pin policy.
#[tokio::test]
async fn the_token_is_checked_before_the_pin() {
    let handler = authorized_handler().await;
    let result = dispatch(
        &handler,
        pm::AGENT_REQUEST_UPDATE,
        json!({ "authToken": "wrong", "pinnedVersion": "9.9.9" }),
        2,
    )
    .await;
    assert_eq!(error_code(&result), Some(errors::UPDATE_UNAUTHORIZED));
}

#[tokio::test]
async fn initialize_advertises_the_token_path_only_when_configured() {
    let gated = make_mock_handler().with_update_auth(UpdateAuth::for_test(TOKEN));
    let result = dispatch(&gated, "initialize", init_params(), 1).await;
    assert_eq!(
        result["result"]["update_auth_token_path"],
        "/test/instance-auth/0.token"
    );
    assert!(
        !result.to_string().contains(TOKEN),
        "initialize must advertise the path, never the token"
    );

    let ungated = make_mock_handler();
    let result = dispatch(&ungated, "initialize", init_params(), 1).await;
    assert!(result["result"].get("update_auth_token_path").is_none());
}

#[test]
fn a_refused_downgrade_maps_to_its_own_error_code() {
    let err = map_deferred_update_error(DeferredUpdateError::DowngradeRefused(
        crate::update::VersionPolicyError::Downgrade {
            current: "0.5.0".into(),
            candidate: "0.4.0".into(),
        },
    ));
    assert_eq!(err.code() as i64, errors::UPDATE_DOWNGRADE_REFUSED);
    assert!(err.message().contains("downgrade"));
}
