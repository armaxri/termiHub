//! Connect-time X server install-consent handshake (#1116).
//!
//! When an SSH connection with X11 forwarding is opened and provisioning would
//! need to **install** a dependency (Windows VcXsrv via winget) that the user has
//! not yet consented to, the connect path pauses: the desktop app emits a
//! "consent needed" event to the frontend and awaits the user's reply before
//! anything is installed. This module holds the Tauri-agnostic primitives for that
//! handshake so the pause/await logic is unit-testable without an `AppHandle`:
//!
//! - [`connect_consent_required`] — the pure decision of *whether* to pause.
//! - [`ConnectConsentRegistry`] — keys each pending prompt by id so the reply
//!   command can resolve exactly the right paused connect.
//! - [`await_consent`] — awaits the reply, abortable via the connect's
//!   [`CancellationToken`] (reused from #1260) so a Stop while the prompt is up
//!   short-cuts the wait promptly.
//!
//! The event emission, settings persistence, and wiring into the provisioner
//! live in [`super`] (which has the `AppHandle`); this module never touches Tauri.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::types::XServerPlatform;

/// The user's reply to a connect-time X server consent prompt.
///
/// Sent by the frontend via the `x_server_connect_consent_reply` command and
/// routed through the [`ConnectConsentRegistry`] to the paused connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsentDecision {
    /// Consent granted — install/provision and enable X forwarding. Persisted so
    /// later connects do not re-prompt.
    Enable,
    /// Declined for now — skip X forwarding this connect (ask again next time).
    NotNow,
}

/// What the paused connect should do once the consent await resolves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentOutcome {
    /// Consent granted: proceed with install/provisioning.
    Proceed,
    /// Declined: skip X forwarding gracefully (the SSH connect continues).
    Skip,
    /// The connect was cancelled (Stop) while the prompt was up, or the prompt
    /// was dropped without a reply: abort promptly.
    Cancelled,
}

/// Whether opening this X11-forwarding connect must pause for install consent.
///
/// Pausing is required only when an **install** would actually happen and the
/// user has not decided yet:
/// - Only Windows installs a dependency (VcXsrv via winget). macOS guides an
///   XQuartz install through its own explicit consent (`x_server_install_dependency`),
///   and Linux never installs — so both return `false` here.
/// - `provide_setting` is the persisted `provide_x_server_automatically` value:
///   `Some(_)` means the user already decided (enabled → provision silently,
///   disabled → won't provision anyway), so never prompt.
/// - `None` (undecided) prompts **only** when no server is already reachable —
///   if one is present it is adopted with no install, so no prompt is needed.
pub fn connect_consent_required(
    platform: XServerPlatform,
    provide_setting: Option<bool>,
    server_present: bool,
) -> bool {
    if platform != XServerPlatform::Windows {
        return false;
    }
    match provide_setting {
        Some(_) => false,
        None => !server_present,
    }
}

/// Await the user's reply to a consent prompt, abortable via the connect token.
///
/// Resolves to [`ConsentOutcome::Cancelled`] when `cancel` trips before a reply
/// arrives (a Stop while the prompt is up, #1260) or when the sender is dropped
/// without replying, so a paused connect never blocks indefinitely.
pub async fn await_consent(
    receiver: oneshot::Receiver<ConsentDecision>,
    cancel: Option<&CancellationToken>,
) -> ConsentOutcome {
    match cancel {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => ConsentOutcome::Cancelled,
                reply = receiver => decision_outcome(reply.ok()),
            }
        }
        None => decision_outcome(receiver.await.ok()),
    }
}

/// Map an optional decision (`None` = sender dropped) to a [`ConsentOutcome`].
fn decision_outcome(decision: Option<ConsentDecision>) -> ConsentOutcome {
    match decision {
        Some(ConsentDecision::Enable) => ConsentOutcome::Proceed,
        Some(ConsentDecision::NotNow) => ConsentOutcome::Skip,
        None => ConsentOutcome::Cancelled,
    }
}

/// Routes each pending connect-time consent prompt to its awaiting connect.
///
/// A paused connect [`register`](Self::register)s a prompt and gets back an id
/// (embedded in the emitted event) plus a receiver it awaits. When the frontend
/// replies, the `x_server_connect_consent_reply` command calls
/// [`resolve`](Self::resolve) with that id to wake the exact connect. Held as
/// shared Tauri state so both the provisioner and the reply command reach it.
#[derive(Default)]
pub struct ConnectConsentRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<ConsentDecision>>>,
}

