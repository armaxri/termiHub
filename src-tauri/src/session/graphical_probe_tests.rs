//! Test connection's graphical verdict (#4320, PARITY2-001), driven against a
//! scripted fake backend — no RDP helper or server needed.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

use termihub_core::connection::{
    AuthKind, Capabilities, CertPrompt, CertPromptReceiver, ConnectionType, CursorReceiver,
    FrameReceiver, GraphicalBackend, GraphicalCapabilities, InputEvent, OutputReceiver,
    SettingsSchema,
};
use termihub_core::errors::{ConnectFailureKind, SessionError};
use termihub_core::files::FileBrowser;
use termihub_core::monitoring::MonitoringProvider;

use super::{
    await_verdict, CertReview, CertReviewRequest, CertReviewer, ProbeCertReviews,
    CERT_REVIEW_TIMEOUT,
};
use crate::session::rdp_trust_store::{RdpTrustStore, TrustLookup};

/// The fake's registry type id.
pub(crate) const PROBE_FAKE: &str = "probe-fake";

/// How the fake's asynchronous negotiation ends.
pub(crate) enum Outcome {
    /// The session becomes active.
    Established,
    /// The negotiation never finishes (a peer that never speaks RDP).
    Never,
    /// The negotiation fails with this typed error.
    Fails(SessionError),
    /// The server presents a certificate with this fingerprint; the session is
    /// established once it is accepted and fails once it is declined.
    CertPrompt(String),
    /// Like `CertPrompt`, but once accepted the credentials are rejected.
    CertThenAuthFails(String),
}

impl Clone for Outcome {
    fn clone(&self) -> Self {
        match self {
            Self::Established => Self::Established,
            Self::Never => Self::Never,
            Self::Fails(e) => Self::Fails(clone_error(e)),
            Self::CertPrompt(fingerprint) => Self::CertPrompt(fingerprint.clone()),
            Self::CertThenAuthFails(fingerprint) => Self::CertThenAuthFails(fingerprint.clone()),
        }
    }
}

/// A graphical backend that, like the RDP sidecar, connects at once and
/// negotiates afterwards.
pub(crate) struct ProbeFake {
    outcome: Outcome,
    connected: bool,
    prompts: StdMutex<Option<CertPromptReceiver>>,
    decision: Arc<StdMutex<Option<bool>>>,
    remembered: Arc<StdMutex<Option<bool>>>,
    decided: Arc<Notify>,
}

impl ProbeFake {
    pub(crate) fn new(outcome: Outcome) -> Self {
        Self {
            outcome,
            connected: false,
            prompts: StdMutex::new(None),
            decision: Arc::new(StdMutex::new(None)),
            remembered: Arc::new(StdMutex::new(None)),
            decided: Arc::new(Notify::new()),
        }
    }

    fn connected(outcome: Outcome) -> Self {
        let mut fake = Self::new(outcome);
        fake.open_prompts();
        fake.connected = true;
        fake
    }

    fn open_prompts(&mut self) {
        if let Outcome::CertPrompt(fingerprint) | Outcome::CertThenAuthFails(fingerprint) =
            &self.outcome
        {
            let (tx, rx) = mpsc::channel(1);
            tx.try_send(CertPrompt {
                fingerprint: fingerprint.clone(),
                subject: None,
                issuer: None,
            })
            .expect("queue the prompt");
            *self.prompts.lock().unwrap() = Some(rx);
        }
    }
}

#[async_trait::async_trait]
impl ConnectionType for ProbeFake {
    fn type_id(&self) -> &str {
        PROBE_FAKE
    }
    fn display_name(&self) -> &str {
        "Probe Fake"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: Vec::new() }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: true,
            resize: false,
            persistent: false,
            terminal: false,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        self.open_prompts();
        self.connected = true;
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        self.connected = false;
        Ok(())
    }
    fn is_connected(&self) -> bool {
        self.connected
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        mpsc::channel(1).1
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
    fn graphical(&self) -> Option<&dyn GraphicalBackend> {
        self.connected.then_some(self as &dyn GraphicalBackend)
    }
}

