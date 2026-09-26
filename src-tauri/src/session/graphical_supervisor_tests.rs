//! Auto-reconnect tests for graphical sessions (#3364), driven end to end
//! through [`GraphicalSessionManager`] against a scripted fake backend under
//! paused tokio time — no feature gate, so they run on every per-PR build.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::Instant;

use termihub_core::connection::{
    AuthKind, Capabilities, ConnectionType, ConnectionTypeRegistry, CursorReceiver, CursorUpdate,
    DirtyRect, FrameReceiver, FrameUpdate, GraphicalBackend, GraphicalCapabilities,
    GraphicalState, InputEvent, OutputReceiver, SettingsSchema, MAX_FRAMEBUFFER_DIMENSION,
};
use termihub_core::errors::SessionError;
use termihub_core::files::FileBrowser;
use termihub_core::monitoring::MonitoringProvider;

use crate::session::frame_guard::REJECTED_FRAMES_MESSAGE;
use crate::session::graphical_manager::{
    GraphicalEventSink, GraphicalSessionManager, RemoteDesktopCertPromptEvent,
    RemoteDesktopClipboardEvent, RemoteDesktopCursorEvent, RemoteDesktopFrameEvent,
    RemoteDesktopStateEvent,
};
use crate::session::rdp_trust_store::RdpTrustStore;

const FAKE: &str = "fake-remote-desktop";

/// What the next `connect` of the fake does.
enum Dial {
    /// Connect and keep the stream open.
    Ok,
    /// Connect, but the stream closes before any frame (a flapping server).
    OkThenClose,
    /// Fail the connect.
    Err(SessionError),
}

/// Shared script + observations for every fake instance the registry mints.
#[derive(Default)]
struct Control {
    script: StdMutex<VecDeque<Dial>>,
    dials: AtomicU32,
    /// The live generation's senders, tagged with its dial number.
    frame_tx: StdMutex<Option<(u32, mpsc::Sender<FrameUpdate>)>>,
    cursor_tx: StdMutex<Option<(u32, mpsc::Sender<CursorUpdate>)>>,
    /// `(dial number, width, height)` of every pixel resize a backend received.
    resizes: StdMutex<Vec<(u32, u16, u16)>>,
}

impl Control {
    fn script(&self, dials: impl IntoIterator<Item = Dial>) {
        self.script.lock().unwrap().extend(dials);
    }

    fn dials(&self) -> u32 {
        self.dials.load(Ordering::SeqCst)
    }

    /// Simulate an unexpected transport drop of the live generation.
    fn drop_stream(&self) {
        self.frame_tx.lock().unwrap().take();
        self.cursor_tx.lock().unwrap().take();
    }

    fn frame_sender(&self) -> mpsc::Sender<FrameUpdate> {
        self.frame_tx.lock().unwrap().as_ref().unwrap().1.clone()
    }

    async fn send_frame(&self) {
        self.frame_sender().send(good_frame()).await.unwrap();
    }

    async fn send_cursor(&self) {
        let tx = self.cursor_tx.lock().unwrap().as_ref().unwrap().1.clone();
        tx.send(CursorUpdate {
            x: 1,
            y: 1,
            visible: true,
            shape: None,
        })
        .await
        .unwrap();
    }
}

fn good_frame() -> FrameUpdate {
    FrameUpdate {
        width: 4,
        height: 4,
        rects: vec![DirtyRect {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            data: vec![0; 4],
        }],
    }
}

struct FakeDesktop {
    ctl: Arc<Control>,
    dial: u32,
    frame_rx: StdMutex<Option<FrameReceiver>>,
    cursor_rx: StdMutex<Option<CursorReceiver>>,
}

#[async_trait::async_trait]
impl ConnectionType for FakeDesktop {
    fn type_id(&self) -> &str {
        FAKE
    }
    fn display_name(&self) -> &str {
        "Fake Remote Desktop"
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
        self.dial = self.ctl.dials.fetch_add(1, Ordering::SeqCst) + 1;
        let step = self.ctl.script.lock().unwrap().pop_front().unwrap_or(Dial::Ok);
        let (frame_tx, frame_rx) = mpsc::channel(64);
        let (cursor_tx, cursor_rx) = mpsc::channel(64);
        match step {
            Dial::Err(e) => return Err(e),
            Dial::OkThenClose => {}
            Dial::Ok => {
                *self.ctl.frame_tx.lock().unwrap() = Some((self.dial, frame_tx));
                *self.ctl.cursor_tx.lock().unwrap() = Some((self.dial, cursor_tx));
            }
        }
        *self.frame_rx.lock().unwrap() = Some(frame_rx);
        *self.cursor_rx.lock().unwrap() = Some(cursor_rx);
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        let mine = |slot: &Option<(u32, _)>| matches!(slot, Some((d, _)) if *d == self.dial);
        if mine(&*self.ctl.frame_tx.lock().unwrap()) {
            self.ctl.drop_stream();
        }
        Ok(())
    }
    fn is_connected(&self) -> bool {
        self.dial > 0
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
        (self.dial > 0).then_some(self as &dyn GraphicalBackend)
    }
}

