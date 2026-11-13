//! Interactive SSH host-key verifier wiring the core hook to the desktop UI
//! (#1959).
//!
//! Implements [`termihub_core`'s `HostKeyVerifier`](termihub_core::backends::ssh::host_key)
//! for the desktop app: it consults the persisted [`SshTrustStore`] and, for an
//! unknown or changed host key, emits a `ssh-host-key-prompt` event and blocks
//! the SSH handshake until the user's verdict arrives via the
//! `ssh_host_key_decision` command. It is the SSH analogue of the RDP
//! certificate-prompt flow in [`graphical_manager`](super::graphical_manager),
//! and follows the same event-sink-for-testability shape.
//!
//! Trust-on-first-use semantics:
//! - **Trusted** (fingerprint already remembered) → accept silently, no prompt.
//! - **Unknown** (host not remembered) → prompt for first-contact confirmation.
//! - **Changed** (host remembered with a different key) → prompt with a
//!   prominent possible-MITM warning; never auto-accept.
//!
//! "Accept for host" (`accept && remember`) persists the fingerprint so the host
//! is not prompted again — on a changed key ("Replace trusted key") it replaces
//! the previously-trusted key(s) for the host (#5627); plain "Accept" is session-scoped; "Reject" (or the
//! dialog being dismissed / the prompt future being dropped) aborts the connect.
//!
//! When the connect gives up while the prompt is open (abort, timeout) the core
//! drops the prompt future; the verifier then emits `ssh-host-key-prompt-closed`
//! so the dialog closes, and a late answer to it is ignored (#5185).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::Serialize;
use termihub_core::backends::ssh::host_key::{
    HostKeyDecision, HostKeyInfo, HostKeyVerifier, KnownHostsStatus, RecordedHostKey,
};
use tokio::sync::oneshot;
use tracing::warn;

use super::ssh_keyboard_interactive::current_prompt_owner;
use super::ssh_trust_store::{SshTrustStore, TrustLookup};

/// `ssh-host-key-prompt` payload: a server presented an untrusted host key that
/// needs an interactive trust decision (#1959).
///
/// `changed` distinguishes first contact (`false`) from a *changed* fingerprint
/// for a previously-trusted host (`true`) — the possible-MITM case the dialog
/// warns about prominently. `prompt_id` correlates the reply
/// (`ssh_host_key_decision`) back to the blocked handshake.
///
/// `previous_keys` carries the key(s) that were trusted for this host before
/// when the presented key *changed* — remembered in termiHub's own trust store
/// and/or recorded in the user's `~/.ssh/known_hosts` — so the prompt can show
/// the previously-trusted key beside the new one for comparison (UX-034,
/// #5627). It is `null` for first contact.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SshHostKeyPromptEvent {
    pub prompt_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub changed: bool,
    pub previous_keys: Option<Vec<PreviousHostKey>>,
    /// The `connect_id` of the connect that raised this prompt (for a terminal
    /// tab `${tabId}:${retryCount}`), when known (#5243). The frontend pauses
    /// that tab's own connect deadline while the prompt is open. `null` for a
    /// prompt with no owning connect.
    pub owner: Option<String>,
}

/// A host key that was trusted for a host before its key changed (#5627).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct PreviousHostKey {
    /// The key algorithm, e.g. `ssh-ed25519`. `null` when only the fingerprint
    /// is known (termiHub's own trust store remembers fingerprints only).
    pub key_type: Option<String>,
    /// The SHA-256 fingerprint in OpenSSH `SHA256:BASE64` form.
    pub fingerprint: String,
}

