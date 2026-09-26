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
//! Every prompt records the **owner** of the connect that raised it — the
//! `connect_id` scoped around that connect with [`with_prompt_owner`] (#3437).
//! Closing / cancelling a connecting tab ([`cancel_connecting`](crate::commands::session::cancel_connecting))
//! cancels exactly that owner's prompts via
//! [`SshKeyboardInteractivePrompter::cancel_owned_by`]; other tabs' prompts are
//! untouched. The owner is also carried on the event (`owner`) so the dialog
//! can tell which tab a prompt belongs to.
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

tokio::task_local! {
    /// The `connect_id` of the connect running in this task (#3437).
    static PROMPT_OWNER: String;
}

/// Run `fut` with `owner` recorded as the owner of any keyboard-interactive
/// prompt it raises (#3437). `None` runs `fut` unscoped (an inherited owner,
/// if any, stays in effect).
pub async fn with_prompt_owner<F: std::future::Future>(owner: Option<&str>, fut: F) -> F::Output {
    match owner {
        Some(owner) => PROMPT_OWNER.scope(owner.to_string(), fut).await,
        None => fut.await,
    }
}

/// The owner scoped around the current task by [`with_prompt_owner`], if any.
pub fn current_prompt_owner() -> Option<String> {
    PROMPT_OWNER.try_with(Clone::clone).ok()
}

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
    /// The remote agent relaying this prompt (its host), when the connection
    /// is authenticated by an agent rather than the desktop (#3375). `null`
    /// for a direct connection. Shown as "via …" in the dialog.
    pub via: Option<String>,
    /// The `connect_id` of the connect that raised this prompt (for a terminal
    /// tab `${tabId}:${retryCount}`), when known (#3437). Closing that tab
    /// cancels the prompt. `null` for a prompt with no owning connect.
    pub owner: Option<String>,
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
/// A prompt awaiting its reply, and the connect that owns it.
struct Pending {
    tx: oneshot::Sender<Reply>,
    owner: Option<String>,
}

type PendingMap = Mutex<HashMap<String, Pending>>;

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
            Some(pending) => pending.tx.send(reply).is_ok(),
            None => false,
        }
    }

    /// Cancel every prompt owned by the connect `owner` (#3437): the tab that
    /// connects was closed, or its connect was cancelled. Each waiting exchange
    /// resolves as [`KbdInteractiveAnswer::Cancelled`] (→ `AuthCancelled`, so
    /// the connect aborts at once instead of waiting out the prompt timeout)
    /// and its dialog closes. Prompts of other connects are untouched.
    ///
    /// Returns the number of prompts cancelled.
    pub fn cancel_owned_by(&self, owner: &str) -> usize {
        let senders: Vec<Pending> = {
            let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, p)| p.owner.as_deref() == Some(owner))
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        let count = senders.len();
        for pending in senders {
            let _ = pending.tx.send(None);
        }
        count
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
        let owner = current_prompt_owner();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                prompt_id.clone(),
                Pending {
                    tx,
                    owner: owner.clone(),
                },
            );
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
            via: request.via.clone(),
            owner,
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
            via: None,
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

    /// A prompt raised inside `with_prompt_owner` carries that owner; an
    /// unscoped one carries none (#3437).
    #[tokio::test]
    async fn prompt_carries_its_owning_connect() {
        let (prompter, sink) = setup();
        let p = prompter.clone();
        let owned =
            tokio::spawn(
                async move { with_prompt_owner(Some("tab-a:0"), p.prompt(&request())).await },
            );
        let id = latest_prompt_id(&sink).await;
        assert_eq!(
            sink.prompts.lock().unwrap()[0].owner.as_deref(),
            Some("tab-a:0")
        );
        assert!(prompter.resolve(&id, None));
        owned.await.unwrap();

        let p = prompter.clone();
        let unowned = tokio::spawn(async move { p.prompt(&request()).await });
        while sink.prompts.lock().unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
        let event = sink.prompts.lock().unwrap()[1].clone();
        assert_eq!(event.owner, None);
        assert_eq!(
            prompter.cancel_owned_by("tab-a:0"),
            0,
            "unowned is untouched"
        );
        assert!(prompter.resolve(&event.prompt_id, None));
        unowned.await.unwrap();
    }

    /// Cancelling an owner resolves exactly its prompts as cancelled and closes
    /// their dialogs; other owners' prompts keep waiting (#3437).
    #[tokio::test]
    async fn cancel_owned_by_cancels_only_that_owners_prompts() {
        let (prompter, sink) = setup();
        let spawn_owned = |owner: &'static str| {
            let p = prompter.clone();
            tokio::spawn(async move { with_prompt_owner(Some(owner), p.prompt(&request())).await })
        };
        let a1 = spawn_owned("tab-a:0");
        let a2 = spawn_owned("tab-a:0");
        let b = spawn_owned("tab-b:0");
        while sink.prompts.lock().unwrap().len() < 3 {
            tokio::task::yield_now().await;
        }

        assert_eq!(prompter.cancel_owned_by("tab-a:0"), 2);
        assert!(matches!(a1.await.unwrap(), KbdInteractiveAnswer::Cancelled));
        assert!(matches!(a2.await.unwrap(), KbdInteractiveAnswer::Cancelled));
        assert_eq!(sink.closed.lock().unwrap().len(), 2);
        assert_eq!(prompter.pending_count(), 1);
        assert!(!b.is_finished());
        assert_eq!(prompter.cancel_owned_by("tab-a:0"), 0, "idempotent");

        let b_id = sink
            .prompts
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.owner.as_deref() == Some("tab-b:0"))
            .map(|p| p.prompt_id.clone())
            .unwrap();
        assert!(prompter.resolve(&b_id, Some(vec!["x".into(), "y".into()])));
        assert!(matches!(
            b.await.unwrap(),
            KbdInteractiveAnswer::Responses(_)
        ));
    }
}
