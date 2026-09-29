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

// ── Classified connect failures (#3751) ─────────────────────────────

/// The classified core failures a session daemon's connect can end in — serial
/// not-found / permission / busy and SSH timeout / agent-auth — each with the
/// message the daemon reports alongside the kind.
fn classified_failures() -> Vec<SessionError> {
    use termihub_core::errors::ConnectFailureKind as K;
    vec![
        SessionError::classified(K::NotFound, "Serial port '/dev/ttyX' not found"),
        SessionError::classified(K::PermissionDenied, "Permission denied on '/dev/ttyX'"),
        SessionError::classified(
            K::Busy,
            "Serial port '/dev/ttyX' is already in use by another application",
        ),
        SessionError::classified(K::Timeout, "Connection timed out"),
        SessionError::classified(K::AgentAuthFailed, "SSH agent not reachable"),
    ]
}

#[test]
fn daemon_classifies_each_connect_failure_kind() {
    for error in classified_failures() {
        let report = RelayFailure::from_session_error(&error).expect("typed report");
        assert_eq!(report.kind, None);
        assert_eq!(report.connect_failure, error.connect_failure_kind());
        assert_eq!(report.message.as_deref(), Some(error.to_string().as_str()));
    }
    // Prompt outcomes keep their own member; untyped failures send nothing.
    assert_eq!(
        RelayFailure::from_session_error(&SessionError::AuthCancelled),
        Some(RelayFailure {
            kind: Some(KiFailureKind::AuthCancelled),
            ..RelayFailure::default()
        })
    );
    assert_eq!(
        RelayFailure::from_session_error(&SessionError::SpawnFailed("x".into())),
        None
    );
}

#[tokio::test]
async fn classified_failures_reach_the_worker_as_typed_errors() {
    for error in classified_failures() {
        let (_hub, _rx, relay) = relay().await;
        report_connect_failure(relay.endpoint(), &error).await;
        assert_eq!(relay.failure(), None, "not a prompt outcome");
        let typed = relay.failure_error().expect("typed failure recorded");
        let classified = typed
            .downcast_ref::<ClassifiedConnectFailure>()
            .expect("a classified connect failure");
        assert_eq!(Some(classified.kind), error.connect_failure_kind());
        assert_eq!(classified.message, error.to_string());
    }
}

/// A report in the pre-#3751 shape still parses. One naming a kind this build
/// does not know is rejected, so the worker keeps the generic failure.
#[test]
fn relay_failure_parses_old_and_unknown_shapes() {
    let old: RelayFailure = serde_json::from_str(r#"{"kind":"auth_cancelled"}"#).unwrap();
    assert_eq!(old.kind, Some(KiFailureKind::AuthCancelled));
    assert!(serde_json::from_str::<RelayFailure>(r#"{"connect_failure":"nope"}"#).is_err());
    assert!(RelayFailure::default().into_error().is_none());
}

/// End to end through a real core backend: an agent-hosted serial session on
/// a port that does not exist fails with `NotFound`, and the daemon's report
/// carries it to the worker.
#[cfg(unix)]
#[tokio::test]
async fn real_serial_not_found_is_reported_typed() {
    use termihub_core::errors::ConnectFailureKind;
    let mut connection = crate::registry::build_registry()
        .create("serial")
        .expect("serial backend");
    let error = connection
        .connect(serde_json::json!({ "port": "/dev/__termihub_no_such_port__" }))
        .await
        .expect_err("the port does not exist");
    let (_hub, _rx, relay) = relay().await;
    report_connect_failure(relay.endpoint(), &error).await;
    let typed = relay.failure_error().expect("typed failure recorded");
    let classified = typed.downcast_ref::<ClassifiedConnectFailure>().unwrap();
    assert_eq!(classified.kind, ConnectFailureKind::NotFound);
}

// ── Rejected credentials (#3089) ─────────────────────────────────────

/// A rejected credential is relayed as the `auth_failed` kind, derived from
/// the typed `SessionError::AuthFailed` (never from message text).
#[test]
fn daemon_relays_a_rejected_credential_as_auth_failed() {
    use termihub_core::errors::ConnectFailureKind as K;
    assert_eq!(
        relayed_connect_failure_kind(&SessionError::AuthFailed),
        Some(K::AuthFailed)
    );
    let report = RelayFailure::from_session_error(&SessionError::AuthFailed).expect("typed");
    assert_eq!(report.kind, None);
    assert_eq!(report.connect_failure, Some(K::AuthFailed));
    assert_eq!(report.message.as_deref(), Some("Authentication failed"));
    // A classified kind is passed through unchanged; untyped stays untyped.
    assert_eq!(
        relayed_connect_failure_kind(&SessionError::classified(K::Busy, "held")),
        Some(K::Busy)
    );
    assert_eq!(
        relayed_connect_failure_kind(&SessionError::SpawnFailed("x".into())),
        None
    );
}

#[tokio::test]
async fn a_rejected_credential_reaches_the_worker_typed() {
    use termihub_core::errors::ConnectFailureKind as K;
    let (_hub, _rx, relay) = relay().await;
    report_connect_failure(relay.endpoint(), &SessionError::AuthFailed).await;
    let typed = relay.failure_error().expect("typed failure recorded");
    let classified = typed
        .downcast_ref::<ClassifiedConnectFailure>()
        .expect("a classified connect failure");
    assert_eq!(classified.kind, K::AuthFailed);
}
