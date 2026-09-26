//! Interactive SSH keyboard-interactive prompter wiring the core hook to the
//! desktop UI (#3371, PARITY-010).
//!
//! Implements [`termihub_core`'s `KeyboardInteractivePrompter`](termihub_core::backends::ssh::keyboard_interactive)
//! for the desktop app, following the same event + pending-oneshot shape as the
//! host-key verifier ([`ssh_host_key_verifier`](super::ssh_host_key_verifier)):
//!
//! 1. the SSH auth exchange asks for answers → emit `ssh-keyboard-interactive-prompt`
//!    and park on a oneshot keyed by `prompt_id`;
//! 2. the frontend dialog replies through the `ssh_keyboard_interactive_respond`
//!    command (`responses: null` = cancel), which resolves the oneshot;
//! 3. when the waiting side goes away without an answer (connect cancelled,
//!    prompt timeout) the pending entry is removed and
//!    `ssh-keyboard-interactive-prompt-closed` tells the dialog to close.
//!
//! Responses are secrets: they are never logged and are held as
//! [`Zeroizing`] strings until handed to the SSH layer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::Serialize;
use termihub_core::backends::ssh::keyboard_interactive::{
    KbdInteractiveAnswer, KbdInteractiveRequest, KeyboardInteractivePrompter,
};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

/// One prompt in an `ssh-keyboard-interactive-prompt` event.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SshKeyboardInteractivePromptItem {
    /// Prompt text as sent by the server.
    pub prompt: String,
    /// `false` → the input must be masked.
    pub echo: bool,
}

/// `ssh-keyboard-interactive-prompt` payload: the SSH server asks the user to
/// answer one keyboard-interactive round (OTP / 2FA / PAM) (#3371).
///
/// `prompt_id` correlates the reply (`ssh_keyboard_interactive_respond`) with
/// the blocked auth exchange; the dialog must send exactly one response per
/// entry in `prompts`, in order.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SshKeyboardInteractivePromptEvent {
    pub prompt_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Server-supplied challenge name (often empty).
    pub name: String,
    /// Server-supplied instruction text (often empty).
    pub instructions: String,
    pub prompts: Vec<SshKeyboardInteractivePromptItem>,
    /// 1-based round number within the exchange.
    pub round: u32,
}

/// `ssh-keyboard-interactive-prompt-closed` payload: the prompt with this id is
/// no longer awaited (answered, cancelled, or abandoned by the connect).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SshKeyboardInteractivePromptClosedEvent {
    pub prompt_id: String,
}

/// Abstracts frontend event delivery so the prompter is unit-testable without a
/// Tauri runtime. The production impl wraps `tauri::AppHandle`.
pub trait SshKeyboardInteractiveEventSink: Send + Sync + 'static {
    /// Show a prompt round.
    fn emit_prompt(&self, event: &SshKeyboardInteractivePromptEvent);
    /// Tell the UI a prompt is no longer awaited.
    fn emit_closed(&self, event: &SshKeyboardInteractivePromptClosedEvent);
}

impl<R: tauri::Runtime> SshKeyboardInteractiveEventSink for tauri::AppHandle<R> {
    fn emit_prompt(&self, event: &SshKeyboardInteractivePromptEvent) {
        use tauri::Emitter;
        let _ = self.emit("ssh-keyboard-interactive-prompt", event);
    }

    fn emit_closed(&self, event: &SshKeyboardInteractivePromptClosedEvent) {
        use tauri::Emitter;
        let _ = self.emit("ssh-keyboard-interactive-prompt-closed", event);
    }
}

/// `None` = cancelled.
type Reply = Option<Vec<Zeroizing<String>>>;
type PendingMap = Mutex<HashMap<String, oneshot::Sender<Reply>>>;

/// Desktop keyboard-interactive prompter backed by a frontend dialog.
pub struct SshKeyboardInteractivePrompter {
    sink: Arc<dyn SshKeyboardInteractiveEventSink>,
    pending: PendingMap,
}

/// Removes the pending entry and tells the UI the prompt is closed when the
/// waiting future ends — on reply, or when dropped mid-await (connect cancelled
/// / prompt timeout), so no entry leaks and no dialog is left orphaned.
struct PendingGuard<'a> {
    pending: &'a PendingMap,
    sink: &'a Arc<dyn SshKeyboardInteractiveEventSink>,
    prompt_id: String,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(&self.prompt_id);
        }
        self.sink
            .emit_closed(&SshKeyboardInteractivePromptClosedEvent {
                prompt_id: self.prompt_id.clone(),
            });
    }
}

