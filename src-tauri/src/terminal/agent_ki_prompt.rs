//! Desktop end of the agent keyboard-interactive prompt relay (#3375).
//!
//! When a remote agent authenticates an SSH connection itself (an agent-hosted
//! SSH session, an agent tunnel, agent monitoring) and the server asks an OTP /
//! 2FA / PAM round, the agent sends an `ssh.keyboard_interactive.prompt`
//! notification. [`AgentKiPromptRelay`] shows it with the **same** dialog as a
//! direct SSH connection — it calls the desktop's registered
//! [`KeyboardInteractivePrompter`] (which emits `ssh-keyboard-interactive-prompt`
//! and awaits the dialog) with the agent's host as the `via` label — and sends
//! the answer back as `ssh.keyboard_interactive.respond`.
//!
//! A round the agent abandons (`ssh.keyboard_interactive.closed`), or every
//! round when the agent connection drops or is torn down, is aborted: the
//! prompter's pending guard then closes the dialog.
//!
//! The desktop advertises support in `initialize`
//! (`clientCapabilities.keyboardInteractivePrompts`); an older agent never sends
//! the notification. Answers stay in [`Zeroizing`] storage up to the wire (see
//! [`AgentIoCommand::KiRespond`](super::agent_manager)).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use termihub_core::backends::ssh::keyboard_interactive::{
    KbdInteractiveAnswer, KbdInteractivePrompt, KbdInteractiveRequest, KeyboardInteractivePrompter,
};
use termihub_core::protocol::methods::{
    KbdInteractiveClosedNotification, KbdInteractivePromptNotification,
    SSH_KEYBOARD_INTERACTIVE_CLOSED, SSH_KEYBOARD_INTERACTIVE_PROMPT,
};
use tokio::task::AbortHandle;
use tokio::time::Instant;
use tracing::debug;
use zeroize::Zeroizing;

/// The answer to send back: one response per prompt, or `None` = cancel.
pub(crate) type KiResponses = Option<Vec<Zeroizing<String>>>;

/// Where the relay sends an answer (the agent I/O task's command channel in
/// production; a recorder in tests).
pub(crate) type RespondFn = Arc<dyn Fn(String, KiResponses) + Send + Sync>;

/// Tracks agent-relayed prompts that are open on this desktop, so a request
/// waiting on the agent (a `connection.create` whose SSH connect is blocked on
/// the user's one-time code) does not time out while the user answers.
#[derive(Debug)]
pub(crate) struct AgentPromptActivity {
    open: AtomicUsize,
    last_change: Mutex<Instant>,
}

impl Default for AgentPromptActivity {
    fn default() -> Self {
        Self {
            open: AtomicUsize::new(0),
            last_change: Mutex::new(Instant::now()),
        }
    }
}

impl AgentPromptActivity {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn begin(self: &Arc<Self>) -> ActivityGuard {
        self.open.fetch_add(1, Ordering::SeqCst);
        self.touch();
        ActivityGuard(self.clone())
    }

    fn touch(&self) {
        *self.last_change.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    /// The instant a request started at `started` with bound `timeout` really
    /// times out: prompt time is excluded, so while a prompt is open the
    /// deadline keeps moving, and it restarts from the last prompt change.
    pub(crate) fn deadline(&self, started: Instant, timeout: Duration) -> Option<Instant> {
        if self.open.load(Ordering::SeqCst) > 0 {
            return None;
        }
        let last = *self.last_change.lock().unwrap_or_else(|e| e.into_inner());
        Some(started.max(last) + timeout)
    }
}

struct ActivityGuard(Arc<AgentPromptActivity>);

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::SeqCst);
        self.0.touch();
    }
}

/// Wait for `rx` with a `timeout` that excludes agent-relayed prompt time.
/// `Err(())` = timed out.
pub(crate) async fn recv_excluding_prompts<T>(
    rx: tokio::sync::oneshot::Receiver<T>,
    timeout: Duration,
    activity: &AgentPromptActivity,
) -> Result<Result<T, tokio::sync::oneshot::error::RecvError>, ()> {
    /// How often an open prompt re-checks the deadline.
    const POLL: Duration = Duration::from_millis(500);
    let started = Instant::now();
    tokio::pin!(rx);
    loop {
        let wake = match activity.deadline(started, timeout) {
            Some(deadline) if deadline <= Instant::now() => return Err(()),
            Some(deadline) => deadline,
            None => Instant::now() + POLL,
        };
        tokio::select! {
            result = &mut rx => return Ok(result),
            _ = tokio::time::sleep_until(wake) => {}
        }
    }
}