#[async_trait::async_trait]
impl GraphicalBackend for FakeDesktop {
    fn graphical_capabilities(&self) -> GraphicalCapabilities {
        GraphicalCapabilities {
            auth_kinds: vec![AuthKind::None],
            supports_dynamic_resize: true,
            supports_clipboard: false,
            view_only_capable: false,
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
        self.cursor_rx
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| mpsc::channel(1).1)
    }
    async fn send_input(&self, _event: InputEvent) -> Result<(), SessionError> {
        Ok(())
    }
    async fn resize(&self, width_px: u16, height_px: u16) -> Result<(), SessionError> {
        self.ctl
            .resizes
            .lock()
            .unwrap()
            .push((self.dial, width_px, height_px));
        Ok(())
    }
    async fn get_clipboard(&self) -> Option<String> {
        None
    }
    async fn set_clipboard(&self, _text: String) -> Result<(), SessionError> {
        Ok(())
    }
}

#[derive(Clone, Default)]
struct Sink {
    frames: Arc<AtomicU32>,
    cursors: Arc<AtomicU32>,
    states: Arc<StdMutex<Vec<RemoteDesktopStateEvent>>>,
}

impl Sink {
    fn states(&self) -> Vec<RemoteDesktopStateEvent> {
        self.states.lock().unwrap().clone()
    }
    fn last(&self) -> Option<RemoteDesktopStateEvent> {
        self.states.lock().unwrap().last().cloned()
    }
    /// The `(state, attempt)` pairs emitted after the first `skip` events.
    fn tail(&self, skip: usize) -> Vec<(GraphicalState, u32)> {
        self.states()
            .into_iter()
            .skip(skip)
            .map(|e| (e.state, e.reconnect_attempt))
            .collect()
    }
}

impl GraphicalEventSink for Sink {
    fn emit_frame(&self, _event: &RemoteDesktopFrameEvent) {
        self.frames.fetch_add(1, Ordering::SeqCst);
    }
    fn emit_cursor(&self, _event: &RemoteDesktopCursorEvent) {
        self.cursors.fetch_add(1, Ordering::SeqCst);
    }
    fn emit_clipboard(&self, _event: &RemoteDesktopClipboardEvent) {}
    fn emit_state(&self, event: &RemoteDesktopStateEvent) {
        self.states.lock().unwrap().push(event.clone());
    }
    fn emit_cert_prompt(&self, _event: &RemoteDesktopCertPromptEvent) {}
}

struct Harness {
    mgr: GraphicalSessionManager,
    ctl: Arc<Control>,
    sink: Sink,
    sid: String,
}

/// Connect a fake session with `settings`, after scripting the dials that
/// follow the (always successful) initial connect.
async fn open(settings: serde_json::Value, redials: Vec<Dial>) -> Harness {
    let ctl = Arc::new(Control::default());
    let mut registry = ConnectionTypeRegistry::new();
    let factory_ctl = ctl.clone();
    registry.register(
        FAKE,
        "Fake Remote Desktop",
        "monitor",
        Box::new(move || {
            Box::new(FakeDesktop {
                ctl: factory_ctl.clone(),
                dial: 0,
                frame_rx: StdMutex::new(None),
                cursor_rx: StdMutex::new(None),
            })
        }),
    );
    ctl.script([Dial::Ok]);
    ctl.script(redials);
    let mgr = GraphicalSessionManager::new(Arc::new(registry), Arc::new(RdpTrustStore::in_memory()));
    let sink = Sink::default();
    let sid = mgr
        .connect(FAKE, settings, sink.clone())
        .await
        .expect("initial connect");
    assert_eq!(
        sink.tail(0),
        vec![
            (GraphicalState::Connecting, 0),
            (GraphicalState::Authenticating, 0),
            (GraphicalState::Active, 0),
        ]
    );
    Harness {
        mgr,
        ctl,
        sink,
        sid,
    }
}