impl ConnectConsentRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new pending prompt, returning its id and the receiver the
    /// paused connect awaits. The id is a fresh UUID so concurrent connects never
    /// collide.
    pub fn register(&self) -> (String, oneshot::Receiver<ConsentDecision>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id.clone(), tx);
        }
        (id, rx)
    }

    /// Deliver a reply to the pending prompt with `id`, waking its connect.
    ///
    /// Returns `true` when a matching prompt was found and notified; `false` when
    /// the id is unknown (already resolved, cancelled, or never registered).
    pub fn resolve(&self, id: &str, decision: ConsentDecision) -> bool {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(id));
        match sender {
            Some(tx) => tx.send(decision).is_ok(),
            None => false,
        }
    }

    /// Drop a pending prompt without delivering a reply (e.g. the connect was
    /// aborted). Its receiver then observes the sender drop as a cancellation.
    pub fn forget(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── connect_consent_required (pure decision) ─────────────────────────

    #[test]
    fn non_windows_platforms_never_prompt() {
        // macOS/Linux never download a dependency on connect, so no prompt even
        // when undecided and no server is present.
        for platform in [XServerPlatform::MacOs, XServerPlatform::Linux] {
            assert!(!connect_consent_required(platform, None, false));
            assert!(!connect_consent_required(platform, None, true));
        }
    }

    #[test]
    fn windows_already_decided_never_prompts() {
        // Some(true) = already consented (provision silently); Some(false) =
        // disabled (won't provision anyway). Neither prompts.
        assert!(!connect_consent_required(
            XServerPlatform::Windows,
            Some(true),
            false
        ));
        assert!(!connect_consent_required(
            XServerPlatform::Windows,
            Some(false),
            false
        ));
    }

    #[test]
    fn windows_undecided_prompts_only_when_no_server_present() {
        // Undecided + no server → a download would happen → prompt.
        assert!(connect_consent_required(
            XServerPlatform::Windows,
            None,
            false
        ));
        // Undecided + server already reachable → adopt, no download → no prompt.
        assert!(!connect_consent_required(
            XServerPlatform::Windows,
            None,
            true
        ));
    }

    // ── await_consent + registry round trip ──────────────────────────────

    #[tokio::test]
    async fn enable_reply_resolves_to_proceed() {
        let registry = ConnectConsentRegistry::new();
        let (id, rx) = registry.register();
        assert!(registry.resolve(&id, ConsentDecision::Enable));
        assert_eq!(await_consent(rx, None).await, ConsentOutcome::Proceed);
    }

    #[tokio::test]
    async fn not_now_reply_resolves_to_skip() {
        let registry = ConnectConsentRegistry::new();
        let (id, rx) = registry.register();
        assert!(registry.resolve(&id, ConsentDecision::NotNow));
        assert_eq!(await_consent(rx, None).await, ConsentOutcome::Skip);
    }

    #[tokio::test]
    async fn cancelled_token_mid_prompt_aborts_promptly() {
        let registry = ConnectConsentRegistry::new();
        let (_id, rx) = registry.register();
        let cancel = CancellationToken::new();
        cancel.cancel();
        // No reply is ever delivered; the tripped token wins.
        assert_eq!(
            await_consent(rx, Some(&cancel)).await,
            ConsentOutcome::Cancelled
        );
    }

    #[tokio::test]
    async fn dropped_prompt_resolves_to_cancelled() {
        let registry = ConnectConsentRegistry::new();
        let (id, rx) = registry.register();
        registry.forget(&id); // sender dropped without a reply
        assert_eq!(await_consent(rx, None).await, ConsentOutcome::Cancelled);
    }

    #[test]
    fn resolve_unknown_id_returns_false() {
        let registry = ConnectConsentRegistry::new();
        assert!(!registry.resolve("no-such-id", ConsentDecision::Enable));
    }

    #[test]
    fn resolve_is_single_use() {
        let registry = ConnectConsentRegistry::new();
        let (id, _rx) = registry.register();
        assert!(registry.resolve(&id, ConsentDecision::Enable));
        // A second reply for the same id finds nothing pending.
        assert!(!registry.resolve(&id, ConsentDecision::Enable));
    }

    #[tokio::test]
    async fn reply_before_cancel_wins() {
        // A delivered reply that arrives before the token trips is honored.
        let registry = ConnectConsentRegistry::new();
        let (id, rx) = registry.register();
        let cancel = CancellationToken::new();
        assert!(registry.resolve(&id, ConsentDecision::Enable));
        assert_eq!(
            await_consent(rx, Some(&cancel)).await,
            ConsentOutcome::Proceed
        );
    }
}
