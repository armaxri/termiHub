//! A graphical tab is `Active` only once the backend says the session is
//! established (#6062): the RDP helper dials, negotiates TLS and signs in after
//! `connect()` returned. Driven through [`GraphicalSessionManager`] against a
//! fake backend whose establishment the test holds, fails or lets time out.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::{mpsc, watch};

use termihub_core::connection::{
    AuthKind, Capabilities, CertPrompt, CertPromptReceiver, ConnectionType, ConnectionTypeRegistry,
    CursorReceiver, FrameReceiver, FrameUpdate, GraphicalBackend, GraphicalCapabilities,
    GraphicalState, InputEvent, OutputReceiver, SettingsSchema,
};
use termihub_core::errors::SessionError;
use termihub_core::files::FileBrowser;
use termihub_core::monitoring::MonitoringProvider;

use crate::session::graphical_manager::{
    GraphicalEventSink, GraphicalSessionManager, RemoteDesktopCertPromptEvent,
    RemoteDesktopClipboardEvent, RemoteDesktopCursorEvent, RemoteDesktopFrameEvent,
    RemoteDesktopStateEvent,
};
use crate::session::rdp_trust_store::RdpTrustStore;

const FAKE: &str = "fake-establishing-desktop";

/// Why the helper gave up.
#[derive(Clone, Copy)]
enum Fail {
    Auth,
    Connect(&'static str),
}

impl Fail {
    fn error(self) -> SessionError {
        match self {
            Fail::Auth => SessionError::AuthFailed,
            Fail::Connect(why) => SessionError::ConnectionFailed(why.into()),
        }
    }
}

/// What the test controls of every fake instance.
struct Control {
    /// `None` while establishing; `Some(None)` established; `Some(Some(e))` failed with `e`.
    established: watch::Sender<Option<Option<Fail>>>,
    /// The helper's own lifecycle state.
    phase: watch::Sender<GraphicalState>,
    frame_tx: StdMutex<Option<mpsc::Sender<FrameUpdate>>>,
    cert_tx: StdMutex<Option<mpsc::Sender<CertPrompt>>>,
    dials: AtomicU32,
    fatal: StdMutex<Option<Fail>>,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            established: watch::channel(None).0,
            phase: watch::channel(GraphicalState::Connecting).0,
            frame_tx: StdMutex::new(None),
            cert_tx: StdMutex::new(None),
            dials: AtomicU32::new(0),
            fatal: StdMutex::new(None),
        }
    }
}

impl Control {
    /// The helper signed in: it says so, and its session is established.
    fn establish(&self) {
        self.phase.send_replace(GraphicalState::Active);
        self.established.send_replace(Some(None));
    }

    /// The helper gave up: it reports `error`, and its output ends.
    fn fail(&self, why: Fail) {
        *self.fatal.lock().unwrap() = Some(why);
        self.phase.send_replace(match why {
            Fail::Auth => GraphicalState::AuthFailed,
            Fail::Connect(_) => GraphicalState::ConnectFailed,
        });
        self.established.send_replace(Some(Some(why)));
        self.frame_tx.lock().unwrap().take();
    }
}

struct Fake {
    ctl: Arc<Control>,
    dialed: bool,
    frame_rx: StdMutex<Option<FrameReceiver>>,
    cert_rx: StdMutex<Option<CertPromptReceiver>>,
}

#[async_trait::async_trait]
impl ConnectionType for Fake {
    fn type_id(&self) -> &str {
        FAKE
    }
    fn display_name(&self) -> &str {
        "Fake"
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
        self.ctl.dials.fetch_add(1, Ordering::SeqCst);
        self.dialed = true;
        let (frame_tx, frame_rx) = mpsc::channel(8);
        let (cert_tx, cert_rx) = mpsc::channel(8);
        *self.ctl.frame_tx.lock().unwrap() = Some(frame_tx);
        *self.ctl.cert_tx.lock().unwrap() = Some(cert_tx);
        *self.frame_rx.lock().unwrap() = Some(frame_rx);
        *self.cert_rx.lock().unwrap() = Some(cert_rx);
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        self.ctl.frame_tx.lock().unwrap().take();
        Ok(())
    }
    fn is_connected(&self) -> bool {
        self.dialed
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
        self.dialed.then_some(self as &dyn GraphicalBackend)
    }
    fn establishes_after_connect(&self) -> bool {
        true
    }
}

#[async_trait::async_trait]
impl GraphicalBackend for Fake {
    fn graphical_capabilities(&self) -> GraphicalCapabilities {
        GraphicalCapabilities {
            auth_kinds: vec![AuthKind::None],
            supports_dynamic_resize: false,
            supports_clipboard: false,
            supports_clipboard_image: false,
            view_only_capable: false,
            multi_monitor: Default::default(),
        }
    }
    fn subscribe_frames(&self) -> FrameReceiver {
        self.frame_rx
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| mpsc::channel(1).1)
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
        self.cert_rx.lock().unwrap().take()
    }
    fn fatal_error(&self) -> Option<SessionError> {
        self.ctl.fatal.lock().unwrap().map(Fail::error)
    }
    fn connect_states(&self) -> Option<watch::Receiver<GraphicalState>> {
        Some(self.ctl.phase.subscribe())
    }
    async fn wait_until_established(&self) -> Result<(), SessionError> {
        let mut rx = self.ctl.established.subscribe();
        let outcome = rx.wait_for(Option::is_some).await.map(|o| o.flatten());
        match outcome {
            Ok(None) => Ok(()),
            Ok(Some(why)) => Err(why.error()),
            Err(_) => Err(SessionError::ConnectionFailed("gone".into())),
        }
    }
}

