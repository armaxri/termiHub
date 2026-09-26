//! Agent → desktop relay for SSH keyboard-interactive (OTP / 2FA / PAM)
//! prompts (#3375).
//!
//! When the **agent** authenticates an SSH connection itself — an agent-hosted
//! SSH session, `tunnel.start` with an `sshConfig`, agent monitoring — the core
//! auth exchange (`termihub_core::backends::ssh::keyboard_interactive`) asks a
//! process-wide [`KeyboardInteractivePrompter`] to answer each info-request
//! round. This module supplies that prompter for the agent:
//!
//! - [`KiPromptHub`] holds the attached desktop's notification channel and the
//!   rounds awaiting an answer. [`KiPromptHub::ask`] sends an
//!   `ssh.keyboard_interactive.prompt` notification and parks on a oneshot that
//!   the desktop's `ssh.keyboard_interactive.respond` request resolves
//!   ([`KiPromptHub::respond`]). A round no longer awaited (timeout, abandoned
//!   connect) is announced with `ssh.keyboard_interactive.closed`.
//! - The hub is only [available](KeyboardInteractivePrompter::is_available)
//!   while a desktop that advertised `clientCapabilities.keyboardInteractivePrompts`
//!   is attached. With an older desktop, core treats it as "no prompter" and
//!   keeps the pre-#3375 behavior: the saved password is auto-answered, any
//!   other prompt fails the connect with a clear message.
//! - [`relay`] carries rounds from a **session daemon** (a separate process that
//!   performs the SSH connect for persistent sessions) to this worker's hub over
//!   a per-session local socket.
//!
//! ## Secrets
//!
//! Answers are never logged (the transport loop redacts the respond request,
//! see [`is_secret_bearing_request`]), are moved straight into [`Zeroizing`]
//! storage, and are wiped once handed to the SSH layer.

pub mod relay;

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use async_trait::async_trait;
use termihub_core::backends::ssh::keyboard_interactive::{
    KbdInteractiveAnswer, KbdInteractiveRequest, KeyboardInteractivePrompter,
};
use termihub_core::protocol::methods::{
    KbdInteractiveClosedNotification, KbdInteractivePromptItem, KbdInteractivePromptNotification,
    SSH_KEYBOARD_INTERACTIVE_CLOSED, SSH_KEYBOARD_INTERACTIVE_PROMPT,
    SSH_KEYBOARD_INTERACTIVE_RESPOND,
};
use tokio::sync::oneshot;
use tracing::debug;
use zeroize::Zeroizing;

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;

/// The user's answers for one round; `None` = cancelled.
pub type KiReply = Option<Vec<Zeroizing<String>>>;

/// Whether a raw JSON-RPC line is an `ssh.keyboard_interactive.respond`
/// request — which carries one-time codes / passwords and so must never be
/// logged, and which the transport loop must dispatch even while another
/// request (the `connection.create` waiting on this very answer) is in flight.
///
/// Reads only the `method` member (every other member is skipped without being
/// copied), so the check itself never duplicates the secrets.
pub fn is_secret_bearing_request(line: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct MethodOnly<'a> {
        #[serde(borrow)]
        method: Option<std::borrow::Cow<'a, str>>,
    }
    serde_json::from_str::<MethodOnly<'_>>(line)
        .ok()
        .and_then(|m| m.method)
        .is_some_and(|m| m == SSH_KEYBOARD_INTERACTIVE_RESPOND)
}

/// Tracks whether prompts are outstanding, so waits that would otherwise time
/// out a connect (the daemon-spawn connect, #3375) can exclude the time a user
/// spends fetching a one-time code.
#[derive(Debug)]
pub struct PromptActivity {
    pending: AtomicUsize,
    last_change: Mutex<Instant>,
}

impl Default for PromptActivity {
    fn default() -> Self {
        Self {
            pending: AtomicUsize::new(0),
            last_change: Mutex::new(Instant::now()),
        }
    }
}

impl PromptActivity {
    /// Create a tracker with no outstanding prompts.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Mark a prompt outstanding until the returned guard drops.
    pub fn begin(self: &Arc<Self>) -> PromptActivityGuard {
        self.pending.fetch_add(1, Ordering::SeqCst);
        self.touch();
        PromptActivityGuard {
            activity: self.clone(),
        }
    }

    /// Whether a prompt is outstanding now, or one started or finished after
    /// `since`.
    pub fn active_since(&self, since: Instant) -> bool {
        self.pending.load(Ordering::SeqCst) > 0
            || *self.last_change.lock().unwrap_or_else(|e| e.into_inner()) > since
    }

