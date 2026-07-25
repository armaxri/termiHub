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
//! is not prompted again; plain "Accept" is session-scoped; "Reject" (or the
//! dialog being dismissed / the prompt future being dropped) aborts the connect.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::Serialize;
use termihub_core::backends::ssh::host_key::{HostKeyInfo, HostKeyVerifier, KnownHostsStatus};
use tokio::sync::oneshot;
use tracing::warn;

use super::ssh_trust_store::{SshTrustStore, TrustLookup};

/// `ssh-host-key-prompt` payload: a server presented an untrusted host key that
/// needs an interactive trust decision (#1959).
///
/// `changed` distinguishes first contact (`false`) from a *changed* fingerprint
/// for a previously-trusted host (`true`) — the possible-MITM case the dialog
/// warns about prominently. `prompt_id` correlates the reply
/// (`ssh_host_key_decision`) back to the blocked handshake.
#[derive(Debug, Clone, Serialize)]
pub struct SshHostKeyPromptEvent {
    pub prompt_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub changed: bool,
}

/// Abstracts frontend event delivery so the verifier is unit-testable without a
/// Tauri runtime. The production impl wraps `tauri::AppHandle`.
pub trait SshHostKeyEventSink: Send + Sync + 'static {
    /// Emit an interactive host-key trust prompt.
    fn emit_prompt(&self, event: &SshHostKeyPromptEvent);
}

impl<R: tauri::Runtime> SshHostKeyEventSink for tauri::AppHandle<R> {
    fn emit_prompt(&self, event: &SshHostKeyPromptEvent) {
        use tauri::Emitter;
        let _ = self.emit("ssh-host-key-prompt", event);
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
            .expect("ssh host-key pending mutex poisoned")
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
    async fn prompt(&self, info: &HostKeyInfo, changed: bool) -> Decision {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("ssh host-key pending mutex poisoned")
            .insert(prompt_id.clone(), tx);

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
        });

        let decision = rx.await.unwrap_or(Decision {
            accept: false,
            remember: false,
        });
        // Best-effort cleanup for the dropped/rejected path (resolve already
        // removed it on the happy path).
        self.pending
            .lock()
            .expect("ssh host-key pending mutex poisoned")
            .remove(&prompt_id);
        decision
    }
}

#[async_trait]
impl HostKeyVerifier for SshHostKeyVerifier {
    async fn verify(&self, info: &HostKeyInfo) -> bool {
        // Honour the user's own `~/.ssh/known_hosts` first: a key already
        // recorded there is trusted silently, exactly as `ssh` would, without a
        // prompt (#1969 — previously done in the core SSH handler).
        if info.known_hosts == KnownHostsStatus::Match {
            return true;
        }

        let host_port = info.host_port();
        let changed = match self.trust_store.lookup(&host_port, &info.fingerprint) {
            // Already trusted → accept without prompting.
            TrustLookup::Trusted => return true,
            // Unknown to termiHub's own store, but if the key is *changed*
            // relative to the user's `~/.ssh/known_hosts` this is the possible-
            // MITM case, so warn as a changed key rather than first contact
            // (#1969 — this previously showed a first-contact prompt).
            TrustLookup::Unknown => info.known_hosts == KnownHostsStatus::Changed,
            TrustLookup::Changed => true,
        };

        let decision = self.prompt(info, changed).await;
        if decision.accept && decision.remember {
            self.trust_store.remember(&host_port, &info.fingerprint);
        }
        decision.accept
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Records emitted prompts and returns the last `prompt_id` so a test can
    /// resolve it.
    #[derive(Default)]
    struct RecordingSink {
        prompts: Mutex<Vec<SshHostKeyPromptEvent>>,
        count: AtomicUsize,
    }

    impl SshHostKeyEventSink for RecordingSink {
        fn emit_prompt(&self, event: &SshHostKeyPromptEvent) {
            self.count.fetch_add(1, Ordering::SeqCst);
            self.prompts
                .lock()
                .expect("prompts mutex")
                .push(event.clone());
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
        // Remembered: a second verify is silent.
        assert_eq!(store.lookup("h:22", "SHA256:BB"), TrustLookup::Trusted);
        assert!(verifier.verify(&info("h", 22, "SHA256:BB")).await);
        assert_eq!(
            sink.count.load(Ordering::SeqCst),
            1,
            "no re-prompt after remember"
        );
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
        // The impostor key was not remembered; the original trust stands.
        assert_eq!(store.lookup("h:22", "SHA256:EVIL"), TrustLookup::Changed);
        assert_eq!(store.lookup("h:22", "SHA256:AA"), TrustLookup::Trusted);
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
    }

    /// A stale/duplicate decision for an unknown prompt id is a no-op.
    #[test]
    fn resolve_unknown_prompt_is_noop() {
        let store = Arc::new(SshTrustStore::in_memory());
        let sink = Arc::new(RecordingSink::default());
        let verifier = SshHostKeyVerifier::new(store, sink);
        assert!(!verifier.resolve("nope", true, true));
    }
}
