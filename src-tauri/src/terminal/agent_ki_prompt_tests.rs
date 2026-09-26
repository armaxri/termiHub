//! Tests for the desktop end of the agent prompt relay (#3375).

use super::*;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::mpsc;

use crate::session::ssh_keyboard_interactive::{
    SshKeyboardInteractiveEventSink, SshKeyboardInteractivePromptClosedEvent,
    SshKeyboardInteractivePromptEvent, SshKeyboardInteractivePrompter,
};

#[derive(Default)]
struct RecordingSink {
    prompts: Mutex<Vec<SshKeyboardInteractivePromptEvent>>,
    closed: Mutex<Vec<String>>,
}

impl SshKeyboardInteractiveEventSink for RecordingSink {
    fn emit_prompt(&self, event: &SshKeyboardInteractivePromptEvent) {
        self.prompts.lock().unwrap().push(event.clone());
    }
    fn emit_closed(&self, event: &SshKeyboardInteractivePromptClosedEvent) {
        self.closed.lock().unwrap().push(event.prompt_id.clone());
    }
}

type Answers = mpsc::UnboundedReceiver<(String, Option<Vec<String>>)>;

/// A relay wired to the real desktop dialog prompter (with a recording event
/// sink) and a recorder standing in for the agent I/O channel.
fn setup() -> (
    AgentKiPromptRelay,
    Arc<SshKeyboardInteractivePrompter>,
    Arc<RecordingSink>,
    Answers,
    Arc<AgentPromptActivity>,
) {
    let sink = Arc::new(RecordingSink::default());
    let prompter = Arc::new(SshKeyboardInteractivePrompter::new(sink.clone()));
    let (tx, rx) = mpsc::unbounded_channel();
    let respond: RespondFn = Arc::new(move |id, responses: KiResponses| {
        let plain = responses.map(|r| r.iter().map(|s| s.to_string()).collect());
        let _ = tx.send((id, plain));
    });
    let activity = AgentPromptActivity::new();
    let relay = AgentKiPromptRelay::new(
        "agent.example".into(),
        Some(prompter.clone() as Arc<dyn KeyboardInteractivePrompter>),
        respond,
        activity.clone(),
    );
    (relay, prompter, sink, rx, activity)
}

fn prompt_params(request_id: &str) -> Value {
    json!({
        "requestId": request_id,
        "sessionId": "s-1",
        "host": "bastion",
        "port": 22,
        "username": "alice",
        "name": "",
        "instructions": "Enter the code",
        "prompts": [{"prompt": "Verification code: ", "echo": false}],
        "round": 1,
    })
}

async fn shown(sink: &RecordingSink) -> SshKeyboardInteractivePromptEvent {
    loop {
        if let Some(p) = sink.prompts.lock().unwrap().last() {
            return p.clone();
        }
        tokio::task::yield_now().await;
    }
}

/// The agent's notification opens the same dialog event as a direct SSH
/// prompt — labelled with the agent — and the answer goes back to the agent.
#[tokio::test]
async fn prompt_notification_reaches_the_dialog_and_the_answer_the_agent() {
    let (relay, prompter, sink, mut answers, activity) = setup();
    assert!(relay.handle_notification(SSH_KEYBOARD_INTERACTIVE_PROMPT, &prompt_params("r-1")));

    let event = shown(&sink).await;
    assert_eq!(event.host, "bastion");
    assert_eq!(event.username, "alice");
    assert_eq!(event.via.as_deref(), Some("agent.example"));
    assert_eq!(event.prompts[0].prompt, "Verification code: ");
    assert!(!event.prompts[0].echo);
    assert!(
        activity
            .deadline(Instant::now(), Duration::from_secs(1))
            .is_none(),
        "an open prompt suspends request timeouts"
    );

    assert!(prompter.resolve(&event.prompt_id, Some(vec!["123456".into()])));
    let (id, responses) = answers.recv().await.unwrap();
    assert_eq!(id, "r-1");
    assert_eq!(responses, Some(vec!["123456".to_string()]));
    assert_eq!(relay.open_rounds(), 0);
}

#[tokio::test]
async fn dialog_cancel_is_sent_as_null() {
    let (relay, prompter, sink, mut answers, _) = setup();
    relay.handle_notification(SSH_KEYBOARD_INTERACTIVE_PROMPT, &prompt_params("r-2"));
    let event = shown(&sink).await;
    assert!(prompter.resolve(&event.prompt_id, None));
    assert_eq!(answers.recv().await.unwrap(), ("r-2".to_string(), None));
}

