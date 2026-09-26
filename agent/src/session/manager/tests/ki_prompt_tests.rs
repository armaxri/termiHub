//! Keyboard-interactive prompt relay through daemon launches (#3375): the
//! manager starts the per-session relay only for a prompt-capable desktop, and
//! a daemon's typed connect failure surfaces as a typed create error.

use super::*;
use crate::ki_prompt::relay::{report_connect_failure, DaemonRelayPrompter};
use crate::session::types::SessionBackend;
use termihub_core::backends::ssh::keyboard_interactive::{
    KbdInteractiveAnswer, KbdInteractivePrompt, KbdInteractiveRequest, KeyboardInteractivePrompter,
};
use termihub_core::errors::SessionError;

/// Stands in for a session daemon whose SSH server asks one OTP round: it
/// relays the round through the exported endpoint, reports a cancel / wrong
/// code the way the real daemon does, then "exits".
#[derive(Default)]
struct PromptingLauncher {
    saw_relay: Arc<std::sync::Mutex<Vec<bool>>>,
}

#[async_trait::async_trait]
impl DaemonLauncher for PromptingLauncher {
    async fn launch(
        &self,
        _session_id: &str,
        _type_id: &str,
        _settings: &serde_json::Value,
        _notification_tx: NotificationSender,
        _buffer_size_bytes: usize,
        extras: LaunchExtras,
    ) -> Result<SessionBackend, anyhow::Error> {
        self.saw_relay
            .lock()
            .unwrap()
            .push(extras.ki_prompt.is_some());
        let Some(ki) = extras.ki_prompt else {
            return Ok(SessionBackend::Stub {
                alive: Arc::new(AtomicBool::new(true)),
            });
        };
        let request = KbdInteractiveRequest {
            host: "bastion".into(),
            port: 22,
            username: "alice".into(),
            name: String::new(),
            instructions: String::new(),
            prompts: vec![KbdInteractivePrompt {
                prompt: "Verification code: ".into(),
                echo: false,
            }],
            round: 1,
            via: None,
        };
        let failure = match DaemonRelayPrompter::new(ki.endpoint.clone())
            .prompt(&request)
            .await
        {
            KbdInteractiveAnswer::Responses(r) if r[0].as_str() == "123456" => None,
            KbdInteractiveAnswer::Responses(_) => Some(SessionError::SecondFactorFailed),
            KbdInteractiveAnswer::Cancelled => Some(SessionError::AuthCancelled),
        };
        match failure {
            None => Ok(SessionBackend::Stub {
                alive: Arc::new(AtomicBool::new(true)),
            }),
            Some(e) => {
                report_connect_failure(&ki.endpoint, &e).await;
                Err(anyhow::anyhow!(
                    "Daemon exited before its endpoint was ready"
                ))
            }
        }
    }
}

const SSH: fn() -> serde_json::Value =
    || serde_json::json!({"host": "bastion", "username": "alice", "authMethod": "password"});

fn manager(hub: Arc<KiPromptHub>) -> (Arc<SessionManager>, Arc<std::sync::Mutex<Vec<bool>>>) {
    let launcher = PromptingLauncher::default();
    let saw_relay = launcher.saw_relay.clone();
    let mgr =
        SessionManager::with_launcher(test_notification_tx(), test_registry(), Arc::new(launcher))
            .with_ki_prompt_hub(hub);
    (Arc::new(mgr), saw_relay)
}

/// Answer the next relayed round with `answer`.
async fn answer_next(
    hub: Arc<KiPromptHub>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<crate::protocol::messages::JsonRpcNotification>,
    answer: Option<&'static str>,
) {
    let n = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("prompt timed out")
        .expect("channel closed");
    let id = n.params["requestId"].as_str().unwrap().to_string();
    assert!(hub.respond(
        &id,
        answer.map(|a| vec![zeroize::Zeroizing::new(a.to_string())])
    ));
}

#[tokio::test]
async fn no_capable_desktop_means_no_relay() {
    let (mgr, saw_relay) = manager(KiPromptHub::new());
    mgr.create("ssh", "t".into(), SSH(), None).await.unwrap();
    assert_eq!(*saw_relay.lock().unwrap(), vec![false]);
}

#[tokio::test]
async fn answered_prompt_creates_the_session() {
    let hub = KiPromptHub::new();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    hub.attach_client(tx);
    let (mgr, saw_relay) = manager(hub.clone());

    let answering = tokio::spawn(answer_next(hub, rx, Some("123456")));
    mgr.create("ssh", "t".into(), SSH(), None).await.unwrap();
    answering.await.unwrap();
    assert_eq!(*saw_relay.lock().unwrap(), vec![true]);
}

#[tokio::test]
async fn cancelled_prompt_is_a_typed_create_error() {
    let hub = KiPromptHub::new();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    hub.attach_client(tx);
    let (mgr, _) = manager(hub.clone());

    let answering = tokio::spawn(answer_next(hub, rx, None));
    let err = mgr
        .create("ssh", "t".into(), SSH(), None)
        .await
        .unwrap_err();
    answering.await.unwrap();
    assert!(matches!(err, SessionCreateError::AuthCancelled(_)), "{err}");
    assert_eq!(mgr.pending_creates_len_for_test().await, 0);
}

#[tokio::test]
async fn rejected_code_is_a_typed_second_factor_error() {
    let hub = KiPromptHub::new();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    hub.attach_client(tx);
    let (mgr, _) = manager(hub.clone());

    let answering = tokio::spawn(answer_next(hub, rx, Some("000000")));
    let err = mgr
        .create("ssh", "t".into(), SSH(), None)
        .await
        .unwrap_err();
    answering.await.unwrap();
    assert!(
        matches!(err, SessionCreateError::SecondFactorFailed(_)),
        "{err}"
    );
}

#[test]
fn untyped_backend_failures_stay_backend_failed() {
    let err = SessionCreateError::from_backend(anyhow::anyhow!("boom"));
    assert!(matches!(err, SessionCreateError::BackendFailed(ref m) if m == "boom"));
    let err = SessionCreateError::from_backend(anyhow::Error::new(KiConnectFailure(
        KiFailureKind::AuthCancelled,
    )));
    assert!(matches!(err, SessionCreateError::AuthCancelled(_)));
}
