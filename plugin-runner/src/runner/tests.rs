//! Teardown order of the session server (TBE2-004, #4341): every session's
//! backend is closed and destroyed **before** the plugin library's
//! `plugin_shutdown` runs and the library unmaps. A backend's vtable and state
//! point into the mapped library, so the reverse order is a use-after-free.
//!
//! These mirror the in-process host tests the sandbox cut-over removed
//! (`library_stays_mapped_until_the_last_arc_drops` and friends, #2968).

use std::cell::RefCell;
use std::sync::mpsc::channel;

use termihub_plugin_api::{PluginBackend, PluginTerminalBackend, CURRENT_PLUGIN_ABI_VERSION};
use termihub_plugin_runner::ipc::{Cancel, ResourceLimits};
use termihub_plugin_runner::loader::LoadedPluginInfo;

use super::*;

thread_local! {
    /// What happened, in order. Teardown runs every backend and library call
    /// on the calling thread, so a per-test-thread log keeps tests apart.
    static EVENTS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn record(event: String) {
    EVENTS.with(|events| events.borrow_mut().push(event));
}

fn events() -> Vec<String> {
    EVENTS.with(|events| events.borrow().clone())
}

unsafe extern "C" fn record_shutdown() {
    record("shutdown".to_owned());
}

/// A backend that records `close` and its own destruction (`destroy`).
struct Probe(u32);

impl PluginTerminalBackend for Probe {
    fn write_input(&self, _data: &[u8]) -> Result<(), PluginError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), PluginError> {
        Ok(())
    }
    fn close(&self) -> Result<(), PluginError> {
        record(format!("close:{}", self.0));
        Ok(())
    }
    fn is_alive(&self) -> bool {
        true
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        record(format!("destroy:{}", self.0));
    }
}

fn configure() -> Configure {
    Configure {
        library_path: String::new(),
        expected_digest: None,
        manifest_api_version: None,
        accept_unverified_toolchain: false,
        plugin_id: "probe".to_owned(),
        host_version: "0.0.0".to_owned(),
        limits: ResourceLimits::default(),
        sandbox: None,
        accept_reduced_isolation: false,
    }
}

/// A server around the stub library, with a session per id.
fn server_with(ids: &[u32]) -> Server {
    let info = LoadedPluginInfo {
        id: "probe".to_owned(),
        name: "Probe".to_owned(),
        version: "0.0.0".to_owned(),
        abi_version: CURRENT_PLUGIN_ABI_VERSION,
        toolchain: None,
    };
    let library = PluginLibrary::for_teardown_test(info, record_shutdown).unwrap();
    let channel = Arc::new(Channel::new(Box::new(std::io::sink())));
    #[cfg(unix)]
    let bridge = BridgeClient::new(Arc::clone(&channel), None);
    #[cfg(not(unix))]
    let bridge = BridgeClient::new(Arc::clone(&channel));
    let server = Server::new(library, configure(), Arc::clone(&channel), bridge);
    for &id in ids {
        // SAFETY: `from_boxed` produced the handle; ownership moves to the wrapper.
        let backend =
            unsafe { LoadedBackend::from_raw(PluginBackend::from_boxed(Box::new(Probe(id)))) };
        let session = Session {
            backend,
            output: SessionOutput::new(id, Arc::clone(&channel)),
            services: None,
            alive: true,
        };
        server.sessions.lock().unwrap().insert(id, session);
    }
    server
}

/// `shutdown` is the very last event and each session closed before it was
/// destroyed.
fn assert_sessions_end_before_the_library(log: &[String], ids: &[u32], closed: bool) {
    assert_eq!(log.last().map(String::as_str), Some("shutdown"), "{log:?}");
    assert_eq!(
        log.iter().filter(|e| *e == "shutdown").count(),
        1,
        "{log:?}"
    );
    for id in ids {
        let at = |event: String| log.iter().position(|e| *e == event);
        let destroy =
            at(format!("destroy:{id}")).unwrap_or_else(|| panic!("{id} destroyed: {log:?}"));
        if closed {
            let close = at(format!("close:{id}")).unwrap_or_else(|| panic!("{id} closed: {log:?}"));
            assert!(close < destroy, "{log:?}");
        }
    }
    let expected = 1 + ids.len() * if closed { 2 } else { 1 };
    assert_eq!(log.len(), expected, "{log:?}");
}

#[test]
fn teardown_closes_and_destroys_every_session_before_plugin_shutdown() {
    let server = server_with(&[1, 2, 3]);
    assert!(events().is_empty());
    server.teardown();
    assert_sessions_end_before_the_library(&events(), &[1, 2, 3], true);
}

#[test]
fn a_dropped_server_destroys_its_sessions_before_the_library() {
    // Even without `teardown` (an early return, a panic unwinding), the field
    // order alone must drop every backend before the library: `library` is
    // `Server`'s last field.
    let server = server_with(&[7, 8]);
    drop(server);
    assert_sessions_end_before_the_library(&events(), &[7, 8], false);
}

#[test]
fn serve_tears_down_in_order_on_shutdown() {
    let server = server_with(&[4, 5]);
    let (tx, rx) = channel();
    tx.send(Inbound::Message(Message::Close(SessionRef {
        session_id: 4,
    })))
    .unwrap();
    tx.send(Inbound::Message(Message::Cancel(Cancel {
        session_id: None,
    })))
    .unwrap();
    tx.send(Inbound::Message(Message::Shutdown)).unwrap();
    assert_eq!(server.serve(&rx), exit::OK);
    let log = events();
    // The explicit `Close` ended session 4 first; teardown then ended 5.
    assert_eq!(&log[..2], ["close:4", "destroy:4"], "{log:?}");
    assert_sessions_end_before_the_library(&log, &[4, 5], true);
}