    fn touch(&self) {
        *self.last_change.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }
}

/// Keeps a prompt counted as outstanding in its [`PromptActivity`].
pub struct PromptActivityGuard {
    activity: Arc<PromptActivity>,
}

impl Drop for PromptActivityGuard {
    fn drop(&mut self) {
        self.activity.pending.fetch_sub(1, Ordering::SeqCst);
        self.activity.touch();
    }
}

/// The desktop currently able to answer prompts.
struct AttachedClient {
    tx: NotificationSender,
    generation: u64,
}

#[derive(Default)]
struct HubState {
    client: Option<AttachedClient>,
    next_generation: u64,
    pending: HashMap<String, oneshot::Sender<KiReply>>,
}

/// Routes keyboard-interactive rounds to the attached desktop and its answers
/// back. See the [module docs](self).
#[derive(Default)]
pub struct KiPromptHub {
    state: Mutex<HubState>,
}

static GLOBAL_HUB: OnceLock<Arc<KiPromptHub>> = OnceLock::new();

impl KiPromptHub {
    /// Create an empty hub (no desktop attached).
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The process-wide hub, registered with core as the SSH
    /// keyboard-interactive prompter on first use.
    ///
    /// One agent worker serves one desktop at a time (one per `--stdio`
    /// process; sequential clients in `--listen` mode), so a single hub that
    /// tracks "the attached desktop" is the right shape.
    pub fn global() -> Arc<Self> {
        GLOBAL_HUB
            .get_or_init(|| {
                let hub = Self::new();
                termihub_core::backends::ssh::keyboard_interactive::set_keyboard_interactive_prompter(
                    Arc::new(HubPrompter(hub.clone())),
                );
                hub
            })
            .clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Attach a desktop that advertised prompt support. Replaces any previous
    /// client (whose rounds are cancelled). Returns a generation to pass to
    /// [`detach_client`](Self::detach_client).
    pub fn attach_client(&self, tx: NotificationSender) -> u64 {
        let mut state = self.lock();
        state.next_generation += 1;
        let generation = state.next_generation;
        state.client = Some(AttachedClient { tx, generation });
        // Rounds shown to a previous desktop can no longer be answered.
        state.pending.clear();
        generation
    }

    /// Detach the desktop attached as `generation` (a no-op if another one has
    /// attached since). Every round it was asked is cancelled — dropping the
    /// waiting senders resolves each [`ask`](Self::ask) as a cancel.
    pub fn detach_client(&self, generation: u64) {
        let mut state = self.lock();
        if state
            .client
            .as_ref()
            .is_some_and(|c| c.generation == generation)
        {
            state.client = None;
            state.pending.clear();
        }
    }

    /// Whether a prompt-capable desktop is attached.
    pub fn is_available(&self) -> bool {
        self.lock()
            .client
            .as_ref()
            .is_some_and(|c| !c.tx.is_closed())
    }

    /// Deliver the desktop's answer for `request_id`. Returns `false` for a
    /// stale or unknown id (already answered, timed out, or abandoned).
    pub fn respond(&self, request_id: &str, reply: KiReply) -> bool {
        let sender = self.lock().pending.remove(request_id);
        match sender {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    /// Number of rounds awaiting an answer.
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.lock().pending.len()
    }

    /// Ask the attached desktop to answer `request`, optionally on behalf of
    /// the agent session `session_id`.
    ///
    /// Resolves as [`KbdInteractiveAnswer::Cancelled`] when the user cancels,
    /// when no capable desktop is attached, or when it detaches mid-prompt.
    /// Dropping the returned future (prompt timeout, connect abandoned) removes
    /// the round and tells the desktop to close its dialog.
    pub async fn ask(
        &self,
        request: &KbdInteractiveRequest,
        session_id: Option<String>,
    ) -> KbdInteractiveAnswer {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let client_tx = {
            let mut state = self.lock();
            let Some(client) = state.client.as_ref() else {
                return KbdInteractiveAnswer::Cancelled;
            };
            let client_tx = client.tx.clone();
            state.pending.insert(request_id.clone(), tx);
            client_tx
        };
        let mut guard = PendingRound {
            hub: self,
            client_tx: client_tx.clone(),
            request_id: request_id.clone(),
            finished: false,
        };

        let notification = KbdInteractivePromptNotification {
            request_id: request_id.clone(),
            session_id,
            host: request.host.clone(),
            port: request.port,
            username: request.username.clone(),
            name: request.name.clone(),
            instructions: request.instructions.clone(),
            prompts: request
                .prompts
                .iter()
                .map(|p| KbdInteractivePromptItem {
                    prompt: p.prompt.clone(),
                    echo: p.echo,
                })
                .collect(),
            round: request.round,
        };
        let params = match serde_json::to_value(&notification) {
            Ok(v) => v,
            Err(_) => return KbdInteractiveAnswer::Cancelled,
        };
        debug!(
            host = %request.host,
            round = request.round,
            prompts = request.prompts.len(),
            "relaying SSH keyboard-interactive prompt to the desktop"
        );
        if client_tx
            .send(JsonRpcNotification::new(
                SSH_KEYBOARD_INTERACTIVE_PROMPT,
                params,
            ))
            .is_err()
        {
            return KbdInteractiveAnswer::Cancelled;
        }

        let reply = rx.await;
        guard.finished = true;
        match reply {
            Ok(Some(responses)) => KbdInteractiveAnswer::Responses(responses),
            // Explicit cancel, or the desktop detached (sender dropped).
            Ok(None) | Err(_) => KbdInteractiveAnswer::Cancelled,
        }
    }
}

/// Removes a round from the hub when its [`KiPromptHub::ask`] ends; when it
/// ends without an answer (future dropped on timeout / abandoned connect) it
/// also tells the desktop to close the dialog.
struct PendingRound<'a> {
    hub: &'a KiPromptHub,
    client_tx: NotificationSender,
    request_id: String,
    finished: bool,
}

impl Drop for PendingRound<'_> {
    fn drop(&mut self) {
        let was_pending = self.hub.lock().pending.remove(&self.request_id).is_some();
        if was_pending && !self.finished {
            if let Ok(params) = serde_json::to_value(KbdInteractiveClosedNotification {
                request_id: self.request_id.clone(),
            }) {
                let _ = self.client_tx.send(JsonRpcNotification::new(
                    SSH_KEYBOARD_INTERACTIVE_CLOSED,
                    params,
                ));
            }
        }
    }
}

