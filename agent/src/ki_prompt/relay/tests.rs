//! Tests for the daemon ↔ worker prompt relay (#3375).

use super::*;
use crate::protocol::messages::JsonRpcNotification;
use termihub_core::protocol::methods::{
    KbdInteractivePromptNotification, SSH_KEYBOARD_INTERACTIVE_CLOSED,
    SSH_KEYBOARD_INTERACTIVE_PROMPT,
};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

fn request() -> KbdInteractiveRequest {
    KbdInteractiveRequest {
        host: "bastion".into(),
        port: 22,
        username: "alice".into(),
        name: String::new(),
        instructions: "Enter the code".into(),
        prompts: vec![KbdInteractivePrompt {
            prompt: "Verification code: ".into(),
            echo: false,
        }],
        round: 1,
        via: None,
    }
}

/// A hub with a desktop attached, plus a started relay on a unique endpoint.
async fn relay() -> (
    Arc<KiPromptHub>,
    UnboundedReceiver<JsonRpcNotification>,
    KiRelaySession,
) {
    let hub = KiPromptHub::new();
    let (tx, rx) = unbounded_channel();
    hub.attach_client(tx);
    let session_id = format!("ki-test-{}", uuid::Uuid::new_v4());
    let endpoint = crate::daemon::transport::ki_prompt_endpoint(&session_id);
    let relay = KiRelaySession::start(hub.clone(), &session_id, endpoint)
        .await
        .expect("relay binds");
    (hub, rx, relay)
}

async fn next(rx: &mut UnboundedReceiver<JsonRpcNotification>) -> JsonRpcNotification {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("notification timed out")
        .expect("channel closed")
}

#[tokio::test]
async fn daemon_round_reaches_the_desktop_and_the_answer_comes_back() {
    let (hub, mut rx, relay) = relay().await;
    let prompter = DaemonRelayPrompter::new(relay.endpoint().to_string());
    let asked = tokio::spawn(async move { prompter.prompt(&request()).await });

    let n = next(&mut rx).await;
    assert_eq!(n.method, SSH_KEYBOARD_INTERACTIVE_PROMPT);
    let prompt: KbdInteractivePromptNotification = serde_json::from_value(n.params).unwrap();
    assert!(
        prompt
            .session_id
            .as_deref()
            .unwrap()
            .starts_with("ki-test-"),
        "the round names the agent session being created"
    );
    assert_eq!(prompt.prompts[0].prompt, "Verification code: ");
    assert!(
        relay.activity().active_since(std::time::Instant::now()),
        "an outstanding round keeps the launch's connect wait alive"
    );

    assert!(hub.respond(
        &prompt.request_id,
        Some(vec![Zeroizing::new("123456".into())])
    ));
    match asked.await.unwrap() {
        KbdInteractiveAnswer::Responses(r) => assert_eq!(r[0].as_str(), "123456"),
        KbdInteractiveAnswer::Cancelled => panic!("expected the answer"),
    }
}

#[tokio::test]
async fn desktop_cancel_reaches_the_daemon() {
    let (hub, mut rx, relay) = relay().await;
    let prompter = DaemonRelayPrompter::new(relay.endpoint().to_string());
    let asked = tokio::spawn(async move { prompter.prompt(&request()).await });
    let prompt: KbdInteractivePromptNotification =
        serde_json::from_value(next(&mut rx).await.params).unwrap();
    assert!(hub.respond(&prompt.request_id, None));
    assert!(matches!(
        asked.await.unwrap(),
        KbdInteractiveAnswer::Cancelled
    ));
}

/// The daemon's core prompt timeout drops the exchange: the worker must drop
/// the round and close the desktop's dialog.
#[tokio::test]
async fn daemon_giving_up_closes_the_desktop_dialog() {
    let (hub, mut rx, relay) = relay().await;
    let prompter = DaemonRelayPrompter::new(relay.endpoint().to_string());
    let gave_up =
        tokio::time::timeout(Duration::from_millis(300), prompter.prompt(&request())).await;
    assert!(gave_up.is_err());

    let prompt: KbdInteractivePromptNotification =
        serde_json::from_value(next(&mut rx).await.params).unwrap();
    let closed = next(&mut rx).await;
    assert_eq!(closed.method, SSH_KEYBOARD_INTERACTIVE_CLOSED);
    assert_eq!(closed.params["requestId"], prompt.request_id);
    assert!(!hub.respond(&prompt.request_id, Some(vec![])));
}

#[tokio::test]
async fn typed_failures_are_reported_to_the_worker() {
    let (_hub, _rx, relay) = relay().await;
    report_connect_failure(relay.endpoint(), &SessionError::SecondFactorFailed).await;
    assert_eq!(relay.failure(), Some(KiFailureKind::SecondFactorFailed));

    report_connect_failure(relay.endpoint(), &SessionError::AuthCancelled).await;
    assert_eq!(relay.failure(), Some(KiFailureKind::AuthCancelled));
}

#[tokio::test]
async fn untyped_failures_are_not_reported() {
    let (_hub, _rx, relay) = relay().await;
    report_connect_failure(relay.endpoint(), &SessionError::AuthFailed).await;
    assert_eq!(relay.failure(), None);
}

/// With no worker listening the prompter must not hang or panic.
#[tokio::test]
async fn unreachable_worker_resolves_as_cancel() {
    let endpoint =
        crate::daemon::transport::ki_prompt_endpoint(&format!("ki-none-{}", uuid::Uuid::new_v4()));
    let prompter = DaemonRelayPrompter::new(endpoint);
    let answer = tokio::time::timeout(Duration::from_secs(10), prompter.prompt(&request()))
        .await
        .expect("must fail, not hang");
    assert!(matches!(answer, KbdInteractiveAnswer::Cancelled));
}

#[test]
fn relay_prompt_round_trips_the_request() {
    let original = request();
    let back = RelayPrompt::from_request(&original).into_request();
    assert_eq!(back, original);
}

#[test]
fn connect_failure_displays_the_core_message() {
    assert_eq!(
        KiConnectFailure(KiFailureKind::AuthCancelled).to_string(),
        SessionError::AuthCancelled.to_string()
    );
    assert_eq!(
        KiFailureKind::from_session_error(&SessionError::SecondFactorFailed),
        Some(KiFailureKind::SecondFactorFailed)
    );
    assert_eq!(
        KiFailureKind::from_session_error(&SessionError::AuthFailed),
        None
    );
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_the_relay_removes_its_endpoint() {
    let (_hub, _rx, relay) = relay().await;
    let path = relay.endpoint().to_string();
    assert!(std::path::Path::new(&path).exists());
    drop(relay);
    assert!(!std::path::Path::new(&path).exists());
}