/// The agent abandoned the round (timeout / connect gone): close the dialog
/// and send nothing.
#[tokio::test]
async fn closed_notification_closes_the_dialog() {
    let (relay, _prompter, sink, mut answers, _) = setup();
    relay.handle_notification(SSH_KEYBOARD_INTERACTIVE_PROMPT, &prompt_params("r-3"));
    let event = shown(&sink).await;

    assert!(relay.handle_notification(
        SSH_KEYBOARD_INTERACTIVE_CLOSED,
        &json!({"requestId": "r-3"})
    ));
    for _ in 0..100 {
        if !sink.closed.lock().unwrap().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(*sink.closed.lock().unwrap(), vec![event.prompt_id]);
    assert!(
        answers.try_recv().is_err(),
        "an abandoned round is not answered"
    );
}

/// The agent connection dropped / was torn down: every open dialog closes.
#[tokio::test]
async fn dropping_the_relay_closes_open_dialogs() {
    let (relay, _prompter, sink, _answers, _) = setup();
    relay.handle_notification(SSH_KEYBOARD_INTERACTIVE_PROMPT, &prompt_params("r-4"));
    shown(&sink).await;
    drop(relay);
    for _ in 0..100 {
        if !sink.closed.lock().unwrap().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(sink.closed.lock().unwrap().len(), 1);
}

/// No dialog prompter registered (headless) → the round is cancelled at once.
#[tokio::test]
async fn without_a_prompter_rounds_are_cancelled() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let respond: RespondFn = Arc::new(move |id, responses: KiResponses| {
        let _ = tx.send((id, responses.is_some()));
    });
    let relay = AgentKiPromptRelay::new("a".into(), None, respond, AgentPromptActivity::new());
    relay.handle_notification(SSH_KEYBOARD_INTERACTIVE_PROMPT, &prompt_params("r-5"));
    assert_eq!(rx.recv().await.unwrap(), ("r-5".to_string(), false));
}

/// An unavailable prompter is treated like none.
#[tokio::test]
async fn unavailable_prompter_cancels() {
    struct Unavailable;
    #[async_trait]
    impl KeyboardInteractivePrompter for Unavailable {
        async fn prompt(&self, _r: &KbdInteractiveRequest) -> KbdInteractiveAnswer {
            panic!("must not be asked")
        }
        fn is_available(&self) -> bool {
            false
        }
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    let respond: RespondFn = Arc::new(move |id, responses: KiResponses| {
        let _ = tx.send((id, responses.is_some()));
    });
    let relay = AgentKiPromptRelay::new(
        "a".into(),
        Some(Arc::new(Unavailable)),
        respond,
        AgentPromptActivity::new(),
    );
    relay.handle_notification(SSH_KEYBOARD_INTERACTIVE_PROMPT, &prompt_params("r-6"));
    assert_eq!(rx.recv().await.unwrap(), ("r-6".to_string(), false));
}

#[test]
fn other_notifications_are_not_consumed() {
    let respond: RespondFn = Arc::new(|_, _| {});
    let relay = AgentKiPromptRelay::new("a".into(), None, respond, AgentPromptActivity::new());
    assert!(!relay.handle_notification("connection.output", &json!({})));
}

#[tokio::test(start_paused = true)]
async fn request_wait_excludes_prompt_time() {
    let activity = AgentPromptActivity::new();
    let (tx, rx) = tokio::sync::oneshot::channel::<u32>();
    let guard = activity.begin();
    let waiting = tokio::spawn({
        let activity = activity.clone();
        async move { recv_excluding_prompts(rx, Duration::from_secs(60), &activity).await }
    });
    // Far past the bound while the prompt is open: still waiting.
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert!(!waiting.is_finished());
    drop(guard);
    tx.send(7).unwrap();
    assert_eq!(waiting.await.unwrap().unwrap().unwrap(), 7);
}

#[tokio::test(start_paused = true)]
async fn request_wait_times_out_without_prompts() {
    let activity = AgentPromptActivity::new();
    let (_tx, rx) = tokio::sync::oneshot::channel::<u32>();
    let result = recv_excluding_prompts(rx, Duration::from_secs(60), &activity).await;
    assert!(result.is_err());
}