#[async_trait::async_trait]
impl GraphicalBackend for ProbeFake {
    fn graphical_capabilities(&self) -> GraphicalCapabilities {
        GraphicalCapabilities {
            auth_kinds: vec![AuthKind::Password],
            supports_dynamic_resize: false,
            supports_clipboard: false,
            supports_clipboard_image: false,
            view_only_capable: false,
            multi_monitor: Default::default(),
        }
    }
    fn subscribe_frames(&self) -> FrameReceiver {
        mpsc::channel(1).1
    }
    fn subscribe_cursor(&self) -> CursorReceiver {
        mpsc::channel(1).1
    }
    async fn send_input(&self, _event: InputEvent) -> Result<(), SessionError> {
        Ok(())
    }
    async fn resize(&self, _w: u16, _h: u16) -> Result<(), SessionError> {
        Ok(())
    }
    async fn get_clipboard(&self) -> Option<String> {
        None
    }
    async fn set_clipboard(&self, _text: String) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_cert_prompts(&self) -> Option<CertPromptReceiver> {
        self.prompts.lock().unwrap().take()
    }
    async fn send_cert_decision(&self, accept: bool, remember: bool) -> Result<(), SessionError> {
        *self.decision.lock().unwrap() = Some(accept);
        *self.remembered.lock().unwrap() = Some(remember);
        self.decided.notify_one();
        Ok(())
    }
    async fn wait_until_established(&self) -> Result<(), SessionError> {
        match &self.outcome {
            Outcome::Established => Ok(()),
            Outcome::Never => std::future::pending().await,
            Outcome::Fails(e) => Err(clone_error(e)),
            Outcome::CertPrompt(_) | Outcome::CertThenAuthFails(_) => {
                self.decided.notified().await;
                let accepted = *self.decision.lock().unwrap();
                match accepted {
                    Some(true) if matches!(self.outcome, Outcome::CertThenAuthFails(_)) => {
                        Err(SessionError::AuthFailed)
                    }
                    Some(true) => Ok(()),
                    _ => Err(SessionError::ConnectionFailed(
                        "certificate rejected".to_string(),
                    )),
                }
            }
        }
    }
}

/// `SessionError` is not `Clone`; rebuild the variants the tests script.
fn clone_error(e: &SessionError) -> SessionError {
    match e {
        SessionError::AuthFailed => SessionError::AuthFailed,
        SessionError::ConnectionFailed(m) => SessionError::ConnectionFailed(m.clone()),
        SessionError::Classified { kind, message } => SessionError::Classified {
            kind: *kind,
            message: message.clone(),
        },
        other => SessionError::SpawnFailed(other.to_string()),
    }
}

async fn verdict(
    fake: &ProbeFake,
    trust: Option<&RdpTrustStore>,
    timeout: Duration,
) -> Result<(), SessionError> {
    await_verdict(fake, "rdp.example", trust, None, timeout, None).await
}

#[tokio::test]
async fn an_established_session_passes() {
    let fake = ProbeFake::connected(Outcome::Established);
    assert!(verdict(&fake, None, Duration::from_secs(5)).await.is_ok());
}

/// A peer that accepts TCP but never speaks RDP: the probe times out with the
/// typed timeout kind instead of reporting success or hanging.
#[tokio::test(start_paused = true)]
async fn a_peer_that_never_establishes_times_out() {
    let fake = ProbeFake::connected(Outcome::Never);
    match verdict(&fake, None, Duration::from_secs(7)).await {
        Err(SessionError::Classified { kind, message }) => {
            assert_eq!(kind, ConnectFailureKind::Timeout);
            assert!(message.contains("timed out after 7s"), "{message}");
            assert!(message.contains("rdp.example"), "{message}");
        }
        other => panic!("expected a classified timeout, got {other:?}"),
    }
}

/// A closed port: the backend reports the typed unreachable error.
#[tokio::test]
async fn a_refused_connect_reports_unreachable() {
    let fake = ProbeFake::connected(Outcome::Fails(SessionError::ConnectionFailed(
        "connection refused".to_string(),
    )));
    let result = verdict(&fake, None, Duration::from_secs(5)).await;
    assert!(
        matches!(result, Err(SessionError::ConnectionFailed(ref m)) if m.contains("refused")),
        "{result:?}"
    );
}

#[tokio::test]
async fn a_rejected_credential_reports_auth_failed() {
    let fake = ProbeFake::connected(Outcome::Fails(SessionError::AuthFailed));
    let result = verdict(&fake, None, Duration::from_secs(5)).await;
    assert!(
        matches!(result, Err(SessionError::AuthFailed)),
        "{result:?}"
    );
}

