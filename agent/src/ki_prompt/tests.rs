//! Tests for the agent keyboard-interactive prompt hub (#3375).

use super::*;
use std::time::Duration;

use termihub_core::backends::ssh::keyboard_interactive::KbdInteractivePrompt;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

fn request() -> KbdInteractiveRequest {
    KbdInteractiveRequest {
        host: "bastion".into(),
        port: 2222,
        username: "alice".into(),
        name: "Duo".into(),
        instructions: "Enter your code".into(),
        prompts: vec![KbdInteractivePrompt {
            prompt: "Verification code: ".into(),
            echo: false,
        }],
        round: 2,
        via: None,
    }
}

fn attached_hub() -> (Arc<KiPromptHub>, UnboundedReceiver<JsonRpcNotification>) {
    let hub = KiPromptHub::new();
    let (tx, rx) = unbounded_channel();
    hub.attach_client(tx);
    (hub, rx)
}

async fn next_prompt(
    rx: &mut UnboundedReceiver<JsonRpcNotification>,
) -> KbdInteractivePromptNotification {
    let n = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("prompt notification timed out")
        .expect("channel closed");
    assert_eq!(n.method, SSH_KEYBOARD_INTERACTIVE_PROMPT);
    serde_json::from_value(n.params).unwrap()
}

#[tokio::test]
async fn prompt_round_trip_returns_the_answers() {
    let (hub, mut rx) = attached_hub();
    let asker = hub.clone();
    let asked = tokio::spawn(async move { asker.ask(&request(), Some("s-1".into())).await });

    let prompt = next_prompt(&mut rx).await;
    assert_eq!(prompt.session_id.as_deref(), Some("s-1"));
    assert_eq!(prompt.host, "bastion");
    assert_eq!(prompt.port, 2222);
    assert_eq!(prompt.username, "alice");
    assert_eq!(prompt.name, "Duo");
    assert_eq!(prompt.instructions, "Enter your code");
    assert_eq!(prompt.round, 2);
    assert_eq!(prompt.prompts.len(), 1);
    assert!(!prompt.prompts[0].echo);

    assert!(hub.respond(
        &prompt.request_id,
        Some(vec![Zeroizing::new("123456".into())])
    ));
    match asked.await.unwrap() {
        KbdInteractiveAnswer::Responses(r) => assert_eq!(r[0].as_str(), "123456"),
        KbdInteractiveAnswer::Cancelled => panic!("expected the answer"),
    }
    assert_eq!(hub.pending_count(), 0);
    assert!(rx.try_recv().is_err(), "an answered round is not re-closed");
}

#[tokio::test]
async fn null_answer_cancels() {
    let (hub, mut rx) = attached_hub();
    let asker = hub.clone();
    let asked = tokio::spawn(async move { asker.ask(&request(), None).await });
    let prompt = next_prompt(&mut rx).await;
    assert!(hub.respond(&prompt.request_id, None));
    assert!(matches!(
        asked.await.unwrap(),
        KbdInteractiveAnswer::Cancelled
    ));
}

/// Dropping the waiting future (prompt timeout / abandoned connect) removes the
/// round and tells the desktop to close its dialog; a late answer is stale.
#[tokio::test]
async fn timed_out_round_is_closed_and_late_answer_is_stale() {
    let (hub, mut rx) = attached_hub();
    let timed_out =
        tokio::time::timeout(Duration::from_millis(50), hub.ask(&request(), None)).await;
    assert!(timed_out.is_err());

    let prompt = next_prompt(&mut rx).await;
    let closed = rx.recv().await.unwrap();
    assert_eq!(closed.method, SSH_KEYBOARD_INTERACTIVE_CLOSED);
    assert_eq!(closed.params["requestId"], prompt.request_id);
    assert_eq!(hub.pending_count(), 0);
    assert!(!hub.respond(&prompt.request_id, Some(vec![])));
}

#[tokio::test]
async fn no_desktop_means_unavailable_and_cancelled() {
    let hub = KiPromptHub::new();
    assert!(!hub.is_available());
    assert!(!HubPrompter(hub.clone()).is_available());
    assert!(matches!(
        hub.ask(&request(), None).await,
        KbdInteractiveAnswer::Cancelled
    ));
}

#[tokio::test]
async fn desktop_detaching_mid_prompt_cancels_it() {
    let hub = KiPromptHub::new();
    let (tx, mut rx) = unbounded_channel();
    let generation = hub.attach_client(tx);
    let asker = hub.clone();
    let asked = tokio::spawn(async move { asker.ask(&request(), None).await });
    next_prompt(&mut rx).await;

    hub.detach_client(generation);
    assert!(!hub.is_available());
    assert!(matches!(
        asked.await.unwrap(),
        KbdInteractiveAnswer::Cancelled
    ));
}

/// A stale detach from a replaced desktop must not unhook the new one.
#[test]
fn stale_detach_keeps_the_newer_desktop() {
    let hub = KiPromptHub::new();
    let (tx1, _rx1) = unbounded_channel();
    let (tx2, _rx2) = unbounded_channel();
    let first = hub.attach_client(tx1);
    hub.attach_client(tx2);
    hub.detach_client(first);
    assert!(hub.is_available());
}

#[test]
fn closed_channel_is_unavailable() {
    let hub = KiPromptHub::new();
    let (tx, rx) = unbounded_channel();
    hub.attach_client(tx);
    drop(rx);
    assert!(!hub.is_available());
}

#[test]
fn binding_attaches_only_when_wired() {
    let binding = KiBinding::new();
    assert!(!binding.is_wired());
    assert!(!binding.attach(), "an unwired binding never attaches");

    let hub = KiPromptHub::new();
    let (tx, _rx) = unbounded_channel();
    binding.wire(hub.clone(), tx);
    assert!(binding.attach());
    assert!(hub.is_available());
    binding.detach();
    assert!(!hub.is_available());
}

#[test]
fn prompt_activity_tracks_outstanding_and_recent_prompts() {
    let activity = PromptActivity::new();
    let before = Instant::now();
    std::thread::sleep(Duration::from_millis(2));
    assert!(!activity.active_since(Instant::now()));

    let guard = activity.begin();
    assert!(activity.active_since(Instant::now()), "outstanding counts");
    drop(guard);
    assert!(activity.active_since(before), "finished after `before`");
    std::thread::sleep(Duration::from_millis(2));
    assert!(!activity.active_since(Instant::now()));
}

#[test]
fn secret_bearing_detection_reads_only_the_method() {
    let respond = format!(
        r#"{{"jsonrpc":"2.0","id":7,"method":"{SSH_KEYBOARD_INTERACTIVE_RESPOND}","params":{{"requestId":"r","responses":["x"]}}}}"#
    );
    assert!(is_secret_bearing_request(&respond));
    assert!(!is_secret_bearing_request(
        r#"{"jsonrpc":"2.0","method":"connection.create"}"#
    ));
    assert!(!is_secret_bearing_request("{not json"));
}
