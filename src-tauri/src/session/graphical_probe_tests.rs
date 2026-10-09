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

use super::await_verdict;
use crate::session::rdp_trust_store::RdpTrustStore;

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
}

impl Clone for Outcome {
    fn clone(&self) -> Self {
        match self {
            Self::Established => Self::Established,
            Self::Never => Self::Never,
            Self::Fails(e) => Self::Fails(clone_error(e)),
            Self::CertPrompt(fingerprint) => Self::CertPrompt(fingerprint.clone()),
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
    decided: Arc<Notify>,
}

impl ProbeFake {
    pub(crate) fn new(outcome: Outcome) -> Self {
        Self {
            outcome,
            connected: false,
            prompts: StdMutex::new(None),
            decision: Arc::new(StdMutex::new(None)),
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
        if let Outcome::CertPrompt(fingerprint) = &self.outcome {
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
    async fn send_cert_decision(&self, accept: bool, _remember: bool) -> Result<(), SessionError> {
        *self.decision.lock().unwrap() = Some(accept);
        self.decided.notify_one();
        Ok(())
    }
    async fn wait_until_established(&self) -> Result<(), SessionError> {
        match &self.outcome {
            Outcome::Established => Ok(()),
            Outcome::Never => std::future::pending().await,
            Outcome::Fails(e) => Err(clone_error(e)),
            Outcome::CertPrompt(_) => {
                self.decided.notified().await;
                match *self.decision.lock().unwrap() {
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
    await_verdict(fake, "rdp.example", trust, timeout, None).await
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
        Duration::from_secs(600),
        Some(&cancel),
    )
    .await;
    assert!(
        matches!(result, Err(SessionError::SpawnFailed(ref m)) if m.contains("cancelled")),
        "{result:?}"
    );
}