#[test]
fn serve_reports_a_protocol_violation_and_still_tears_down_in_order() {
    let server = server_with(&[6]);
    let (tx, rx) = channel();
    tx.send(Inbound::Violation).unwrap();
    assert_eq!(server.serve(&rx), exit::PROTOCOL);
    assert_sessions_end_before_the_library(&events(), &[6], true);
}

#[test]
fn the_host_closing_the_channel_is_a_clean_exit() {
    let server = server_with(&[]);
    let (tx, rx) = channel::<Inbound>();
    drop(tx);
    assert_eq!(server.serve(&rx), exit::OK);
    assert_eq!(events(), ["shutdown"]);
}

// ---------------------------------------------------------------------------
// Liveness pushes (#5231): `push_alive_change` and the poller's loop body are
// exercised directly instead of hoping a session outlives the poll interval.
// ---------------------------------------------------------------------------

/// A backend whose liveness the test flips.
struct Flippable(Arc<AtomicBool>);

impl PluginTerminalBackend for Flippable {
    fn write_input(&self, _data: &[u8]) -> Result<(), PluginError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), PluginError> {
        Ok(())
    }
    fn close(&self) -> Result<(), PluginError> {
        Ok(())
    }
    fn is_alive(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// A channel writer whose bytes the test can decode afterwards.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Capture {
    /// Every frame written so far, decoded.
    fn messages(&self) -> Vec<Message> {
        let bytes = self.0.lock().unwrap().clone();
        let mut frames = FrameReader::new(bytes.as_slice());
        let mut messages = Vec::new();
        while let Some(frame) = frames.read_frame().unwrap() {
            messages.push(Message::decode(frame).unwrap());
        }
        messages
    }
}

/// A session whose backend reports `live`, last seen as `alive: true`.
fn flippable_session(id: u32, channel: &Arc<Channel>, live: &Arc<AtomicBool>) -> Session {
    // SAFETY: `from_boxed` produced the handle; ownership moves to the wrapper.
    let backend = unsafe {
        LoadedBackend::from_raw(PluginBackend::from_boxed(Box::new(Flippable(Arc::clone(
            live,
        )))))
    };
    Session {
        backend,
        output: SessionOutput::new(id, Arc::clone(channel)),
        services: None,
        alive: true,
    }
}

fn alive(session_id: u32, alive: bool) -> Message {
    Message::Alive(Alive { session_id, alive })
}

#[test]
fn push_alive_change_sends_one_frame_per_flip_and_nothing_otherwise() {
    let capture = Capture::default();
    let channel = Arc::new(Channel::new(Box::new(capture.clone())));
    let live = Arc::new(AtomicBool::new(true));
    let mut session = flippable_session(9, &channel, &live);

    // Unchanged liveness: silence.
    push_alive_change(&channel, 9, &mut session);
    assert!(capture.messages().is_empty());

    // A flip: exactly one frame, and the new state is remembered.
    live.store(false, Ordering::SeqCst);
    push_alive_change(&channel, 9, &mut session);
    push_alive_change(&channel, 9, &mut session);
    assert!(!session.alive);
    assert_eq!(capture.messages(), [alive(9, false)]);

    // Flipping back is reported once as well.
    live.store(true, Ordering::SeqCst);
    push_alive_change(&channel, 9, &mut session);
    push_alive_change(&channel, 9, &mut session);
    assert!(session.alive);
    assert_eq!(capture.messages(), [alive(9, false), alive(9, true)]);
}

#[test]
fn poll_alive_once_reports_only_the_sessions_that_changed() {
    let capture = Capture::default();
    let channel = Arc::new(Channel::new(Box::new(capture.clone())));
    let steady = Arc::new(AtomicBool::new(true));
    let dying = Arc::new(AtomicBool::new(true));
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = sessions.lock().unwrap();
        map.insert(1, flippable_session(1, &channel, &steady));
        map.insert(2, flippable_session(2, &channel, &dying));
    }

    poll_alive_once(&sessions, &channel);
    assert!(capture.messages().is_empty());

    dying.store(false, Ordering::SeqCst);
    poll_alive_once(&sessions, &channel);
    poll_alive_once(&sessions, &channel);
    assert_eq!(capture.messages(), [alive(2, false)]);
}

#[test]
fn the_alive_poller_pushes_a_change_and_stops_when_asked() {
    let capture = Capture::default();
    let channel = Arc::new(Channel::new(Box::new(capture.clone())));
    let live = Arc::new(AtomicBool::new(false));
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    sessions
        .lock()
        .unwrap()
        .insert(3, flippable_session(3, &channel, &live));
    let stop = Arc::new(AtomicBool::new(false));

    let poller = spawn_alive_poller(
        Arc::clone(&sessions),
        Arc::clone(&channel),
        Arc::clone(&stop),
        Duration::from_millis(1),
    );
    // The frame can only come from the poller's loop body, so seeing it proves
    // the body ran; the deadline only bounds a broken poller.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while capture.messages().is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "poller never reported"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    stop.store(true, Ordering::SeqCst);
    poller.join().unwrap();
    assert_eq!(capture.messages(), [alive(3, false)]);
}