/// One agent connection's link to a [`KiPromptHub`]: the hub, the
/// connection's priority notification channel (drained even while a request is
/// in flight, see `io::transport`), and whether its desktop is attached.
///
/// Shared by the dispatch state (`initialize` attaches, the respond method
/// resolves) and the transport loop's disconnect path (detaches).
pub struct KiBinding {
    inner: Mutex<KiBindingInner>,
}

struct KiBindingInner {
    hub: Arc<KiPromptHub>,
    tx: Option<NotificationSender>,
    generation: Option<u64>,
}

impl KiBinding {
    /// An unwired binding: a private hub and no channel, so the connection
    /// never advertises or relays prompts (unit tests, bare handlers).
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(KiBindingInner {
                hub: KiPromptHub::new(),
                tx: None,
                generation: None,
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, KiBindingInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Wire the hub and the connection's priority notification channel.
    pub fn wire(&self, hub: Arc<KiPromptHub>, tx: NotificationSender) {
        let mut inner = self.lock();
        inner.hub = hub;
        inner.tx = Some(tx);
    }

    /// Whether this connection can relay prompts (advertised in `initialize`).
    pub fn is_wired(&self) -> bool {
        self.lock().tx.is_some()
    }

    /// The hub this connection relays through.
    pub fn hub(&self) -> Arc<KiPromptHub> {
        self.lock().hub.clone()
    }

    /// Attach this connection's desktop to the hub (it advertised prompt
    /// support). Returns whether it was attached (only when wired).
    pub fn attach(&self) -> bool {
        let mut inner = self.lock();
        let Some(tx) = inner.tx.clone() else {
            return false;
        };
        let generation = inner.hub.attach_client(tx);
        inner.generation = Some(generation);
        true
    }

    /// Detach this connection's desktop (disconnect), cancelling its rounds.
    pub fn detach(&self) {
        let mut inner = self.lock();
        if let Some(generation) = inner.generation.take() {
            inner.hub.detach_client(generation);
        }
    }
}

/// Core prompter backed by a [`KiPromptHub`] — what an in-process SSH connect
/// on the worker (agent tunnels, monitoring, non-daemon sessions) uses.
pub struct HubPrompter(pub Arc<KiPromptHub>);

#[async_trait]
impl KeyboardInteractivePrompter for HubPrompter {
    async fn prompt(&self, request: &KbdInteractiveRequest) -> KbdInteractiveAnswer {
        self.0.ask(request, None).await
    }

    fn is_available(&self) -> bool {
        self.0.is_available()
    }
}

#[cfg(test)]
mod tests;