/// A certificate the user already trusts for this host is accepted silently,
/// and the probe then waits for the real outcome.
#[tokio::test]
async fn a_trusted_certificate_is_accepted_and_the_probe_continues() {
    let trust = RdpTrustStore::in_memory();
    trust.remember("rdp.example", "AA:BB");
    let fake = ProbeFake::connected(Outcome::CertPrompt("AA:BB".to_string()));
    let result = verdict(&fake, Some(&trust), Duration::from_secs(5)).await;
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(*fake.decision.lock().unwrap(), Some(true));
}

/// An unknown certificate is declined (a probe never asks the user) and
/// reported with the typed "not trusted" kind.
#[tokio::test]
async fn an_unknown_certificate_is_declined_and_reported() {
    let fake = ProbeFake::connected(Outcome::CertPrompt("CC:DD".to_string()));
    match verdict(
        &fake,
        Some(&RdpTrustStore::in_memory()),
        Duration::from_secs(5),
    )
    .await
    {
        Err(SessionError::Classified { kind, message }) => {
            assert_eq!(kind, ConnectFailureKind::HostKeyUntrusted);
            assert!(message.contains("not trusted"), "{message}");
            assert!(message.contains("CC:DD"), "{message}");
        }
        other => panic!("expected an untrusted-certificate verdict, got {other:?}"),
    }
    assert_eq!(*fake.decision.lock().unwrap(), Some(false));
}

/// A certificate that differs from the one trusted for this host is flagged
/// as changed.
#[tokio::test]
async fn a_changed_certificate_is_reported_as_changed() {
    let trust = RdpTrustStore::in_memory();
    trust.remember("rdp.example", "AA:BB");
    let fake = ProbeFake::connected(Outcome::CertPrompt("EE:FF".to_string()));
    match verdict(&fake, Some(&trust), Duration::from_secs(5)).await {
        Err(SessionError::Classified { kind, message }) => {
            assert_eq!(kind, ConnectFailureKind::HostKeyUntrusted);
            assert!(message.contains("changed"), "{message}");
        }
        other => panic!("expected a changed-certificate verdict, got {other:?}"),
    }
}

#[tokio::test]
async fn the_probe_is_cancellable() {
    let fake = ProbeFake::connected(Outcome::Never);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = await_verdict(
        &fake,
        "rdp.example",
        None,
        None,
        Duration::from_secs(600),
        Some(&cancel),
    )
    .await;
    assert!(
        matches!(result, Err(SessionError::SpawnFailed(ref m)) if m.contains("cancelled")),
        "{result:?}"
    );
}

// ── Interactive review during Test connection (#4510) ──────────────

/// A reviewer scripted with the user's verdict (`None` = the dialog went away
/// without one, `Hang` = the user never answers), recording what it was asked.
pub(crate) enum Script {
    Verdict(Option<CertReview>),
    Hang,
}

pub(crate) struct ScriptedReviewer {
    script: Script,
    pub(crate) asked: StdMutex<Vec<CertReviewRequest>>,
}

impl ScriptedReviewer {
    pub(crate) fn new(script: Script) -> Self {
        Self {
            script,
            asked: StdMutex::new(Vec::new()),
        }
    }
    pub(crate) fn answering(accept: bool, remember: bool) -> Self {
        Self::new(Script::Verdict(Some(CertReview { accept, remember })))
    }
}

#[async_trait::async_trait]
impl CertReviewer for ScriptedReviewer {
    async fn review(&self, request: CertReviewRequest) -> Option<CertReview> {
        self.asked.lock().unwrap().push(request);
        match self.script {
            Script::Verdict(verdict) => verdict,
            Script::Hang => std::future::pending().await,
        }
    }
}

async fn reviewed_verdict(
    fake: &ProbeFake,
    trust: &RdpTrustStore,
    reviewer: &ScriptedReviewer,
) -> Result<(), SessionError> {
    await_verdict(
        fake,
        "rdp.example",
        Some(trust),
        Some(reviewer),
        Duration::from_secs(5),
        None,
    )
    .await
}

fn assert_untrusted(result: Result<(), SessionError>, needle: &str) {
    match result {
        Err(SessionError::Classified { kind, message }) => {
            assert_eq!(kind, ConnectFailureKind::HostKeyUntrusted);
            assert!(message.contains(needle), "{message}");
            assert!(message.contains("Nothing was trusted"), "{message}");
        }
        other => panic!("expected an untrusted-certificate verdict, got {other:?}"),
    }
}