#[derive(Clone, Default)]
struct Sink {
    states: Arc<StdMutex<Vec<RemoteDesktopStateEvent>>>,
    prompts: Arc<AtomicU32>,
}

impl Sink {
    fn states(&self) -> Vec<GraphicalState> {
        self.states
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.state)
            .collect()
    }
    fn last(&self) -> RemoteDesktopStateEvent {
        self.states
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("a state")
    }
}

impl GraphicalEventSink for Sink {
    fn emit_frame(&self, _: &RemoteDesktopFrameEvent) {}
    fn emit_cursor(&self, _: &RemoteDesktopCursorEvent) {}
    fn emit_clipboard(&self, _: &RemoteDesktopClipboardEvent) {}
    fn emit_state(&self, event: &RemoteDesktopStateEvent) {
        self.states.lock().unwrap().push(event.clone());
    }
    fn emit_cert_prompt(&self, _: &RemoteDesktopCertPromptEvent) {
        self.prompts.fetch_add(1, Ordering::SeqCst);
    }
}

struct Harness {
    mgr: GraphicalSessionManager,
    ctl: Arc<Control>,
    sink: Sink,
    sid: String,
}

async fn open(settings: serde_json::Value) -> Harness {
    let ctl = Arc::new(Control::default());
    let mut registry = ConnectionTypeRegistry::new();
    let factory = ctl.clone();
    registry.register(
        FAKE,
        "Fake",
        "monitor",
        Box::new(move || {
            Box::new(Fake {
                ctl: factory.clone(),
                dialed: false,
                frame_rx: StdMutex::new(None),
                cert_rx: StdMutex::new(None),
            })
        }),
    );
    let mgr =
        GraphicalSessionManager::new(Arc::new(registry), Arc::new(RdpTrustStore::in_memory()));
    let sink = Sink::default();
    let sid = mgr
        .connect(FAKE, settings, sink.clone())
        .await
        .expect("the helper started");
    Harness {
        mgr,
        ctl,
        sink,
        sid,
    }
}

/// Let the session's tasks run for `secs` of (paused) time.
async fn pass(secs: u64) {
    for _ in 0..secs * 10 {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

const SETTINGS: fn() -> serde_json::Value =
    || serde_json::json!({ "connectTimeoutSecs": 10, "autoReconnect": true });

#[tokio::test(start_paused = true)]
async fn says_active_only_once_the_session_is_established() {
    let h = open(SETTINGS()).await;
    pass(1).await;
    assert_eq!(h.sink.states(), vec![GraphicalState::Connecting]);

    h.ctl.phase.send_replace(GraphicalState::Authenticating);
    pass(1).await;
    assert_eq!(
        h.sink.states(),
        vec![GraphicalState::Connecting, GraphicalState::Authenticating]
    );

    h.ctl.establish();
    pass(1).await;
    assert_eq!(h.sink.last().state, GraphicalState::Active);
    let _ = h.mgr.disconnect(&h.sid, h.sink.clone()).await;
}

#[tokio::test(start_paused = true)]
async fn a_rejected_logon_is_an_auth_failure_and_never_re_dialed() {
    let h = open(SETTINGS()).await;
    h.ctl.fail(Fail::Auth);
    pass(120).await;
    let states = h.sink.states();
    assert!(!states.contains(&GraphicalState::Active), "{states:?}");
    assert_eq!(h.sink.last().state, GraphicalState::AuthFailed);
    assert_eq!(h.ctl.dials.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_failure_before_the_logon_is_a_connect_failure_with_its_reason() {
    let h = open(SETTINGS()).await;
    h.ctl.fail(Fail::Connect("TLS handshake refused"));
    pass(120).await;
    let last = h.sink.last();
    assert_eq!(last.state, GraphicalState::ConnectFailed);
    assert!(
        last.message
            .as_deref()
            .unwrap_or("")
            .contains("TLS handshake refused"),
        "{last:?}"
    );
    assert!(!h.sink.states().contains(&GraphicalState::Active));
    assert!(!h.sink.states().contains(&GraphicalState::Reconnecting));
    assert_eq!(h.ctl.dials.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_helper_that_never_gets_there_times_out() {
    let h = open(SETTINGS()).await;
    pass(60).await;
    let last = h.sink.last();
    assert_eq!(last.state, GraphicalState::ConnectFailed);
    assert!(
        last.message.as_deref().unwrap_or("").contains("timed out"),
        "{last:?}"
    );
    assert!(!h.sink.states().contains(&GraphicalState::Active));
    assert_eq!(h.ctl.dials.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn the_timeout_waits_while_the_user_reads_a_certificate() {
    let h = open(SETTINGS()).await;
    let cert = h
        .ctl
        .cert_tx
        .lock()
        .unwrap()
        .clone()
        .expect("prompt channel");
    cert.send(CertPrompt {
        fingerprint: "sha256:AA".into(),
        subject: None,
        issuer: None,
        host: None,
    })
    .await
    .expect("prompt");
    pass(1).await;
    assert_eq!(
        h.sink.prompts.load(Ordering::SeqCst),
        1,
        "the prompt reaches the user"
    );
    pass(120).await;
    assert!(
        !h.sink.states().contains(&GraphicalState::ConnectFailed),
        "{:?}",
        h.sink.states()
    );
    h.mgr
        .cert_decision(&h.sid, true, false)
        .await
        .expect("decision");
    h.ctl.establish();
    pass(1).await;
    assert_eq!(h.sink.last().state, GraphicalState::Active);
    let _ = h.mgr.disconnect(&h.sid, h.sink.clone()).await;
}