/// Relays one agent's prompt rounds to the desktop dialog. Dropping it aborts
/// every open round (closing their dialogs).
pub(crate) struct AgentKiPromptRelay {
    /// Shown in the dialog as "via …" (the agent's host).
    via: String,
    prompter: Option<Arc<dyn KeyboardInteractivePrompter>>,
    respond: RespondFn,
    activity: Arc<AgentPromptActivity>,
    rounds: Arc<Mutex<HashMap<String, AbortHandle>>>,
}

impl AgentKiPromptRelay {
    /// A relay showing rounds through `prompter` (the desktop's registered
    /// dialog prompter; `None` → every round is cancelled) and answering via
    /// `respond`.
    pub(crate) fn new(
        via: String,
        prompter: Option<Arc<dyn KeyboardInteractivePrompter>>,
        respond: RespondFn,
        activity: Arc<AgentPromptActivity>,
    ) -> Self {
        Self {
            via,
            prompter,
            respond,
            activity,
            rounds: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Handle an agent notification, returning `true` if it was a prompt-relay
    /// one (so the caller skips its other routing).
    pub(crate) fn handle_notification(&self, method: &str, params: &Value) -> bool {
        match method {
            m if m == SSH_KEYBOARD_INTERACTIVE_PROMPT => {
                if let Ok(n) =
                    serde_json::from_value::<KbdInteractivePromptNotification>(params.clone())
                {
                    self.start_round(n);
                }
                true
            }
            m if m == SSH_KEYBOARD_INTERACTIVE_CLOSED => {
                if let Ok(n) =
                    serde_json::from_value::<KbdInteractiveClosedNotification>(params.clone())
                {
                    self.abort_round(&n.request_id);
                }
                true
            }
            _ => false,
        }
    }

    fn start_round(&self, n: KbdInteractivePromptNotification) {
        let request_id = n.request_id.clone();
        let request = KbdInteractiveRequest {
            host: n.host,
            port: n.port,
            username: n.username,
            name: n.name,
            instructions: n.instructions,
            prompts: n
                .prompts
                .into_iter()
                .map(|p| KbdInteractivePrompt {
                    prompt: p.prompt,
                    echo: p.echo,
                })
                .collect(),
            round: n.round,
            via: Some(self.via.clone()),
        };
        debug!(
            host = %request.host,
            via = %self.via,
            round = request.round,
            "agent-relayed SSH keyboard-interactive prompt"
        );
        let prompter = self.prompter.clone();
        let respond = self.respond.clone();
        let rounds = self.rounds.clone();
        let outstanding = self.activity.begin();
        let id = request_id.clone();
        let mut guard = self.rounds.lock().unwrap_or_else(|e| e.into_inner());
        let task = tokio::spawn(async move {
            let _outstanding = outstanding;
            let answer = match prompter {
                Some(p) if p.is_available() => p.prompt(&request).await,
                _ => KbdInteractiveAnswer::Cancelled,
            };
            rounds.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            let responses = match answer {
                KbdInteractiveAnswer::Responses(r) => Some(r),
                KbdInteractiveAnswer::Cancelled => None,
            };
            respond(id, responses);
        });
        guard.insert(request_id, task.abort_handle());
    }

    fn abort_round(&self, request_id: &str) {
        if let Some(task) = self
            .rounds
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(request_id)
        {
            task.abort();
        }
    }

    /// Abort every open round — the agent connection dropped, so nobody is
    /// waiting for these answers any more.
    pub(crate) fn cancel_all(&self) {
        for (_, task) in self
            .rounds
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            task.abort();
        }
    }

    /// Number of open rounds.
    #[cfg(test)]
    pub(crate) fn open_rounds(&self) -> usize {
        self.rounds.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Drop for AgentKiPromptRelay {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

#[cfg(test)]
#[path = "agent_ki_prompt_tests.rs"]
mod tests;