/// Accept once: the user's verdict lets the probe continue to the credential
/// check and report its real outcome; nothing is persisted.
#[tokio::test]
async fn accepting_once_continues_to_the_credential_verdict_without_remembering() {
    let trust = RdpTrustStore::in_memory();
    let fake = ProbeFake::connected(Outcome::CertPrompt("CC:DD".to_string()));
    let reviewer = ScriptedReviewer::answering(true, false);

    let result = reviewed_verdict(&fake, &trust, &reviewer).await;

    assert!(result.is_ok(), "{result:?}");
    assert_eq!(*fake.decision.lock().unwrap(), Some(true));
    assert_eq!(*fake.remembered.lock().unwrap(), Some(false));
    assert_eq!(trust.lookup("rdp.example", "CC:DD"), TrustLookup::Unknown);
    let asked = reviewer.asked.lock().unwrap();
    assert_eq!(
        *asked,
        vec![CertReviewRequest {
            host: "rdp.example".to_string(),
            fingerprint: "CC:DD".to_string(),
            subject: None,
            issuer: None,
            changed: false,
        }]
    );
}

/// After an accepted certificate the credential check still decides the
/// verdict: a rejected password is reported as such, not as success.
#[tokio::test]
async fn accepting_reports_a_rejected_credential() {
    let fake = ProbeFake::connected(Outcome::CertThenAuthFails("CC:DD".to_string()));
    let reviewer = ScriptedReviewer::answering(true, false);
    let result = reviewed_verdict(&fake, &RdpTrustStore::in_memory(), &reviewer).await;
    assert!(
        matches!(result, Err(SessionError::AuthFailed)),
        "{result:?}"
    );
}

/// Accept and remember: the certificate is trusted through the trust store a
/// real connect writes, so the next probe accepts it silently.
#[tokio::test]
async fn accepting_and_remembering_persists_through_the_trust_store() {
    let trust = RdpTrustStore::in_memory();
    let fake = ProbeFake::connected(Outcome::CertPrompt("CC:DD".to_string()));
    let reviewer = ScriptedReviewer::answering(true, true);

    let result = reviewed_verdict(&fake, &trust, &reviewer).await;

    assert!(result.is_ok(), "{result:?}");
    assert_eq!(*fake.remembered.lock().unwrap(), Some(true));
    assert_eq!(trust.lookup("rdp.example", "CC:DD"), TrustLookup::Trusted);

    // A second probe never asks again.
    let again = ProbeFake::connected(Outcome::CertPrompt("CC:DD".to_string()));
    let silent = ScriptedReviewer::new(Script::Hang);
    assert!(reviewed_verdict(&again, &trust, &silent).await.is_ok());
    assert!(silent.asked.lock().unwrap().is_empty());
}

/// Reject: the certificate is declined, the trust store is unchanged, and the
/// probe reports it as not trusted.
#[tokio::test]
async fn rejecting_declines_and_leaves_the_trust_store_unchanged() {
    let trust = RdpTrustStore::in_memory();
    let fake = ProbeFake::connected(Outcome::CertPrompt("CC:DD".to_string()));
    // "Reject" with remember set must still trust nothing.
    let reviewer = ScriptedReviewer::answering(false, true);

    let result = reviewed_verdict(&fake, &trust, &reviewer).await;

    assert_untrusted(result, "did not accept");
    assert_eq!(*fake.decision.lock().unwrap(), Some(false));
    assert_eq!(*fake.remembered.lock().unwrap(), Some(false));
    assert_eq!(trust.lookup("rdp.example", "CC:DD"), TrustLookup::Unknown);
}

/// Closing the dialog (no verdict at all) behaves like a reject.
#[tokio::test]
async fn closing_the_dialog_behaves_like_a_reject() {
    let trust = RdpTrustStore::in_memory();
    let fake = ProbeFake::connected(Outcome::CertPrompt("CC:DD".to_string()));
    let reviewer = ScriptedReviewer::new(Script::Verdict(None));

    let result = reviewed_verdict(&fake, &trust, &reviewer).await;

    assert_untrusted(result, "did not accept");
    assert_eq!(*fake.decision.lock().unwrap(), Some(false));
    assert_eq!(trust.lookup("rdp.example", "CC:DD"), TrustLookup::Unknown);
}

/// No verdict within the review timeout behaves like a reject — and the review
/// window does not count against the shorter connect timeout.
#[tokio::test(start_paused = true)]
async fn an_unanswered_review_times_out_like_a_reject() {
    let trust = RdpTrustStore::in_memory();
    let fake = ProbeFake::connected(Outcome::CertPrompt("CC:DD".to_string()));
    let reviewer = ScriptedReviewer::new(Script::Hang);

    let started = tokio::time::Instant::now();
    let result = reviewed_verdict(&fake, &trust, &reviewer).await;

    assert_untrusted(result, "not reviewed within");
    assert!(started.elapsed() >= CERT_REVIEW_TIMEOUT);
    assert_eq!(*fake.decision.lock().unwrap(), Some(false));
    assert_eq!(trust.lookup("rdp.example", "CC:DD"), TrustLookup::Unknown);
}