/// Advance (paused) time in small steps until `cond` holds, failing after a
/// generous virtual deadline.
async fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(300);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Let a long stretch of virtual time pass (to prove nothing else happens).
async fn idle() {
    tokio::time::sleep(Duration::from_secs(120)).await;
}

fn last_state(sink: &Sink) -> Option<GraphicalState> {
    sink.last().map(|e| e.state)
}

#[tokio::test(start_paused = true)]
async fn drop_reconnects_reattaches_pumps_and_resends_size() {
    let h = open(serde_json::json!({}), vec![Dial::Ok]).await;
    h.ctl.send_frame().await;
    wait_until("first frame", || h.sink.frames.load(Ordering::SeqCst) == 1).await;
    h.mgr
        .resize(&h.sid, 640, 480, h.sink.clone())
        .await
        .expect("resize");
    let before = h.sink.states().len();

    let dropped_at = Instant::now();
    h.ctl.drop_stream();
    wait_until("re-dial", || h.ctl.dials() == 2).await;
    // The first retry waits out the shared schedule's 1 s base delay.
    assert!(dropped_at.elapsed() >= Duration::from_secs(1));
    assert_eq!(h.sink.tail(before), vec![(GraphicalState::Reconnecting, 1)]);

    // The reconnected stream's first frame proves the attempt: Active again,
    // and the frame reaches the frontend through the re-attached frame pump.
    h.ctl.send_frame().await;
    wait_until("reconnected frame", || {
        h.sink.frames.load(Ordering::SeqCst) == 2
    })
    .await;
    assert_eq!(
        h.sink.tail(before),
        vec![
            (GraphicalState::Reconnecting, 1),
            (GraphicalState::Active, 0)
        ]
    );
    // The cursor pump was re-attached to the new generation too.
    h.ctl.send_cursor().await;
    wait_until("reconnected cursor", || {
        h.sink.cursors.load(Ordering::SeqCst) == 1
    })
    .await;
    // The last requested size was re-sent to the new backend instance.
    assert!(h.ctl.resizes.lock().unwrap().contains(&(2, 640, 480)));
    // Commands reach the swapped-in connection.
    h.mgr
        .send_input(
            &h.sid,
            InputEvent::Key {
                code: "KeyA".into(),
                pressed: true,
            },
        )
        .await
        .expect("input after reconnect");

    // A painted reconnect restores the full budget: the next drop starts over
    // at attempt 1.
    let before = h.sink.states().len();
    h.ctl.drop_stream();
    wait_until("second re-dial", || h.ctl.dials() == 3).await;
    assert_eq!(h.sink.tail(before), vec![(GraphicalState::Reconnecting, 1)]);
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn exhausted_budget_rests_disconnected_after_three_backed_off_attempts() {
    let refused = || Dial::Err(SessionError::ConnectionFailed("refused".into()));
    let h = open(serde_json::json!({}), vec![refused(), refused(), refused()]).await;
    let before = h.sink.states().len();

    let dropped_at = Instant::now();
    h.ctl.drop_stream();
    wait_until("give up", || {
        last_state(&h.sink) == Some(GraphicalState::Disconnected)
    })
    .await;
    // Backoff schedule 1 s + 2 s + 4 s before the three attempts.
    assert!(dropped_at.elapsed() >= Duration::from_secs(7));
    assert_eq!(
        h.sink.tail(before),
        vec![
            (GraphicalState::Reconnecting, 1),
            (GraphicalState::Reconnecting, 2),
            (GraphicalState::Reconnecting, 3),
            (GraphicalState::Disconnected, 3),
        ]
    );
    let message = h.sink.last().and_then(|e| e.message).unwrap_or_default();
    assert!(message.contains("Reconnect failed after 3 attempts"), "{message}");
    assert!(message.contains("refused"), "{message}");

    idle().await;
    assert_eq!(h.ctl.dials(), 4, "no attempts beyond the budget");
}

#[tokio::test(start_paused = true)]
async fn auto_reconnect_off_goes_straight_to_disconnected() {
    let h = open(serde_json::json!({ "autoReconnect": false }), Vec::new()).await;
    h.ctl.drop_stream();
    wait_until("disconnected", || {
        last_state(&h.sink) == Some(GraphicalState::Disconnected)
    })
    .await;
    idle().await;
    assert_eq!(h.ctl.dials(), 1, "no re-dial with Auto-Reconnect off");
    assert_eq!(h.sink.tail(3), vec![(GraphicalState::Disconnected, 0)]);
    assert_eq!(h.sink.last().unwrap().message, None);
}

#[tokio::test(start_paused = true)]
async fn legacy_resilient_reconnect_off_is_honoured() {
    let h = open(serde_json::json!({ "resilientReconnect": false }), Vec::new()).await;
    h.ctl.drop_stream();
    wait_until("disconnected", || {
        last_state(&h.sink) == Some(GraphicalState::Disconnected)
    })
    .await;
    idle().await;
    assert_eq!(h.ctl.dials(), 1);
}

#[tokio::test(start_paused = true)]
async fn auth_failure_on_redial_is_terminal() {
    let h = open(serde_json::json!({}), vec![Dial::Err(SessionError::AuthFailed)]).await;
    h.ctl.drop_stream();
    wait_until("auth failed", || {
        last_state(&h.sink) == Some(GraphicalState::AuthFailed)
    })
    .await;
    idle().await;
    assert_eq!(h.ctl.dials(), 2, "no retry after an auth rejection");
    assert_eq!(
        h.sink.tail(3),
        vec![
            (GraphicalState::Reconnecting, 1),
            (GraphicalState::AuthFailed, 1)
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn invalid_config_on_redial_is_terminal() {
    let h = open(
        serde_json::json!({}),
        vec![Dial::Err(SessionError::InvalidConfig("bad".into()))],
    )
    .await;
    h.ctl.drop_stream();
    wait_until("connect failed", || {
        last_state(&h.sink) == Some(GraphicalState::ConnectFailed)
    })
    .await;
    idle().await;
    assert_eq!(h.ctl.dials(), 2);
}

#[tokio::test(start_paused = true)]
async fn hostile_stream_stop_is_terminal() {
    let h = open(serde_json::json!({}), Vec::new()).await;
    let bad = FrameUpdate {
        width: MAX_FRAMEBUFFER_DIMENSION * 2,
        height: 1,
        rects: Vec::new(),
    };
    let tx = h.ctl.frame_sender();
    // Keep sending until the guard aborts the pump and closes the channel.
    while tx.send(bad.clone()).await.is_ok() {}
    wait_until("hostile stop", || {
        last_state(&h.sink) == Some(GraphicalState::Disconnected)
    })
    .await;
    idle().await;
    assert_eq!(h.ctl.dials(), 1, "never re-dial a hostile server");
    let last = h.sink.last().unwrap();
    assert_eq!(last.message.as_deref(), Some(REJECTED_FRAMES_MESSAGE));
    assert!(h
        .sink
        .states()
        .iter()
        .all(|e| e.state != GraphicalState::Reconnecting));
}

#[tokio::test(start_paused = true)]
async fn user_disconnect_while_active_never_reconnects() {
    let h = open(serde_json::json!({}), Vec::new()).await;
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
    idle().await;
    assert_eq!(h.ctl.dials(), 1);
    assert_eq!(last_state(&h.sink), Some(GraphicalState::Closed));
}

#[tokio::test(start_paused = true)]
async fn user_disconnect_during_backoff_cancels_the_retry() {
    let h = open(serde_json::json!({}), Vec::new()).await;
    h.ctl.drop_stream();
    wait_until("reconnecting", || {
        last_state(&h.sink) == Some(GraphicalState::Reconnecting)
    })
    .await;
    // Cancel before the 1 s backoff elapses.
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
    idle().await;
    assert_eq!(h.ctl.dials(), 1, "the pending attempt was cancelled");
    assert_eq!(last_state(&h.sink), Some(GraphicalState::Closed));
    assert_eq!(h.mgr.session_count().await, 0);
}

#[tokio::test(start_paused = true)]
async fn reconnect_that_closes_before_painting_is_a_failed_attempt() {
    // A flapping server accepts the dial but drops before a frame. Counting
    // that as success would reset the budget on every dial and loop forever.
    let h = open(
        serde_json::json!({}),
        vec![Dial::OkThenClose, Dial::OkThenClose, Dial::OkThenClose],
    )
    .await;
    h.ctl.drop_stream();
    wait_until("give up", || {
        last_state(&h.sink) == Some(GraphicalState::Disconnected)
    })
    .await;
    idle().await;
    assert_eq!(h.ctl.dials(), 4);
    assert_eq!(
        h.sink.tail(3),
        vec![
            (GraphicalState::Reconnecting, 1),
            (GraphicalState::Reconnecting, 2),
            (GraphicalState::Reconnecting, 3),
            (GraphicalState::Disconnected, 3),
        ]
    );
}