impl SshKeyboardInteractivePrompter {
    /// Build a prompter that asks the user through `sink`.
    pub fn new(sink: Arc<dyn SshKeyboardInteractiveEventSink>) -> Self {
        Self {
            sink,
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Deliver the user's reply for a pending prompt; `responses: None` cancels.
    ///
    /// Returns `true` when a prompt with `prompt_id` was waiting (a stale or
    /// duplicate reply returns `false`).
    pub fn resolve(&self, prompt_id: &str, responses: Option<Vec<String>>) -> bool {
        let reply: Reply = responses.map(|r| r.into_iter().map(Zeroizing::new).collect());
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(prompt_id);
        match sender {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    /// Number of prompts currently awaiting a reply.
    #[cfg(test)]
    fn pending_count(&self) -> usize {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

#[async_trait]
impl KeyboardInteractivePrompter for SshKeyboardInteractivePrompter {
    async fn prompt(&self, request: &KbdInteractiveRequest) -> KbdInteractiveAnswer {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(prompt_id.clone(), tx);
        let _guard = PendingGuard {
            pending: &self.pending,
            sink: &self.sink,
            prompt_id: prompt_id.clone(),
        };

        tracing::debug!(
            host = %request.host,
            round = request.round,
            prompts = request.prompts.len(),
            "SSH keyboard-interactive prompt"
        );
        self.sink.emit_prompt(&SshKeyboardInteractivePromptEvent {
            prompt_id,
            host: request.host.clone(),
            port: request.port,
            username: request.username.clone(),
            name: request.name.clone(),
            instructions: request.instructions.clone(),
            prompts: request
                .prompts
                .iter()
                .map(|p| SshKeyboardInteractivePromptItem {
                    prompt: p.prompt.clone(),
                    echo: p.echo,
                })
                .collect(),
            round: request.round,
        });

        match rx.await {
            Ok(Some(responses)) => KbdInteractiveAnswer::Responses(responses),
            // Explicit cancel, or the sender vanished — either way nothing to send.
            Ok(None) | Err(_) => KbdInteractiveAnswer::Cancelled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::backends::ssh::keyboard_interactive::KbdInteractivePrompt;

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

    fn request() -> KbdInteractiveRequest {
        KbdInteractiveRequest {
            host: "bastion".to_string(),
            port: 22,
            username: "alice".to_string(),
            name: "Duo".to_string(),
            instructions: "Enter your code".to_string(),
            prompts: vec![
                KbdInteractivePrompt {
                    prompt: "Password: ".to_string(),
                    echo: false,
                },
                KbdInteractivePrompt {
                    prompt: "Device: ".to_string(),
                    echo: true,
                },
            ],
            round: 1,
        }
    }

    async fn latest_prompt_id(sink: &RecordingSink) -> String {
        loop {
            if let Some(p) = sink.prompts.lock().unwrap().last() {
                return p.prompt_id.clone();
            }
            tokio::task::yield_now().await;
        }
    }

    fn setup() -> (Arc<SshKeyboardInteractivePrompter>, Arc<RecordingSink>) {
        let sink = Arc::new(RecordingSink::default());
        (
            Arc::new(SshKeyboardInteractivePrompter::new(sink.clone())),
            sink,
        )
    }

    /// The event carries every field the dialog needs, and the reply reaches
    /// the waiting exchange in order.
    #[tokio::test]
    async fn prompt_emits_event_and_returns_responses() {
        let (prompter, sink) = setup();
        let p = prompter.clone();
        let handle = tokio::spawn(async move { p.prompt(&request()).await });

        let id = latest_prompt_id(&sink).await;
        assert!(prompter.resolve(&id, Some(vec!["pw".into(), "phone".into()])));

        match handle.await.unwrap() {
            KbdInteractiveAnswer::Responses(r) => {
                let plain: Vec<&str> = r.iter().map(|s| s.as_str()).collect();
                assert_eq!(plain, vec!["pw", "phone"]);
            }
            KbdInteractiveAnswer::Cancelled => panic!("expected responses"),
        }
        let event = sink.prompts.lock().unwrap()[0].clone();
        assert_eq!(event.host, "bastion");
        assert_eq!(event.username, "alice");
        assert_eq!(event.name, "Duo");
        assert_eq!(event.instructions, "Enter your code");
        assert_eq!(event.prompts.len(), 2);
        assert!(!event.prompts[0].echo);
        assert!(event.prompts[1].echo);
        assert_eq!(prompter.pending_count(), 0);
        assert_eq!(*sink.closed.lock().unwrap(), vec![id]);
    }

    /// `responses: None` is a cancel.
    #[tokio::test]
    async fn null_responses_cancel() {
        let (prompter, sink) = setup();
        let p = prompter.clone();
        let handle = tokio::spawn(async move { p.prompt(&request()).await });

        let id = latest_prompt_id(&sink).await;
        assert!(prompter.resolve(&id, None));
        assert!(matches!(
            handle.await.unwrap(),
            KbdInteractiveAnswer::Cancelled
        ));
    }

    /// A stale / duplicate reply is reported, not an error.
    #[tokio::test]
    async fn unknown_prompt_id_returns_false() {
        let (prompter, _sink) = setup();
        assert!(!prompter.resolve("nope", Some(vec![])));
    }

    /// Dropping the waiting future (connect cancelled / prompt timeout) removes
    /// the pending entry and closes the dialog.
    #[tokio::test]
    async fn abandoned_prompt_is_cleaned_up_and_closed() {
        let (prompter, sink) = setup();
        let p = prompter.clone();
        let handle = tokio::spawn(async move { p.prompt(&request()).await });
        let id = latest_prompt_id(&sink).await;
        assert_eq!(prompter.pending_count(), 1);

        handle.abort();
        let _ = handle.await;

        assert_eq!(prompter.pending_count(), 0);
        assert_eq!(*sink.closed.lock().unwrap(), vec![id.clone()]);
        assert!(!prompter.resolve(&id, Some(vec![])), "late reply is stale");
    }
}