/// The previously-trusted keys to show for a changed key: termiHub's own
/// remembered fingerprints and the keys `~/.ssh/known_hosts` recorded, each
/// listed once (#5627). A fingerprint in both keeps the recorded key type.
/// `None` when there is nothing to show.
fn previous_keys(
    remembered: Vec<String>,
    recorded: &[RecordedHostKey],
) -> Option<Vec<PreviousHostKey>> {
    let mut keys: Vec<PreviousHostKey> = Vec::new();
    for fingerprint in remembered {
        if keys.iter().all(|k| k.fingerprint != fingerprint) {
            keys.push(PreviousHostKey {
                key_type: None,
                fingerprint,
            });
        }
    }
    for recorded in recorded {
        match keys.iter_mut().find(|k| k.fingerprint == recorded.fingerprint) {
            Some(known) => known.key_type = Some(recorded.key_type.clone()),
            None => keys.push(PreviousHostKey {
                key_type: Some(recorded.key_type.clone()),
                fingerprint: recorded.fingerprint.clone(),
            }),
        }
    }
    (!keys.is_empty()).then_some(keys)
}

/// `ssh-host-key-prompt-closed` payload: the connect that raised prompt
/// `prompt_id` was aborted or timed out before anybody answered (#5185). The
/// dialog closes; an answer sent anyway is ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SshHostKeyPromptClosedEvent {
    pub prompt_id: String,
}

/// Abstracts frontend event delivery so the verifier is unit-testable without a
/// Tauri runtime. The production impl wraps `tauri::AppHandle`.
pub trait SshHostKeyEventSink: Send + Sync + 'static {
    /// Emit an interactive host-key trust prompt.
    fn emit_prompt(&self, event: &SshHostKeyPromptEvent);

    /// Withdraw a prompt nobody answered because its connect is gone (#5185).
    fn emit_closed(&self, event: &SshHostKeyPromptClosedEvent);
}

impl<R: tauri::Runtime> SshHostKeyEventSink for tauri::AppHandle<R> {
    fn emit_prompt(&self, event: &SshHostKeyPromptEvent) {
        use tauri::Emitter;
        let _ = self.emit("ssh-host-key-prompt", event);
    }

    fn emit_closed(&self, event: &SshHostKeyPromptClosedEvent) {
        use tauri::Emitter;
        let _ = self.emit("ssh-host-key-prompt-closed", event);
    }
}

/// The user's verdict for a pending prompt.
#[derive(Debug, Clone, Copy)]
struct Decision {
    accept: bool,
    remember: bool,
}

/// Desktop SSH host-key verifier backed by a persisted trust store and an
/// interactive prompt.
pub struct SshHostKeyVerifier {
    trust_store: Arc<SshTrustStore>,
    sink: Arc<dyn SshHostKeyEventSink>,
    /// Prompts awaiting a user verdict, keyed by `prompt_id`.
    pending: Mutex<HashMap<String, oneshot::Sender<Decision>>>,
}

/// RAII guard that removes a pending prompt entry when dropped, so the entry is
/// cleaned up even if the `prompt` future is dropped mid-await (e.g. the connect
/// times out) — not only on the normal resolve/reply path (#1979). Without it, a
/// timed-out unknown-host connect leaked one `pending` entry per attempt.
///
/// An entry still present at drop was never answered: its connect gave up. The
/// guard then tells the frontend to close the dialog (#5185); removing the entry
/// is what makes a late answer to it a no-op in [`SshHostKeyVerifier::resolve`].
struct PendingGuard<'a> {
    pending: &'a Mutex<HashMap<String, oneshot::Sender<Decision>>>,
    sink: &'a dyn SshHostKeyEventSink,
    prompt_id: String,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        // Never panic in Drop — a poisoned mutex is recovered, as everywhere
        // else in this verifier, so the entry is still removed.
        let unanswered = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.prompt_id)
            .is_some();
        if unanswered {
            self.sink.emit_closed(&SshHostKeyPromptClosedEvent {
                prompt_id: std::mem::take(&mut self.prompt_id),
            });
        }
    }
}