/// A changed certificate is put to the user flagged as changed, and rejecting
/// it keeps the previously trusted one.
#[tokio::test]
async fn a_changed_certificate_is_reviewed_as_changed() {
    let trust = RdpTrustStore::in_memory();
    trust.remember("rdp.example", "AA:BB");
    let fake = ProbeFake::connected(Outcome::CertPrompt("EE:FF".to_string()));
    let reviewer = ScriptedReviewer::answering(false, false);

    let result = reviewed_verdict(&fake, &trust, &reviewer).await;

    assert_untrusted(result, "did not accept");
    assert!(reviewer.asked.lock().unwrap()[0].changed);
    assert_eq!(trust.lookup("rdp.example", "AA:BB"), TrustLookup::Trusted);
    assert_eq!(trust.lookup("rdp.example", "EE:FF"), TrustLookup::Changed);
}

/// Cancelling the Test while the dialog is open declines the certificate and
/// reports the cancel, trusting nothing.
#[tokio::test]
async fn cancelling_during_review_declines_and_reports_cancelled() {
    let trust = RdpTrustStore::in_memory();
    let fake = ProbeFake::connected(Outcome::CertPrompt("CC:DD".to_string()));
    let reviewer = ScriptedReviewer::new(Script::Hang);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        trigger.cancel();
    });

    let result = await_verdict(
        &fake,
        "rdp.example",
        Some(&trust),
        Some(&reviewer),
        Duration::from_secs(5),
        Some(&cancel),
    )
    .await;

    assert!(
        matches!(result, Err(SessionError::SpawnFailed(ref m)) if m.contains("cancelled")),
        "{result:?}"
    );
    assert_eq!(*fake.decision.lock().unwrap(), Some(false));
    assert_eq!(trust.lookup("rdp.example", "CC:DD"), TrustLookup::Unknown);
}

/// A remembered certificate is accepted silently even when a reviewer exists.
#[tokio::test]
async fn a_trusted_certificate_is_never_put_to_the_reviewer() {
    let trust = RdpTrustStore::in_memory();
    trust.remember("rdp.example", "AA:BB");
    let fake = ProbeFake::connected(Outcome::CertPrompt("AA:BB".to_string()));
    let reviewer = ScriptedReviewer::new(Script::Hang);

    assert!(reviewed_verdict(&fake, &trust, &reviewer).await.is_ok());
    assert!(reviewer.asked.lock().unwrap().is_empty());
}

// ── The review registry the decision command answers ───────────────

#[tokio::test]
async fn the_registry_delivers_the_decision_to_the_waiting_review() {
    let reviews = ProbeCertReviews::default();
    let mut pending = reviews.register("test:1");
    assert!(reviews.decide(
        "test:1",
        CertReview {
            accept: true,
            remember: true
        }
    ));
    assert_eq!(
        pending.verdict().await,
        Some(CertReview {
            accept: true,
            remember: true
        })
    );
    assert!(!reviews.is_pending("test:1"));
}

/// A verdict for another test, or after the review ended (timeout / cancel),
/// reaches nothing.
#[tokio::test]
async fn the_registry_ignores_stray_and_late_decisions() {
    let reviews = ProbeCertReviews::default();
    let verdict = CertReview {
        accept: true,
        remember: true,
    };
    assert!(!reviews.decide("test:none", verdict));

    let pending = reviews.register("test:2");
    assert!(!reviews.decide("test:other", verdict));
    assert!(reviews.is_pending("test:2"));
    drop(pending);
    assert!(!reviews.is_pending("test:2"));
    assert!(!reviews.decide("test:2", verdict));
}

/// A newer review for the same id replaces the old one; dropping the old guard
/// does not unregister the new one.
#[tokio::test]
async fn a_replaced_review_does_not_unregister_its_successor() {
    let reviews = ProbeCertReviews::default();
    let mut first = reviews.register("test:3");
    let second = reviews.register("test:3");
    assert_eq!(first.verdict().await, None);
    drop(first);
    assert!(reviews.is_pending("test:3"));
    drop(second);
    assert!(!reviews.is_pending("test:3"));
}
