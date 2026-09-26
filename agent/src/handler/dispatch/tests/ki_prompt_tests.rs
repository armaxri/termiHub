//! Keyboard-interactive prompt relay through dispatch and the transport loop
//! (#3375): capability negotiation, the respond method, and a full
//! `connection.create` that blocks on an OTP prompt answered over the wire.

use super::*;
use std::time::Duration;

use termihub_core::backends::ssh::keyboard_interactive::{
    KbdInteractiveAnswer, KbdInteractivePrompt, KbdInteractiveRequest,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::io::transport::run_transport_loop_with_priority;
use crate::protocol::messages::JsonRpcNotification;

/// The one-time code the mock server accepts.
const GOOD_CODE: &str = "123456";

fn otp_request() -> KbdInteractiveRequest {
    KbdInteractiveRequest {
        host: "bastion".into(),
        port: 22,
        username: "alice".into(),
        name: String::new(),
        instructions: "Enter the code from your app".into(),
        prompts: vec![KbdInteractivePrompt {
            prompt: "Verification code: ".into(),
            echo: false,
        }],
        round: 1,
        via: None,
    }
}

/// Stand-in for an SSH connect whose server asks one OTP round after the
/// password was accepted: cancel → `AuthCancelled`, wrong code →
/// `SecondFactorFailed`, like the real core exchange.
pub(super) async fn mock_otp_round(hub: &KiPromptHub) -> Result<(), SessionCreateError> {
    match hub.ask(&otp_request(), Some("sess-1".into())).await {
        KbdInteractiveAnswer::Cancelled => Err(SessionCreateError::AuthCancelled(
            "Authentication was cancelled".into(),
        )),
        KbdInteractiveAnswer::Responses(r) if r.len() == 1 && r[0].as_str() == GOOD_CODE => Ok(()),
        KbdInteractiveAnswer::Responses(_) => Err(SessionCreateError::SecondFactorFailed(
            "second factor rejected".into(),
        )),
    }
}

fn handler_with(
    session_manager: Arc<dyn SessionManagerApi>,
) -> (
    AgentHandler,
    tokio::sync::mpsc::UnboundedSender<JsonRpcNotification>,
) {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let tmp = std::env::temp_dir().join(format!("termihub-ki-{}.json", uuid::Uuid::new_v4()));
    let conn_store = Arc::new(ConnectionStore::new_temp(tmp));
    let monitoring = Arc::new(crate::monitoring::MonitoringManager::new(
        tx.clone(),
        conn_store.clone(),
    ));
    let handler = AgentHandler::new(
        session_manager,
        conn_store as Arc<dyn ConnectionStoreApi>,
        monitoring as Arc<dyn MonitoringManagerApi>,
    )
    .unwrap();
    (handler, tx)
}

/// A handler wired to `hub` with a fresh priority channel.
fn wired_handler(
    hub: Arc<KiPromptHub>,
) -> (
    AgentHandler,
    tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>,
) {
    let (handler, _) = handler_with(Arc::new(MockSessionManager::with_ki_prompt(hub.clone())));
    let (priority_tx, priority_rx) = tokio::sync::mpsc::unbounded_channel();
    (handler.with_ki_prompt_relay(hub, priority_tx), priority_rx)
}

fn capable_init_params() -> Value {
    json!({
        "protocolVersion": AGENT_PROTOCOL_VERSION,
        "client": "test",
        "clientVersion": "0.1.0",
        "clientCapabilities": {"keyboardInteractivePrompts": true},
    })
}

#[tokio::test]
async fn unwired_handler_does_not_advertise_prompt_relay() {
    let handler = make_mock_handler();
    let result = dispatch(&handler, "initialize", capable_init_params(), 1).await;
    assert_eq!(
        result["result"]["capabilities"]["keyboardInteractivePrompts"],
        false
    );
}

#[tokio::test]
async fn wired_handler_advertises_prompt_relay() {
    let (handler, _rx) = wired_handler(KiPromptHub::new());
    let result = dispatch(&handler, "initialize", capable_init_params(), 1).await;
    assert_eq!(
        result["result"]["capabilities"]["keyboardInteractivePrompts"],
        true
    );
}

/// An older desktop never advertises support, so the hub stays unavailable and
/// core keeps the auto-answer-only behavior.
#[tokio::test]
async fn old_desktop_does_not_attach_the_hub() {
    let hub = KiPromptHub::new();
    let (handler, _rx) = wired_handler(hub.clone());
    init_handler(&handler).await;
    assert!(!hub.is_available());
}

#[tokio::test]
async fn capable_desktop_attaches_and_disconnect_detaches() {
    let hub = KiPromptHub::new();
    let (handler, _rx) = wired_handler(hub.clone());
    dispatch(&handler, "initialize", capable_init_params(), 1).await;
    assert!(hub.is_available());

    handler.deregister_client();
    assert!(!hub.is_available());
}

#[tokio::test]
async fn respond_resolves_the_waiting_round() {
    let hub = KiPromptHub::new();
    let (handler, mut priority_rx) = wired_handler(hub.clone());
    dispatch(&handler, "initialize", capable_init_params(), 1).await;

    let asker = hub.clone();
    let asked = tokio::spawn(async move { asker.ask(&otp_request(), None).await });
    let notification = priority_rx.recv().await.unwrap();
    assert_eq!(notification.method, pm::SSH_KEYBOARD_INTERACTIVE_PROMPT);
    let request_id = notification.params["requestId"]
        .as_str()
        .unwrap()
        .to_string();

    let result = dispatch(
        &handler,
        pm::SSH_KEYBOARD_INTERACTIVE_RESPOND,
        json!({"requestId": request_id, "responses": [GOOD_CODE]}),
        2,
    )
    .await;
    assert_eq!(result["result"]["accepted"], true);
    match asked.await.unwrap() {
        KbdInteractiveAnswer::Responses(r) => assert_eq!(r[0].as_str(), GOOD_CODE),
        KbdInteractiveAnswer::Cancelled => panic!("expected the answer"),
    }
}

#[tokio::test]
async fn respond_to_unknown_round_is_not_accepted() {
    let (handler, _rx) = wired_handler(KiPromptHub::new());
    dispatch(&handler, "initialize", capable_init_params(), 1).await;
    let result = dispatch(
        &handler,
        pm::SSH_KEYBOARD_INTERACTIVE_RESPOND,
        json!({"requestId": "nope", "responses": null}),
        2,
    )
    .await;
    assert_eq!(result["result"]["accepted"], false);
}

#[tokio::test]
async fn respond_requires_initialize() {
    let (handler, _rx) = wired_handler(KiPromptHub::new());
    let result = dispatch(
        &handler,
        pm::SSH_KEYBOARD_INTERACTIVE_RESPOND,
        json!({"requestId": "r", "responses": null}),
        1,
    )
    .await;
    assert_eq!(result["error"]["code"], errors::NOT_INITIALIZED);
}

/// A malformed respond must not echo the secret back in the error message.
#[tokio::test]
async fn respond_parse_error_does_not_echo_the_answer() {
    let (handler, _rx) = wired_handler(KiPromptHub::new());
    dispatch(&handler, "initialize", capable_init_params(), 1).await;
    let result = dispatch(
        &handler,
        pm::SSH_KEYBOARD_INTERACTIVE_RESPOND,
        json!({"requestId": 5, "responses": ["s3cret-otp"]}),
        2,
    )
    .await;
    assert_eq!(result["error"]["code"], errors::INVALID_PARAMS);
    assert!(!result.to_string().contains("s3cret-otp"));
}

// ── Full round trip through the transport loop ─────────────────────

/// Drive a wired handler over an in-memory NDJSON pipe.
struct Wire {
    lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
    writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    shutdown: CancellationToken,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl Wire {
    fn start() -> Self {
        let hub = KiPromptHub::new();
        let (handler, mut priority_rx) = wired_handler(hub);
        let (_notif_tx, mut notif_rx) = tokio::sync::mpsc::unbounded_channel();
        let (client, server) = tokio::io::duplex(64 * 1024);
        let (server_rd, mut server_wr) = tokio::io::split(server);
        let (client_rd, writer) = tokio::io::split(client);
        let shutdown = CancellationToken::new();
        let loop_shutdown = shutdown.clone();
        let task = tokio::spawn(async move {
            let _keep_notif_tx = _notif_tx;
            let mut reader = BufReader::new(server_rd);
            run_transport_loop_with_priority(
                &mut reader,
                &mut server_wr,
                &handler,
                &mut notif_rx,
                &mut priority_rx,
                loop_shutdown,
            )
            .await
        });
        Self {
            lines: BufReader::new(client_rd).lines(),
            writer,
            shutdown,
            task,
        }
    }

    async fn send(&mut self, method: &str, params: Value, id: u64) {
        let line = json!({"jsonrpc": "2.0", "method": method, "params": params, "id": id});
        self.writer
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(10), self.lines.next_line())
            .await
            .expect("agent output timed out")
            .unwrap()
            .expect("agent output closed");
        serde_json::from_str(&line).unwrap()
    }

    async fn initialize(&mut self) {
        self.send("initialize", capable_init_params(), 1).await;
        let init = self.next().await;
        assert!(init.get("result").is_some(), "init failed: {init}");
    }

    /// Start a create, then read the prompt the agent relays while it is still
    /// in flight — the regression this relay needs: the loop must not wait for
    /// the create to finish before writing the prompt.
    async fn create_and_read_prompt(&mut self) -> String {
        self.send(
            pm::CONNECTION_CREATE,
            json!({"type": "local", "config": {}}),
            2,
        )
        .await;
        let prompt = self.next().await;
        assert_eq!(prompt["method"], pm::SSH_KEYBOARD_INTERACTIVE_PROMPT);
        assert_eq!(prompt["params"]["sessionId"], "sess-1");
        assert_eq!(prompt["params"]["host"], "bastion");
        assert_eq!(
            prompt["params"]["prompts"][0]["prompt"],
            "Verification code: "
        );
        assert_eq!(prompt["params"]["prompts"][0]["echo"], false);
        prompt["params"]["requestId"].as_str().unwrap().to_string()
    }

    async fn stop(self) {
        self.shutdown.cancel();
        drop(self.writer);
        let _ = self.task.await;
    }
}

#[tokio::test]
async fn create_waits_for_the_prompt_answer_and_keeps_request_order() {
    let mut wire = Wire::start();
    wire.initialize().await;
    let request_id = wire.create_and_read_prompt().await;

    // A request sent while the create is in flight is held back and answered
    // after it; the respond is dispatched at once.
    wire.send(pm::HEALTH_CHECK, json!({}), 3).await;
    wire.send(
        pm::SSH_KEYBOARD_INTERACTIVE_RESPOND,
        json!({"requestId": request_id, "responses": [GOOD_CODE]}),
        4,
    )
    .await;

    let respond = wire.next().await;
    assert_eq!(respond["id"], 4);
    assert_eq!(respond["result"]["accepted"], true);
    let create = wire.next().await;
    assert_eq!(create["id"], 2);
    assert!(create.get("result").is_some(), "create failed: {create}");
    let health = wire.next().await;
    assert_eq!(health["id"], 3);
    wire.stop().await;
}

#[tokio::test]
async fn cancelled_prompt_fails_create_with_auth_cancelled() {
    let mut wire = Wire::start();
    wire.initialize().await;
    let request_id = wire.create_and_read_prompt().await;
    wire.send(
        pm::SSH_KEYBOARD_INTERACTIVE_RESPOND,
        json!({"requestId": request_id, "responses": null}),
        3,
    )
    .await;

    assert_eq!(wire.next().await["id"], 3);
    let create = wire.next().await;
    assert_eq!(create["error"]["code"], errors::AUTH_CANCELLED);
    wire.stop().await;
}

#[tokio::test]
async fn wrong_code_fails_create_with_second_factor_failed() {
    let mut wire = Wire::start();
    wire.initialize().await;
    let request_id = wire.create_and_read_prompt().await;
    wire.send(
        pm::SSH_KEYBOARD_INTERACTIVE_RESPOND,
        json!({"requestId": request_id, "responses": ["000000"]}),
        3,
    )
    .await;

    assert_eq!(wire.next().await["id"], 3);
    let create = wire.next().await;
    assert_eq!(create["error"]["code"], errors::SECOND_FACTOR_FAILED);
    wire.stop().await;
}

#[test]
fn respond_requests_are_recognised_as_secret_bearing() {
    let respond = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": pm::SSH_KEYBOARD_INTERACTIVE_RESPOND,
        "params": {"requestId": "r", "responses": ["x"]},
    })
    .to_string();
    assert!(is_secret_bearing_request(&respond));
    assert!(!is_secret_bearing_request(
        &json!({"jsonrpc": "2.0", "id": 1, "method": "health.check"}).to_string()
    ));
    assert!(!is_secret_bearing_request("not json"));
}