impl SshHostKeyVerifier {
    /// Build a verifier that persists trust to `trust_store` and prompts through
    /// `sink`.
    pub fn new(trust_store: Arc<SshTrustStore>, sink: Arc<dyn SshHostKeyEventSink>) -> Self {
        Self {
            trust_store,
            sink,
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// The trust store backing this verifier, for the trust-management commands.
    pub fn trust_store(&self) -> &Arc<SshTrustStore> {
        &self.trust_store
    }

    /// Deliver the user's verdict for a pending prompt, unblocking the handshake.
    ///
    /// Returns `true` when a prompt with `prompt_id` was waiting (a stale or
    /// duplicate reply returns `false`). Persisting an accepted-for-host decision
    /// happens on the waiting side once the verdict is received.
    pub fn resolve(&self, prompt_id: &str, accept: bool, remember: bool) -> bool {
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(prompt_id);
        match sender {
            Some(tx) => {
                let _ = tx.send(Decision { accept, remember });
                true
            }
            None => false,
        }
    }

    /// Emit a prompt and await the verdict, returning `false` if the waiting side
    /// is dropped before a reply (e.g. the connect timed out).
    ///
    /// `previous_keys` are the keys trusted for this host before when the
    /// presented key is a *changed* one (UX-034, #5627); `None` for first
    /// contact.
    async fn prompt(
        &self,
        info: &HostKeyInfo,
        changed: bool,
        previous_keys: Option<Vec<PreviousHostKey>>,
    ) -> Decision {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(prompt_id.clone(), tx);
        // Guarantee the pending entry is removed on every exit path — including
        // when this future is dropped mid-await (connect timeout) — not just the
        // normal resolve/reply path (#1979).
        let _guard = PendingGuard {
            pending: &self.pending,
            sink: self.sink.as_ref(),
            prompt_id: prompt_id.clone(),
        };

        if changed {
            warn!(
                host = %info.host,
                port = info.port,
                "SSH host key CHANGED for a previously-trusted host (possible MITM)"
            );
        }

        self.sink.emit_prompt(&SshHostKeyPromptEvent {
            prompt_id: prompt_id.clone(),
            host: info.host.clone(),
            port: info.port,
            key_type: info.key_type.clone(),
            fingerprint: info.fingerprint.clone(),
            changed,
            previous_keys,
            owner: current_prompt_owner(),
        });

        let decision = rx.await.unwrap_or(Decision {
            accept: false,
            remember: false,
        });
        // `_guard` removes the pending entry on drop (here on the reply path, or
        // if this future is cancelled mid-await). `resolve` may have removed it
        // already on the happy path — the guard's remove is then a no-op.
        decision
    }
}

#[async_trait]
impl HostKeyVerifier for SshHostKeyVerifier {
    async fn verify(&self, info: &HostKeyInfo) -> bool {
        self.decide(info).await.is_accepted()
    }

    /// Trust-on-first-use with a prompt; a refusal after the prompt is the
    /// user's own [`HostKeyDecision::RejectedByUser`] (#5185).
    async fn decide(&self, info: &HostKeyInfo) -> HostKeyDecision {
        // Honour the user's own `~/.ssh/known_hosts` first: a key already
        // recorded there is trusted silently, exactly as `ssh` would, without a
        // prompt (#1969 — previously done in the core SSH handler).
        if info.known_hosts == KnownHostsStatus::Match {
            return HostKeyDecision::Accepted;
        }

        let host_port = info.host_port();
        // On a changed key the prompt shows what was trusted before beside the
        // new key (UX-034, #5627): what termiHub's own store remembered and/or
        // what the user's `~/.ssh/known_hosts` recorded.
        let changed = match self.trust_store.lookup(&host_port, &info.fingerprint) {
            // Already trusted → accept without prompting.
            TrustLookup::Trusted => return HostKeyDecision::Accepted,
            // Unknown to termiHub's own store, but if the key is *changed*
            // relative to the user's `~/.ssh/known_hosts` this is the
            // possible-MITM case, so warn as a changed key rather than first
            // contact (#1969 — this previously showed a first-contact prompt).
            TrustLookup::Unknown => info.known_hosts == KnownHostsStatus::Changed,
            // Remembered here with a different key.
            TrustLookup::Changed => true,
        };
        let previous_keys = if changed {
            previous_keys(
                self.trust_store.fingerprints_for(&host_port),
                &info.known_hosts_previous,
            )
        } else {
            None
        };

        let decision = self.prompt(info, changed, previous_keys).await;
        if !decision.accept {
            return HostKeyDecision::RejectedByUser;
        }
        if decision.remember && changed {
            // "Replace trusted key": the old key is no longer trusted (#5627).
            self.trust_store.replace(&host_port, &info.fingerprint);
        } else if decision.remember {
            self.trust_store.remember(&host_port, &info.fingerprint);
        }
        HostKeyDecision::Accepted
    }

    /// An unattended connect (a scheduled run, #3527) never prompts: only a key
    /// already trusted — in `~/.ssh/known_hosts` or remembered here — passes.
    /// An unknown or changed key is refused without asking.
    async fn verify_unattended(&self, info: &HostKeyInfo) -> bool {
        if info.known_hosts == KnownHostsStatus::Match {
            return true;
        }
        // A key changed relative to `~/.ssh/known_hosts` is never trusted
        // silently, even if this store remembers it.
        if info.known_hosts == KnownHostsStatus::Changed {
            warn!(
                host = %info.host,
                port = info.port,
                "unattended connect refused: SSH host key changed from ~/.ssh/known_hosts"
            );
            return false;
        }
        match self
            .trust_store
            .lookup(&info.host_port(), &info.fingerprint)
        {
            TrustLookup::Trusted => true,
            TrustLookup::Unknown | TrustLookup::Changed => {
                warn!(
                    host = %info.host,
                    port = info.port,
                    "unattended connect refused: SSH host key is not trusted"
                );
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ssh_keyboard_interactive::with_prompt_owner;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Records emitted prompts and returns the last `prompt_id` so a test can
    /// resolve it.
    #[derive(Default)]
    struct RecordingSink {
        prompts: Mutex<Vec<SshHostKeyPromptEvent>>,
        count: AtomicUsize,
        dismissed: Mutex<Vec<String>>,
    }

    impl SshHostKeyEventSink for RecordingSink {
        fn emit_prompt(&self, event: &SshHostKeyPromptEvent) {
            self.count.fetch_add(1, Ordering::SeqCst);
            self.prompts
                .lock()
                .expect("prompts mutex")
                .push(event.clone());
        }

        fn emit_closed(&self, event: &SshHostKeyPromptClosedEvent) {
            self.dismissed
                .lock()
                .expect("dismissed mutex")
                .push(event.prompt_id.clone());
        }
    }

    fn info(host: &str, port: u16, fp: &str) -> HostKeyInfo {
        info_kh(host, port, fp, KnownHostsStatus::Unknown)
    }

    fn info_kh(host: &str, port: u16, fp: &str, known_hosts: KnownHostsStatus) -> HostKeyInfo {
        HostKeyInfo {
            host: host.to_string(),
            port,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: fp.to_string(),
            known_hosts,
            known_hosts_previous: Vec::new(),
        }
    }

    /// A previously-trusted key as the prompt carries it.
    fn prev(key_type: Option<&str>, fp: &str) -> PreviousHostKey {
        PreviousHostKey {
            key_type: key_type.map(str::to_string),
            fingerprint: fp.to_string(),
        }
    }

    /// Resolve the single pending prompt after a short spin so `verify` has had
    /// time to register it.
    async fn resolve_when_ready(
        verifier: &Arc<SshHostKeyVerifier>,
        sink: &Arc<RecordingSink>,
        accept: bool,
        remember: bool,
    ) {
        loop {
            let id = sink
                .prompts
                .lock()
                .expect("prompts mutex")
                .last()
                .map(|p| p.prompt_id.clone());
            if let Some(id) = id {
                if verifier.resolve(&id, accept, remember) {
                    return;
                }
            }
            tokio::task::yield_now().await;
        }
    }

    // ── Unattended connects (#3527): never prompt ─────────────────────

    /// A key remembered here or recorded in `~/.ssh/known_hosts` is trusted
    /// unattended, with no prompt.
    #[tokio::test]
    async fn unattended_accepts_only_already_trusted_keys() {
        let store = Arc::new(SshTrustStore::in_memory());
        store.remember("h:22", "SHA256:AA");
        let sink = Arc::new(RecordingSink::default());
        let verifier = SshHostKeyVerifier::new(store, sink.clone());

        assert!(
            verifier
                .verify_unattended(&info("h", 22, "SHA256:AA"))
                .await
        );
        let kh = info_kh("k", 22, "SHA256:KK", KnownHostsStatus::Match);
        assert!(verifier.verify_unattended(&kh).await);
        assert_eq!(sink.count.load(Ordering::SeqCst), 0);
    }

    /// An unknown host, a changed key, and a key changed in known_hosts are all
    /// refused unattended — immediately, without emitting a prompt.
    #[tokio::test]
    async fn unattended_refuses_unknown_and_changed_keys_without_prompting() {
        let store = Arc::new(SshTrustStore::in_memory());
        store.remember("h:22", "SHA256:OLD");
        let sink = Arc::new(RecordingSink::default());
        let verifier = SshHostKeyVerifier::new(store.clone(), sink.clone());

        assert!(
            !verifier
                .verify_unattended(&info("new", 22, "SHA256:N"))
                .await
        );
        assert!(
            !verifier
                .verify_unattended(&info("h", 22, "SHA256:NEW"))
                .await
        );
        store.remember("c:22", "SHA256:C");
        let changed = info_kh("c", 22, "SHA256:C", KnownHostsStatus::Changed);
        assert!(!verifier.verify_unattended(&changed).await);
        assert_eq!(sink.count.load(Ordering::SeqCst), 0, "never prompts");
        assert!(
            !store
                .fingerprints_for("new:22")
                .contains(&"SHA256:N".to_string()),
            "a refusal never remembers the key"
        );
    }

    /// A remembered fingerprint is accepted with no prompt at all.
    #[tokio::test]
    async fn known_host_is_trusted_without_prompt() {
        let store = Arc::new(SshTrustStore::in_memory());
        store.remember("h:22", "SHA256:AA");
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store, sink.clone()));

        assert!(verifier.verify(&info("h", 22, "SHA256:AA")).await);
        assert_eq!(
            sink.count.load(Ordering::SeqCst),
            0,
            "no prompt for a known host"
        );
    }

    /// An unknown host prompts (changed=false); accepting-for-host persists the
    /// fingerprint so the next connect is silent.
    #[tokio::test]
    async fn unknown_host_prompts_and_remember_persists() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store.clone(), sink.clone()));

        let v = verifier.clone();
        let handle = tokio::spawn(async move { v.verify(&info("h", 22, "SHA256:BB")).await });
        resolve_when_ready(&verifier, &sink, true, true).await;

        assert!(handle.await.unwrap(), "accepted key connects");
        let prompt = sink.prompts.lock().unwrap()[0].clone();
        assert!(!prompt.changed, "first contact is not a changed-key prompt");
        assert_eq!(prompt.fingerprint, "SHA256:BB");
        assert!(
            prompt.previous_keys.is_none(),
            "first contact has no previously-trusted fingerprint to show"
        );
        // Remembered: a second verify is silent.
        assert_eq!(store.lookup("h:22", "SHA256:BB"), TrustLookup::Trusted);
        assert!(verifier.verify(&info("h", 22, "SHA256:BB")).await);
        assert_eq!(
            sink.count.load(Ordering::SeqCst),
            1,
            "no re-prompt after remember"
        );
    }

    /// The prompt names the connect that raised it (#5243), so the frontend
    /// pauses that tab's own connect deadline; unscoped, it names none.
    #[tokio::test]
    async fn prompt_carries_the_connects_owner() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store, sink.clone()));

        let v = verifier.clone();
        let owned = tokio::spawn(async move {
            with_prompt_owner(Some("tab-a:2"), v.verify(&info("h", 22, "SHA256:O"))).await
        });
        resolve_when_ready(&verifier, &sink, true, false).await;
        assert!(owned.await.unwrap());

        let v = verifier.clone();
        let unowned = tokio::spawn(async move { v.verify(&info("h", 22, "SHA256:O")).await });
        resolve_when_ready(&verifier, &sink, true, false).await;
        assert!(unowned.await.unwrap());

        let prompts = sink.prompts.lock().unwrap().clone();
        assert_eq!(prompts.len(), 2);
        assert_eq!(prompts[0].owner.as_deref(), Some("tab-a:2"));
        assert_eq!(prompts[1].owner, None);
        let wire = serde_json::to_value(&prompts[0]).unwrap();
        assert_eq!(wire["owner"], "tab-a:2", "the owner is on the wire");
    }

    /// A changed key prompts with `changed=true` and is NOT persisted unless
    /// explicitly accepted-for-host; rejecting it aborts the connect.
    #[tokio::test]
    async fn changed_key_warns_and_reject_aborts() {
        let store = Arc::new(SshTrustStore::in_memory());
        store.remember("h:22", "SHA256:AA");
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store.clone(), sink.clone()));

        let v = verifier.clone();
        let handle = tokio::spawn(async move { v.verify(&info("h", 22, "SHA256:EVIL")).await });
        resolve_when_ready(&verifier, &sink, false, false).await;

        assert!(
            !handle.await.unwrap(),
            "rejecting a changed key aborts the connect"
        );
        let prompt = sink.prompts.lock().unwrap()[0].clone();
        assert!(prompt.changed, "a changed key must flag the MITM warning");
        assert_eq!(
            prompt.previous_keys,
            Some(vec![prev(None, "SHA256:AA")]),
            "a changed key must carry the previously-trusted fingerprint for comparison"
        );
        // The impostor key was not remembered; the original trust stands.
        assert_eq!(store.lookup("h:22", "SHA256:EVIL"), TrustLookup::Changed);
        assert_eq!(store.lookup("h:22", "SHA256:AA"), TrustLookup::Trusted);
    }

    /// "Replace trusted key" on a changed key replaces what was trusted for the
    /// host: the new key is trusted and the old one no longer is (#5627).
    #[tokio::test]
    async fn changed_key_accept_for_host_replaces_the_old_key() {
        let store = Arc::new(SshTrustStore::in_memory());
        store.remember("h:22", "SHA256:AA");
        store.remember("h:22", "SHA256:BB");
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store.clone(), sink.clone()));

        let v = verifier.clone();
        let handle = tokio::spawn(async move { v.verify(&info("h", 22, "SHA256:NEW")).await });
        resolve_when_ready(&verifier, &sink, true, true).await;

        assert!(handle.await.unwrap(), "the replaced key connects");
        assert_eq!(
            store.fingerprints_for("h:22"),
            vec!["SHA256:NEW".to_string()],
            "the old keys are no longer trusted"
        );
        assert_eq!(store.lookup("h:22", "SHA256:AA"), TrustLookup::Changed);
    }

    /// Accept-once (remember=false) connects but does not persist the key.
    #[tokio::test]
    async fn accept_once_does_not_persist() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store.clone(), sink.clone()));

        let v = verifier.clone();
        let handle = tokio::spawn(async move { v.verify(&info("h", 22, "SHA256:CC")).await });
        resolve_when_ready(&verifier, &sink, true, false).await;

        assert!(handle.await.unwrap());
        assert_eq!(
            store.lookup("h:22", "SHA256:CC"),
            TrustLookup::Unknown,
            "accept-once must not remember the key"
        );
    }

    /// A key already present in the user's `~/.ssh/known_hosts` is accepted
    /// silently, with no store lookup and no prompt (#1969).
    #[tokio::test]
    async fn system_known_hosts_match_is_trusted_without_prompt() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store, sink.clone()));

        assert!(
            verifier
                .verify(&info_kh("h", 22, "SHA256:AA", KnownHostsStatus::Match))
                .await
        );
        assert_eq!(
            sink.count.load(Ordering::SeqCst),
            0,
            "a key in ~/.ssh/known_hosts needs no prompt"
        );
    }

    /// A key unknown to termiHub's own store but *changed* in the user's
    /// `~/.ssh/known_hosts` prompts with the changed-key MITM warning, not a
    /// first-contact prompt (#1969).
    #[tokio::test]
    async fn changed_in_system_known_hosts_warns_as_changed() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store.clone(), sink.clone()));

        let v = verifier.clone();
        let handle = tokio::spawn(async move {
            v.verify(&info_kh("h", 22, "SHA256:NEW", KnownHostsStatus::Changed))
                .await
        });
        resolve_when_ready(&verifier, &sink, false, false).await;

        assert!(!handle.await.unwrap(), "rejecting the changed key aborts");
        let prompt = sink.prompts.lock().unwrap()[0].clone();
        assert!(
            prompt.changed,
            "a key changed in ~/.ssh/known_hosts must flag the MITM warning"
        );
        assert!(
            prompt.previous_keys.is_none(),
            "no recorded key was passed in, so there is no prior to show"
        );
    }

    /// A key changed in `~/.ssh/known_hosts` carries the key that file had
    /// recorded — with its key type — so the prompt can show what was trusted
    /// before beside what is presented now (#5627).
    #[tokio::test]
    async fn changed_in_system_known_hosts_carries_the_recorded_key() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store, sink.clone()));

        let mut presented = info_kh("h", 22, "SHA256:NEW", KnownHostsStatus::Changed);
        presented.known_hosts_previous = vec![RecordedHostKey {
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:OLD".to_string(),
        }];
        let v = verifier.clone();
        let handle = tokio::spawn(async move { v.verify(&presented).await });
        resolve_when_ready(&verifier, &sink, false, false).await;

        assert!(!handle.await.unwrap(), "rejecting the changed key aborts");
        let prompt = sink.prompts.lock().unwrap()[0].clone();
        assert!(prompt.changed);
        assert_eq!(
            prompt.previous_keys,
            Some(vec![prev(Some("ssh-ed25519"), "SHA256:OLD")]),
            "the key recorded in ~/.ssh/known_hosts is shown as previously trusted"
        );
    }

    /// When both termiHub's store and `~/.ssh/known_hosts` flag the change, the
    /// prompt lists each previously-trusted key once, preferring the entry that
    /// knows the key type (#5627).
    #[tokio::test]
    async fn changed_in_both_stores_lists_each_prior_once() {
        let store = Arc::new(SshTrustStore::in_memory());
        store.remember("h:22", "SHA256:OLD");
        store.remember("h:22", "SHA256:OLDER");
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store, sink.clone()));

        let mut presented = info_kh("h", 22, "SHA256:NEW", KnownHostsStatus::Changed);
        presented.known_hosts_previous = vec![RecordedHostKey {
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:OLD".to_string(),
        }];
        let v = verifier.clone();
        let handle = tokio::spawn(async move { v.verify(&presented).await });
        resolve_when_ready(&verifier, &sink, false, false).await;

        assert!(!handle.await.unwrap());
        let prompt = sink.prompts.lock().unwrap()[0].clone();
        assert_eq!(
            prompt.previous_keys,
            Some(vec![
                prev(Some("ssh-ed25519"), "SHA256:OLD"),
                prev(None, "SHA256:OLDER"),
            ]),
        );
    }

    /// A changed key with several remembered fingerprints (a rotated host)
    /// surfaces every previously-trusted fingerprint for comparison (UX-034).
    #[tokio::test]
    async fn changed_key_carries_all_remembered_fingerprints() {
        let store = Arc::new(SshTrustStore::in_memory());
        store.remember("h:22", "SHA256:AA");
        store.remember("h:22", "SHA256:BB");
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store, sink.clone()));

        let v = verifier.clone();
        let handle = tokio::spawn(async move { v.verify(&info("h", 22, "SHA256:EVIL")).await });
        resolve_when_ready(&verifier, &sink, false, false).await;

        assert!(!handle.await.unwrap(), "rejecting a changed key aborts");
        let prompt = sink.prompts.lock().unwrap()[0].clone();
        assert!(prompt.changed);
        assert_eq!(
            prompt.previous_keys,
            Some(vec![prev(None, "SHA256:AA"), prev(None, "SHA256:BB")]),
            "all remembered fingerprints must be shown for a rotated host"
        );
    }

    /// A stale/duplicate decision for an unknown prompt id is a no-op.
    #[test]
    fn resolve_unknown_prompt_is_noop() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = SshHostKeyVerifier::new(store, sink);
        assert!(!verifier.resolve("nope", true, true));
    }

    /// A prompt future dropped mid-await (e.g. the connect timed out before the
    /// user answered) must not leak its pending entry (#1979).
    #[tokio::test]
    async fn dropped_prompt_leaves_no_pending_entry() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store, sink.clone()));

        // An unknown host prompts and awaits a verdict; never resolve it, and let
        // the timeout drop the future.
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            verifier.verify(&info("ghost", 22, "SHA256:ZZ")),
        )
        .await;
        assert!(result.is_err(), "verify must not resolve without a verdict");
        assert_eq!(
            sink.count.load(Ordering::SeqCst),
            1,
            "the unknown host should have prompted"
        );

        // The dropped prompt future must have cleaned up its pending entry.
        assert_eq!(
            verifier.pending.lock().expect("pending mutex").len(),
            0,
            "pending prompt entry leaked after the future was dropped"
        );
    }

    // ── Reject vs dismiss (#5185) ─────────────────────────────────────

    /// Rejecting in the prompt is reported as the user's own rejection, so the
    /// connect can say "You rejected the host key" instead of "failed".
    #[tokio::test]
    async fn reject_is_reported_as_rejected_by_user() {
        let store = Arc::new(SshTrustStore::in_memory());
        store.remember("h:22", "SHA256:AA");
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store, sink.clone()));

        let v = verifier.clone();
        let handle = tokio::spawn(async move { v.decide(&info("h", 22, "SHA256:EVIL")).await });
        resolve_when_ready(&verifier, &sink, false, false).await;

        assert_eq!(handle.await.unwrap(), HostKeyDecision::RejectedByUser);
        assert!(
            sink.dismissed.lock().unwrap().is_empty(),
            "an answered prompt is not dismissed"
        );
    }

    /// Trusted keys and accepted prompts decide `Accepted`.
    #[tokio::test]
    async fn trusted_and_accepted_keys_decide_accepted() {
        let store = Arc::new(SshTrustStore::in_memory());
        store.remember("h:22", "SHA256:AA");
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store, sink.clone()));
        assert_eq!(
            verifier.decide(&info("h", 22, "SHA256:AA")).await,
            HostKeyDecision::Accepted
        );

        let v = verifier.clone();
        let handle = tokio::spawn(async move { v.decide(&info("n", 22, "SHA256:N")).await });
        resolve_when_ready(&verifier, &sink, true, false).await;
        assert_eq!(handle.await.unwrap(), HostKeyDecision::Accepted);
    }

    /// A prompt whose connect gave up (the core drops the prompt future on an
    /// abort or timeout) is withdrawn from the frontend, and an answer that
    /// arrives afterwards is ignored — a stale "Accept for host" must never
    /// remember a key for a connect that no longer exists (#5185).
    #[tokio::test]
    async fn abandoned_prompt_is_dismissed_and_a_late_answer_ignored() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = Arc::new(SshHostKeyVerifier::new(store.clone(), sink.clone()));

        let result = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            verifier.decide(&info("late", 22, "SHA256:LATE")),
        )
        .await;
        assert!(result.is_err(), "nobody answered");

        let prompt_id = sink.prompts.lock().unwrap()[0].prompt_id.clone();
        assert_eq!(
            *sink.dismissed.lock().unwrap(),
            vec![prompt_id.clone()],
            "the unanswered prompt must be dismissed exactly once"
        );
        assert!(
            !verifier.resolve(&prompt_id, true, true),
            "a late answer to a dismissed prompt must be ignored"
        );
        assert_eq!(
            store.lookup("late:22", "SHA256:LATE"),
            TrustLookup::Unknown,
            "a late Accept for host must not remember the key"
        );
    }
}
