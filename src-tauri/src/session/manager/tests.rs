use super::*;

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use termihub_core::connection::{Capabilities, OutputReceiver, SettingsSchema};
use termihub_core::errors::SessionError;
use termihub_core::files::FileBrowser;
use termihub_core::monitoring::MonitoringProvider;

use termihub_core::monitoring::MonitoringSender;

use crate::connection::config::AgentSettings;
use crate::terminal::agent_manager::{
    AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
    AgentFolderInfo, AgentRpcClient, AgentSessionInfo,
};
use crate::terminal::backend::{OutputSender, RemoteAgentConfig};

/// The `data` field of a serialized [`TerminalOutputEvent`] must be a base64
/// string that decodes byte-for-byte back to the original bytes — the exact
/// inverse of the `base64ToBytes` decoder in `src/services/events.ts`. This
/// is the terminal's hot path, so a mismatch means corrupted/dropped output.
/// Covers high bytes (0x80–0xFF), UTF-8 multi-byte sequences, all 256 byte
/// values, and the empty chunk (#2072).
#[test]
fn terminal_output_event_serializes_data_as_base64() {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;

    let cases: Vec<Vec<u8>> = vec![
        Vec::new(),                              // empty chunk → ""
        b"hello".to_vec(),                       // plain ASCII
        vec![0x1b, b'[', b'3', b'1', b'm'],      // ANSI color escape
        "héllo — 日本語 🎉".as_bytes().to_vec(), // UTF-8 multi-byte
        vec![0x00, 0x7f, 0x80, 0xfe, 0xff],      // boundary + high bytes
        (0u16..=255).map(|b| b as u8).collect(), // every byte value
    ];

    for bytes in cases {
        let event = TerminalOutputEvent {
            session_id: "s1".to_string(),
            data: bytes.clone(),
        };
        let json: Value = serde_json::to_value(&event).unwrap();

        // Wire form is a string (not a JSON number-array).
        let encoded = json["data"]
            .as_str()
            .expect("data must serialize to a string");
        assert_eq!(encoded, engine.encode(&bytes));

        // Round-trip: decoding the wire string yields the original bytes.
        let decoded = engine.decode(encoded).unwrap();
        assert_eq!(decoded, bytes, "base64 round-trip must be byte-for-byte");
    }
}

/// A minimal mock connection without file browser capability. When `writes`
/// is `Some`, every byte passed to `write` is recorded into it so tests can
/// assert the exact bytes forwarded by `send_input` / `send_input_raw`.
#[derive(Default)]
struct MockConnection {
    writes: Option<Arc<std::sync::Mutex<Vec<u8>>>>,
}

#[async_trait::async_trait]
impl ConnectionType for MockConnection {
    fn type_id(&self) -> &str {
        "mock"
    }
    fn display_name(&self) -> &str {
        "Mock"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        if let Some(writes) = &self.writes {
            writes.lock().unwrap().extend_from_slice(data);
        }
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// A mock connection whose file browser is a **local** (byte-capable but NOT
/// FTP-backed) browser. Used to prove the session-based FTP transfer resolver
/// excludes non-FTP backends, so the queue path stays reserved for backends that
/// can actually drive it (PROD-010).
#[derive(Default)]
struct LocalBrowserConnection {
    browser: termihub_core::files::LocalFileBrowser,
}

#[async_trait::async_trait]
impl ConnectionType for LocalBrowserConnection {
    fn type_id(&self) -> &str {
        "local-browser-mock"
    }
    fn display_name(&self) -> &str {
        "Local Browser Mock"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: true,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: false,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        Some(&self.browser)
    }
}

/// Helper to create a sessions map and insert a mock session.
/// A fresh, empty scrollback capture buffer for `run_output_reader` tests (#1900).
fn new_capture() -> Arc<StdMutex<RingBuffer>> {
    Arc::new(StdMutex::new(RingBuffer::new(DEFAULT_BUFFER_CAPACITY)))
}

/// A fresh, empty `output_buffers` map for the cleanup path (#1900).
fn new_output_buffers() -> OutputBuffers {
    Arc::new(StdMutex::new(HashMap::new()))
}

/// A fresh, empty `session_loggers` map for the logging path (#1960).
fn new_session_loggers() -> SessionLoggers {
    Arc::new(StdMutex::new(HashMap::new()))
}

/// A fresh, empty `session_tab_ids` identity-bridge map (#2431).
fn new_session_tab_ids() -> SessionTabIds {
    Arc::new(StdMutex::new(HashMap::new()))
}

async fn sessions_with_mock(session_id: &str) -> Arc<Mutex<HashMap<String, SessionEntry>>> {
    let sessions = Arc::new(Mutex::new(HashMap::new()));
    let mut map = sessions.lock().await;
    map.insert(
        session_id.to_string(),
        SessionEntry {
            connection: Box::new(MockConnection::default()),
            info: SessionInfo {
                id: session_id.to_string(),
                title: "Mock".to_string(),
                connection_type: "mock".to_string(),
                alive: true,
                agent_id: None,
                spawned: false,
            },
            remote_session_id: None,
            line_ending: LineEnding::default(),
            reader_cancel: CancellationToken::new(),
        },
    );
    drop(map);
    sessions
}

// ── MockEventEmitter ─────────────────────────────────────────────

#[derive(Clone, Default)]
struct MockEventEmitter {
    outputs: std::sync::Arc<std::sync::Mutex<Vec<TerminalOutputEvent>>>,
    exits: std::sync::Arc<std::sync::Mutex<Vec<TerminalExitEvent>>>,
    /// Recorded `fold_connect_failed` calls as `(tab_id, error, auth_failed)`
    /// (#2439; `auth_failed` added for SM-005).
    connect_faileds: std::sync::Arc<std::sync::Mutex<Vec<(String, String, bool)>>>,
    fail_output: bool,
}

impl MockEventEmitter {
    fn new() -> Self {
        Self::default()
    }
    fn failing() -> Self {
        Self {
            fail_output: true,
            ..Self::default()
        }
    }
}

impl EventEmitter for MockEventEmitter {
    fn emit_output(&self, event: &TerminalOutputEvent) -> bool {
        if self.fail_output {
            return false;
        }
        self.outputs.lock().unwrap().push(event.clone());
        true
    }
    fn emit_exit(&self, event: &TerminalExitEvent) {
        self.exits.lock().unwrap().push(event.clone());
    }
    fn fold_connect_failed(&self, tab_id: &str, error: &str, auth_failed: bool) {
        self.connect_faileds.lock().unwrap().push((
            tab_id.to_string(),
            error.to_string(),
            auth_failed,
        ));
    }
}

/// Test that file browser access returns an error when the connection
/// has no file browser capability.
#[tokio::test]
async fn file_browser_returns_none_for_mock_connection() {
    let sessions = sessions_with_mock("sess-1").await;
    let sessions_guard = sessions.lock().await;
    let entry = sessions_guard.get("sess-1").unwrap();
    assert!(
        entry.connection.file_browser().is_none(),
        "MockConnection should not have file browser capability"
    );
}

/// Insert a session whose file browser is a local (non-FTP) browser.
async fn sessions_with_local_browser(
    session_id: &str,
) -> Arc<Mutex<HashMap<String, SessionEntry>>> {
    let sessions = Arc::new(Mutex::new(HashMap::new()));
    let mut map = sessions.lock().await;
    map.insert(
        session_id.to_string(),
        SessionEntry {
            connection: Box::new(LocalBrowserConnection::default()),
            info: SessionInfo {
                id: session_id.to_string(),
                title: "Local".to_string(),
                connection_type: "local-browser-mock".to_string(),
                alive: true,
                agent_id: None,
                spawned: false,
            },
            remote_session_id: None,
            line_ending: LineEnding::default(),
            reader_cancel: CancellationToken::new(),
        },
    );
    drop(map);
    sessions
}

/// A non-FTP (local / byte-based) session must not resolve an FTP transfer
/// config, so the session-based queue path stays reserved for FTP/SFTP and
/// Docker/agent/local keep the blocking byte-based fallback (PROD-010).
#[cfg(feature = "ftp")]
#[tokio::test]
async fn ftp_transfer_config_rejects_non_ftp_session() {
    use crate::session::file_ops::FileOps;
    let sessions = sessions_with_local_browser("sess-local").await;
    let ops = FileOps::new(&sessions);
    let err = ops
        .ftp_transfer_config("sess-local")
        .await
        .expect_err("a local (non-FTP) browser must not yield an FTP config");
    assert!(
        matches!(err, crate::utils::errors::TerminalError::RemoteError(_)),
        "expected RemoteError for a non-FTP session, got {err:?}"
    );
}

/// An unknown session surfaces SessionNotFound, not a misleading "not FTP" error.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn ftp_transfer_config_reports_unknown_session() {
    use crate::session::file_ops::FileOps;
    let sessions: Arc<Mutex<HashMap<String, SessionEntry>>> = Arc::new(Mutex::new(HashMap::new()));
    let ops = FileOps::new(&sessions);
    let err = ops
        .ftp_transfer_config("ghost")
        .await
        .expect_err("unknown session must error");
    assert!(
        matches!(err, crate::utils::errors::TerminalError::SessionNotFound(_)),
        "expected SessionNotFound, got {err:?}"
    );
}

/// Test that looking up a nonexistent session returns SessionNotFound.
#[tokio::test]
async fn nonexistent_session_returns_not_found() {
    let sessions: Arc<Mutex<HashMap<String, SessionEntry>>> = Arc::new(Mutex::new(HashMap::new()));
    let sessions_guard = sessions.lock().await;
    let result = sessions_guard.get("nonexistent");
    assert!(result.is_none());
}

/// Test write and resize work on mock connection.
#[tokio::test]
async fn write_and_resize_on_mock_session() {
    let sessions = sessions_with_mock("sess-1").await;
    let sessions_guard = sessions.lock().await;
    let entry = sessions_guard.get("sess-1").unwrap();
    assert!(entry.connection.write(b"hello").is_ok());
    assert!(entry.connection.resize(80, 24).is_ok());
}

/// `send_input` normalizes line endings to the session's configured ending.
/// Regression test for the Windows-CRLF double-line paste bug.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn send_input_normalizes_to_session_line_ending() {
    let writes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session(
            "sess-1",
            Box::new(MockConnection {
                writes: Some(writes.clone()),
            }),
        )
        .await;

    // Default (CR): CRLF paste collapses to a single CR, no blank lines.
    manager.send_input("sess-1", b"a\r\nb\r\nc").await.unwrap();
    assert_eq!(writes.lock().unwrap().as_slice(), b"a\rb\rc");

    // Switch to CRLF: a bare LF becomes CRLF.
    writes.lock().unwrap().clear();
    manager
        .set_session_line_ending("sess-1", LineEnding::Crlf)
        .await;
    manager.send_input("sess-1", b"a\nb").await.unwrap();
    assert_eq!(writes.lock().unwrap().as_slice(), b"a\r\nb");
}

/// `send_input_raw` bypasses normalization so internal injection (agent
/// setup) is sent byte-exact regardless of the session's line ending.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn send_input_raw_does_not_normalize() {
    let writes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session(
            "sess-1",
            Box::new(MockConnection {
                writes: Some(writes.clone()),
            }),
        )
        .await;
    manager
        .set_session_line_ending("sess-1", LineEnding::Crlf)
        .await;

    manager.send_input_raw("sess-1", b"a\nb\n").await.unwrap();
    assert_eq!(writes.lock().unwrap().as_slice(), b"a\nb\n");
}

/// Multi-window (#1900): re-parenting a tab is a pure view operation. The
/// destination window repaints history from the session's captured
/// scrollback while the backend session stays untouched in the `sessions`
/// map. This proves the replay substrate that makes any session type
/// re-parentable with scrollback.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn replay_scrollback_returns_captured_history_without_touching_session() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session("sess-move", Box::new(MockConnection::default()))
        .await;

    // Simulate output having streamed through the reader into the capture.
    manager
        .ensure_output_buffer("sess-move")
        .lock()
        .unwrap()
        .write(b"line-1\r\nline-2\r\n");

    // A move: the destination replays the history verbatim...
    let replayed = manager.replay_scrollback("sess-move").await;
    assert_eq!(replayed, b"line-1\r\nline-2\r\n");
    // ...and the backend session survives the move entirely.
    assert!(manager.sessions.lock().await.contains_key("sess-move"));

    // An unknown session replays empty rather than erroring.
    assert!(manager
        .replay_scrollback("no-such-session")
        .await
        .is_empty());
}

/// Regression test for #792: the settings-driven initial command must honor
/// the session's configured line ending instead of a hardcoded `\n`. A CRLF
/// session must receive the command terminated with `\r\n` so it executes on
/// hosts/devices that require CR/CRLF.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn initial_command_honors_session_line_ending() {
    let writes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session(
            "sess-1",
            Box::new(MockConnection {
                writes: Some(writes.clone()),
            }),
        )
        .await;

    // Default (CR) session: command is terminated with a bare CR.
    SessionManager::inject_initial_command(&manager.sessions, "sess-1", "echo hi").await;
    assert_eq!(writes.lock().unwrap().as_slice(), b"echo hi\r");

    // CRLF session: the trailing line break is translated to CRLF.
    writes.lock().unwrap().clear();
    manager
        .set_session_line_ending("sess-1", LineEnding::Crlf)
        .await;
    SessionManager::inject_initial_command(&manager.sessions, "sess-1", "echo hi").await;
    assert_eq!(writes.lock().unwrap().as_slice(), b"echo hi\r\n");
}

/// Test session removal.
#[tokio::test]
async fn remove_session() {
    let sessions = sessions_with_mock("sess-1").await;
    {
        let mut sessions_guard = sessions.lock().await;
        sessions_guard.remove("sess-1");
    }
    let sessions_guard = sessions.lock().await;
    assert!(!sessions_guard.contains_key("sess-1"));
}

/// OBS-004: closing a session must emit its identity as a **structured
/// `tracing` field** and run inside a lifecycle **span** named `close_session`,
/// so a supporter can group and filter `termihub.log` by session rather than
/// grepping message text. Guards against a regression back to string
/// interpolation or a missing span.
// Serialized against every other thread-local `tracing` default-subscriber
// test (see `utils::log_capture`, `terminal::agent_manager`): a concurrent
// guard drop transiently reverts the global max-level to OFF and would drop
// our captured events (a well-known parallel-`tracing`-test race).
#[tokio::test]
#[serial_test::serial(tracing_default_subscriber)]
async fn close_session_log_carries_session_id_field_and_span() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session("sess-obs-004", Box::new(MockConnection::default()))
        .await;

    let (capture, guard) = crate::terminal::agent_manager::tracing_capture::install();
    manager.close_session("sess-obs-004").await.unwrap();
    drop(guard);

    let events = capture.events();
    let closed = events
        .iter()
        .find(|e| e.message() == "Closed session")
        .expect("close_session emits a 'Closed session' event");
    assert_eq!(closed.field("session_id"), Some("sess-obs-004"));
    assert_eq!(closed.span.as_deref(), Some("close_session"));
    // The id is a field, not interpolated into the message.
    assert!(!closed.message().contains("sess-obs-004"));
}

#[test]
fn build_title_docker_explicit_runtime() {
    let settings = serde_json::json!({"image": "ubuntu:22.04", "runtime": "docker"});
    let title = SessionManager::build_title("docker", &settings, None);
    assert_eq!(title, "Docker: ubuntu:22.04");
}

#[test]
fn build_title_docker_podman_runtime() {
    let settings = serde_json::json!({"image": "alpine", "runtime": "podman"});
    let title = SessionManager::build_title("docker", &settings, None);
    assert_eq!(title, "Podman: alpine");
}

#[test]
fn build_title_docker_auto_runtime() {
    let settings = serde_json::json!({"image": "nginx", "runtime": "auto"});
    let title = SessionManager::build_title("docker", &settings, None);
    assert_eq!(title, "Container: nginx");
}

#[test]
fn build_title_docker_missing_runtime_defaults_to_container() {
    let settings = serde_json::json!({"image": "redis"});
    let title = SessionManager::build_title("docker", &settings, None);
    assert_eq!(title, "Container: redis");
}

#[test]
fn build_title_docker_missing_image() {
    let settings = serde_json::json!({"runtime": "docker"});
    let title = SessionManager::build_title("docker", &settings, None);
    assert_eq!(title, "Docker: unknown");
}

#[test]
fn build_title_proxy_session_uses_connection_info_not_agent_id() {
    let settings =
        serde_json::json!({"username": "alice", "host": "db-01.example.com", "port": 22});
    let title = SessionManager::build_title("ssh", &settings, Some("production-server"));
    // Proxy sessions get the same descriptive title as local sessions.
    assert_eq!(title, "SSH: alice@db-01.example.com");
}

// ── EventEmitter DI tests ─────────────────────────────────────────

#[tokio::test]
async fn emit_and_cleanup_sends_exit_event() {
    let emitter = MockEventEmitter::new();
    let sessions = sessions_with_mock("sess-exit").await;

    let output_buffers = new_output_buffers();
    SessionManager::emit_and_cleanup(
        "sess-exit",
        Vec::new(),
        &emitter,
        &sessions,
        &output_buffers,
        &new_session_loggers(),
        &new_session_tab_ids(),
    )
    .await;

    {
        let exits = emitter.exits.lock().unwrap();
        assert_eq!(exits.len(), 1);
        assert_eq!(exits[0].session_id, "sess-exit");
    }
    // Session should be removed after cleanup
    assert!(!sessions.lock().await.contains_key("sess-exit"));
}

#[tokio::test]
async fn emit_and_cleanup_flushes_remaining_data() {
    let emitter = MockEventEmitter::new();
    let sessions = sessions_with_mock("sess-data").await;

    let output_buffers = new_output_buffers();
    SessionManager::emit_and_cleanup(
        "sess-data",
        b"final bytes".to_vec(),
        &emitter,
        &sessions,
        &output_buffers,
        &new_session_loggers(),
        &new_session_tab_ids(),
    )
    .await;

    {
        let outputs = emitter.outputs.lock().unwrap();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].data, b"final bytes");
    }
}

#[tokio::test]
async fn run_output_reader_emits_chunks_and_exit() {
    let emitter = MockEventEmitter::new();
    let sessions = sessions_with_mock("sess-stream").await;
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);

    tx.send(b"hello ".to_vec()).await.unwrap();
    tx.send(b"world".to_vec()).await.unwrap();
    drop(tx); // signal EOF

    let capture = new_capture();
    let output_buffers = new_output_buffers();
    SessionManager::run_output_reader(
        "sess-stream".to_string(),
        rx,
        emitter.clone(),
        sessions.clone(),
        false,
        capture.clone(),
        output_buffers,
        new_session_loggers(),
        new_session_tab_ids(),
        CancellationToken::new(),
    )
    .await;

    // The scrollback capture buffer (#1900) mirrors the streamed output.
    {
        let captured = capture
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .read_all();
        assert!(
            captured.windows(5).any(|w| w == b"hello"),
            "expected streamed output to be captured for replay"
        );
    }

    {
        let outputs = emitter.outputs.lock().unwrap();
        let combined: Vec<u8> = outputs
            .iter()
            .flat_map(|e| e.data.iter().copied())
            .collect();
        assert!(
            combined.windows(5).any(|w| w == b"hello"),
            "expected 'hello' in output"
        );
    }
    {
        let exits = emitter.exits.lock().unwrap();
        assert_eq!(exits.len(), 1);
    }
}

/// CONC-011: the detached output-reader task must stop deterministically when
/// its session is torn down, even if the output channel never reaches EOF
/// (e.g. a lingering/dead transport that never drops its sender). Cancelling
/// the session's `reader_cancel` token ends the task promptly and still runs
/// its end-of-stream cleanup (a `terminal-exit` is emitted).
#[tokio::test]
async fn run_output_reader_stops_on_cancellation_without_eof() {
    let emitter = MockEventEmitter::new();
    let sessions = sessions_with_mock("sess-cancel").await;
    // Keep the sender alive for the whole test: the reader can only reach EOF
    // if `tx` drops, so if cancellation were broken the task would hang.
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);

    let cancel = CancellationToken::new();
    let reader_cancel = cancel.clone();
    let reader_emitter = emitter.clone();
    let handle = tokio::spawn(async move {
        SessionManager::run_output_reader(
            "sess-cancel".to_string(),
            rx,
            reader_emitter,
            sessions,
            false,
            new_capture(),
            new_output_buffers(),
            new_session_loggers(),
            new_session_tab_ids(),
            reader_cancel,
        )
        .await;
    });

    // The reader is streaming (channel open, no data pending) — without
    // cancellation it would never return, since `tx` is still held here and
    // the channel therefore never reaches EOF. Cancel the token and require
    // the task to finish quickly: completing at all proves the cancel stopped
    // it rather than an EOF that cannot happen while `tx` is alive.
    cancel.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(5), handle)
        .await
        .expect("output reader did not stop after cancellation")
        .expect("output reader task panicked");

    // The sender was never dropped before the reader stopped, so EOF was
    // impossible — the cancel token is what ended it. Cleanup still ran:
    // exactly one terminal-exit was emitted.
    assert_eq!(
        emitter.exits.lock().unwrap().len(),
        1,
        "cancelled reader must still emit its terminal-exit cleanup"
    );
    drop(tx);
}

#[tokio::test]
async fn run_output_reader_writes_to_active_session_logger() {
    let emitter = MockEventEmitter::new();
    let sessions = sessions_with_mock("sess-log").await;
    let session_loggers = new_session_loggers();

    // Point a logger at a temp file and register it as the active logger for
    // the session, mirroring what `start_session_logging` does.
    let dir = std::env::temp_dir().join(format!(
        "termihub-mgr-log-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("out.log");
    let logger = SessionLogger::open(
        SessionLogConfig::new(&path, false),
        Box::new(|| "T".to_string()),
    )
    .unwrap();
    session_loggers
        .lock()
        .unwrap()
        .insert("sess-log".to_string(), Arc::new(StdMutex::new(logger)));

    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);
    tx.send(b"logged output\n".to_vec()).await.unwrap();
    drop(tx); // EOF → reader runs cleanup, flushing + dropping the logger

    SessionManager::run_output_reader(
        "sess-log".to_string(),
        rx,
        emitter,
        sessions,
        false,
        new_capture(),
        new_output_buffers(),
        session_loggers.clone(),
        new_session_tab_ids(),
        CancellationToken::new(),
    )
    .await;

    // The transcript captured the streamed output...
    let contents = std::fs::read(&path).unwrap();
    assert!(
        contents.windows(6).any(|w| w == b"logged"),
        "expected streamed output in the transcript file"
    );
    // ...and cleanup removed the logger from the active map.
    assert!(
        !session_loggers.lock().unwrap().contains_key("sess-log"),
        "logger should be dropped when the session ends"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn run_output_reader_stops_on_emitter_failure() {
    let emitter = MockEventEmitter::failing();
    let sessions = sessions_with_mock("sess-fail").await;
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);

    tx.send(b"data".to_vec()).await.unwrap();

    // run_output_reader should return quickly when emit_output returns false
    SessionManager::run_output_reader(
        "sess-fail".to_string(),
        rx,
        emitter.clone(),
        sessions,
        false,
        new_capture(),
        new_output_buffers(),
        new_session_loggers(),
        new_session_tab_ids(),
        CancellationToken::new(),
    )
    .await;

    // No outputs recorded (emitter failed)
    let outputs = emitter.outputs.lock().unwrap();
    assert!(outputs.is_empty());
}

// ── PERF-012: output-read copy reduction (byte-exact + framing) ──────
//
// These lock in the delivery contract of `run_output_reader`'s streaming
// phase so the zero-copy single-chunk fast path cannot silently alter the
// bytes, their order, or the event framing. They pass identically before
// and after the copy reduction: the optimization must be behaviour-neutral.

/// Helper: drive `run_output_reader` (streaming phase, no clear-wait) over a
/// pre-filled channel and return the emitted output events in order.
async fn collect_stream_events(chunks: Vec<Vec<u8>>) -> Vec<TerminalOutputEvent> {
    let emitter = MockEventEmitter::new();
    let sessions = sessions_with_mock("sess-perf").await;
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1024);
    for chunk in chunks {
        tx.send(chunk).await.unwrap();
    }
    drop(tx); // EOF

    SessionManager::run_output_reader(
        "sess-perf".to_string(),
        rx,
        emitter.clone(),
        sessions,
        false,
        new_capture(),
        new_output_buffers(),
        new_session_loggers(),
        new_session_tab_ids(),
        CancellationToken::new(),
    )
    .await;

    let events = emitter.outputs.lock().unwrap();
    events.clone()
}

/// A single chunk with no follow-up is delivered byte-for-byte as exactly
/// one event (the zero-copy passthrough case).
#[tokio::test]
async fn run_output_reader_single_chunk_is_byte_exact() {
    let events = collect_stream_events(vec![b"hello world".to_vec()]).await;
    assert_eq!(events.len(), 1, "one chunk should yield one event");
    assert_eq!(events[0].data, b"hello world");
}

/// Multiple chunks that are already queued coalesce into one event whose
/// bytes are the exact in-order concatenation of the inputs.
#[tokio::test]
async fn run_output_reader_coalesces_bytes_in_order() {
    let events =
        collect_stream_events(vec![b"aaa".to_vec(), b"bbb".to_vec(), b"ccc".to_vec()]).await;
    let combined: Vec<u8> = events.iter().flat_map(|e| e.data.clone()).collect();
    assert_eq!(combined, b"aaabbbccc", "bytes must stay in order");
    // Queued chunks coalesce into a single event (framing preserved).
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, b"aaabbbccc");
}

/// A chunk carrying a screen-clear escape sequence passes through the
/// streaming phase untouched — the raw bytes are never rewritten.
#[tokio::test]
async fn run_output_reader_preserves_screen_clear_bytes() {
    let chunk = b"before\x1b[2J\x1b[Hafter".to_vec();
    let events = collect_stream_events(vec![chunk.clone()]).await;
    let combined: Vec<u8> = events.iter().flat_map(|e| e.data.clone()).collect();
    assert_eq!(combined, chunk, "screen-clear bytes must be byte-exact");
}

/// Many small chunks (simulating partial PTY reads) are delivered with
/// every byte preserved and strictly in order.
#[tokio::test]
async fn run_output_reader_partial_reads_preserve_order() {
    let inputs: Vec<Vec<u8>> = (0u8..64).map(|i| vec![i]).collect();
    let expected: Vec<u8> = (0u8..64).collect();
    let events = collect_stream_events(inputs).await;
    let combined: Vec<u8> = events.iter().flat_map(|e| e.data.clone()).collect();
    assert_eq!(combined, expected, "all bytes, in order");
}

/// A first chunk at or above the coalesce cap is delivered on its own,
/// leaving a following chunk for the next event — matching the framing of
/// the original always-coalesce loop (whose size guard never pulled a
/// follow-up after such a chunk).
#[tokio::test]
async fn run_output_reader_oversized_first_chunk_is_not_merged() {
    let big = vec![b'x'; MAX_COALESCE_BYTES + 16];
    let small = b"tail".to_vec();
    let events = collect_stream_events(vec![big.clone(), small.clone()]).await;
    assert_eq!(events.len(), 2, "oversized chunk must not merge with next");
    assert_eq!(events[0].data, big);
    assert_eq!(events[1].data, small);
}

/// Regression: `emit_and_cleanup` must NOT clear the persistent session record
/// when the output channel closes. The daemon on the remote host is still alive
/// after an agent SSH disconnect; keeping the record allows `attach_persistent_tab`
/// to re-create the desktop-side `RemoteProxy` on the next attach attempt.
#[tokio::test]
async fn emit_and_cleanup_preserves_persistent_session_record() {
    let emitter = MockEventEmitter::new();
    let sessions = sessions_with_mock("sess-ps").await;
    let persistent_sessions: Arc<Mutex<HashMap<String, PersistentRecord>>> =
        Arc::new(Mutex::new(HashMap::new()));
    {
        let mut ps = persistent_sessions.lock().await;
        ps.insert(
            "conn-ps".to_string(),
            PersistentRecord {
                connection_id: "conn-ps".to_string(),
                session_id: "sess-ps".to_string(),
                attached_tabs: HashSet::new(),
                remote_session_id: Some("remote-1".to_string()),
                agent_id: Some("agent-1".to_string()),
            },
        );
    }

    SessionManager::emit_and_cleanup(
        "sess-ps",
        Vec::new(),
        &emitter,
        &sessions,
        &new_output_buffers(),
        &new_session_loggers(),
        &new_session_tab_ids(),
    )
    .await;

    // The persistent record must still be present — the daemon is alive.
    assert!(
        persistent_sessions.lock().await.contains_key("conn-ps"),
        "persistent record must be kept after backend exit (daemon still alive)"
    );
}

// ── DisconnectSpy ─────────────────────────────────────────────────

/// A connection that records whether `disconnect()` was called.
struct DisconnectSpy {
    disconnected: Arc<AtomicBool>,
}

impl DisconnectSpy {
    fn new(flag: Arc<AtomicBool>) -> Self {
        Self { disconnected: flag }
    }
}

#[async_trait::async_trait]
impl ConnectionType for DisconnectSpy {
    fn type_id(&self) -> &str {
        "spy"
    }
    fn display_name(&self) -> &str {
        "Spy"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        self.disconnected.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _: u16, _: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

// ── NullAgent ────────────────────────────────────────────────────

/// A no-op `AgentRpcClient` for tests that construct a full `SessionManager`.
struct NullAgent;

impl AgentRpcClient for NullAgent {
    fn connect_agent(
        &self,
        _: &str,
        _: &RemoteAgentConfig,
        _: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        unimplemented!()
    }
    fn cancel_connect(&self, _: &str) -> bool {
        false
    }
    fn disconnect_agent(&self, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn is_connected(&self, _: &str) -> bool {
        false
    }
    fn get_capabilities(&self, _: &str) -> Option<AgentCapabilities> {
        None
    }
    fn shutdown_agent(&self, _: &str, _: Option<&str>) -> Result<u32, TerminalError> {
        unimplemented!()
    }
    fn send_request(&self, _: &str, _: &str, _: Value) -> Result<Value, TerminalError> {
        unimplemented!()
    }
    fn create_session(
        &self,
        _: &str,
        _: &str,
        _: Value,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        unimplemented!()
    }
    fn attach_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn close_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn list_sessions(&self, _: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        unimplemented!()
    }
    fn list_connections_and_folders(&self, _: &str) -> Result<AgentConnectionsData, TerminalError> {
        unimplemented!()
    }
    fn list_definitions(&self, _: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        unimplemented!()
    }
    fn save_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn update_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionUpdateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_definition(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn create_folder(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn update_folder(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::FolderUpdateParams,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_folder(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_session_output(
        &self,
        _: &str,
        _: &str,
        _: OutputSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_session_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_monitoring_output(
        &self,
        _: &str,
        _: &str,
        _: MonitoringSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_monitoring_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn send_session_input(&self, _: &str, _: &str, _: &[u8]) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn resize_session(&self, _: &str, _: &str, _: u16, _: u16) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn apply_agent_settings(&self, _: &str, _: &AgentSettings) -> Result<(), TerminalError> {
        unimplemented!()
    }
}

// ── get_remote_session_buffer tests ──────────────────────────────

#[tokio::test]
async fn get_remote_session_buffer_returns_error_for_nonexistent_session() {
    let registry = ConnectionTypeRegistry::new();
    let manager = SessionManager::new(registry, Arc::new(NullAgent));
    let result = manager.get_remote_session_buffer("no-such-session").await;
    assert!(result.is_err());
    assert!(matches!(
        result.unwrap_err(),
        TerminalError::SessionNotFound(_)
    ));
}

#[tokio::test]
async fn get_remote_session_buffer_returns_remote_error_for_local_session() {
    let registry = ConnectionTypeRegistry::new();
    let manager = SessionManager::new(registry, Arc::new(NullAgent));
    manager
        .insert_test_session("local-sess", Box::new(MockConnection::default()))
        .await;
    let result = manager.get_remote_session_buffer("local-sess").await;
    assert!(result.is_err());
    // Local sessions have no agent_id → RemoteError("not a remote session")
    assert!(matches!(result.unwrap_err(), TerminalError::RemoteError(_)));
}

// ── Regression test: close_session must call disconnect() ─────────

/// Regression test for the serial port cleanup bug.
///
/// Before the fix, `close_session()` removed the entry without calling
/// `disconnect()`. Serial's reader thread only stops when `disconnect()`
/// clears `output_tx`. This test verifies that `disconnect()` is called.
#[tokio::test]
async fn close_session_calls_disconnect_on_connection() {
    let registry = ConnectionTypeRegistry::new();
    let manager = SessionManager::new(registry, Arc::new(NullAgent));

    let disconnected = Arc::new(AtomicBool::new(false));
    let spy = DisconnectSpy::new(disconnected.clone());

    manager.insert_test_session("spy-1", Box::new(spy)).await;

    manager.close_session("spy-1").await.unwrap();

    assert!(
        disconnected.load(Ordering::SeqCst),
        "disconnect() must be called when a session is closed"
    );
}

// ── MockPersistentEmitter ─────────────────────────────────────────

#[derive(Clone, Default)]
struct MockPersistentEmitter {
    persistent_events: std::sync::Arc<std::sync::Mutex<Vec<PersistentSessionStateEvent>>>,
}

impl MockPersistentEmitter {
    fn new() -> Self {
        Self::default()
    }

    fn events(&self) -> Vec<PersistentSessionStateEvent> {
        self.persistent_events.lock().unwrap().clone()
    }
}

impl EventEmitter for MockPersistentEmitter {
    fn emit_output(&self, _event: &TerminalOutputEvent) -> bool {
        true
    }
    fn emit_exit(&self, _event: &TerminalExitEvent) {}
    fn emit_persistent_state(&self, event: &PersistentSessionStateEvent) {
        self.persistent_events.lock().unwrap().push(event.clone());
    }
}

/// Build a `SessionManager` wired with a "mock" connection type for tests.
fn make_test_manager() -> SessionManager {
    let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
    registry.register(
        "mock",
        "Mock",
        "mock",
        Box::new(|| Box::new(MockConnection::default())),
    );
    let agent_manager = Arc::new(NullAgent);
    SessionManager::new(registry, agent_manager)
}

// ── Identity bridge: session_id → tab_id (#2431) ──────────────────

#[test]
fn tab_id_from_connect_id_parses_the_tab_prefix() {
    assert_eq!(tab_id_from_connect_id("tab-1:0").as_deref(), Some("tab-1"));
    // The parse is retry-count-agnostic: it strips only the trailing segment.
    assert_eq!(tab_id_from_connect_id("tab-1:3").as_deref(), Some("tab-1"));
    // A tab id containing a colon: only the last `:retry` is stripped.
    assert_eq!(tab_id_from_connect_id("a:b:2").as_deref(), Some("a:b"));
    // An unexpected form (no colon) or an empty tab yields no mapping rather
    // than a guess.
    assert_eq!(tab_id_from_connect_id("notacolon"), None);
    assert_eq!(tab_id_from_connect_id(":0"), None);
}

#[tokio::test]
async fn create_connection_records_the_tab_id_identity_bridge() {
    let manager = make_test_manager();
    let session_id = manager
        .create_connection(
            "mock",
            serde_json::json!({}),
            None,
            Some("tab-42:0"),
            false,
            false,
            MockEventEmitter::new(),
        )
        .await
        .expect("session should open");
    // A synchronous read before the spawned reader task can run, so the
    // mapping is observed exactly as create_connection recorded it.
    assert_eq!(manager.tab_id_for(&session_id).as_deref(), Some("tab-42"));
}

#[tokio::test]
async fn create_connection_without_connect_id_records_no_tab() {
    let manager = make_test_manager();
    let session_id = manager
        .create_connection(
            "mock",
            serde_json::json!({}),
            None,
            None,
            false,
            false,
            MockEventEmitter::new(),
        )
        .await
        .expect("session should open");
    assert_eq!(
        manager.tab_id_for(&session_id),
        None,
        "a session with no connect_id carries no tab"
    );
}

#[tokio::test]
async fn close_session_clears_the_tab_id_identity_bridge() {
    let manager = make_test_manager();
    let session_id = manager
        .create_connection(
            "mock",
            serde_json::json!({}),
            None,
            Some("tab-7:0"),
            false,
            false,
            MockEventEmitter::new(),
        )
        .await
        .expect("session should open");
    assert_eq!(manager.tab_id_for(&session_id).as_deref(), Some("tab-7"));

    manager
        .close_session(&session_id)
        .await
        .expect("close should succeed");
    assert_eq!(
        manager.tab_id_for(&session_id),
        None,
        "closing a session clears its identity-bridge entry"
    );
}

#[tokio::test]
async fn create_connection_retains_request_for_resilient_direct_session() {
    let manager = make_test_manager();
    manager
        .create_connection(
            "mock",
            serde_json::json!({ "password": "secret" }),
            None, // direct (no agent)
            Some("tab-r:0"),
            false,
            true, // resilient
            MockEventEmitter::new(),
        )
        .await
        .expect("session should open");
    assert!(
        manager.has_retained_request("tab-r"),
        "a resilient direct session retains its connection request (#2454 Model A)"
    );
}

/// A mock `AgentRpcClient` that satisfies the `create_connection` agent
/// handshake (create → register output → attach → capability query) and
/// **records** every `clear_retained_agent_config` call, so the #2473
/// retention + refcount-scrub tests can drive a real agent session through the
/// manager without a live SSH transport.
struct RetainAgent {
    cleared: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl RetainAgent {
    fn new() -> (Self, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let cleared = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        (
            Self {
                cleared: cleared.clone(),
            },
            cleared,
        )
    }
}

impl AgentRpcClient for RetainAgent {
    fn connect_agent(
        &self,
        _: &str,
        _: &RemoteAgentConfig,
        _: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        unimplemented!()
    }
    fn cancel_connect(&self, _: &str) -> bool {
        false
    }
    fn disconnect_agent(&self, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn is_connected(&self, _: &str) -> bool {
        true
    }
    fn get_capabilities(&self, _: &str) -> Option<AgentCapabilities> {
        None
    }
    fn clear_retained_agent_config(&self, agent_id: &str) {
        self.cleared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(agent_id.to_string());
    }
    fn shutdown_agent(&self, _: &str, _: Option<&str>) -> Result<u32, TerminalError> {
        unimplemented!()
    }
    fn send_request(&self, _: &str, _: &str, _: Value) -> Result<Value, TerminalError> {
        // The handshake queries `connection.types`; an empty list is fine (no
        // file-browser / monitoring proxies wired for the test session).
        Ok(serde_json::json!({ "types": [] }))
    }
    fn create_session(
        &self,
        _: &str,
        session_type: &str,
        _: Value,
        title: Option<&str>,
        definition_id: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        Ok(AgentSessionInfo {
            session_id: uuid::Uuid::new_v4().to_string(),
            title: title.unwrap_or("mock").to_string(),
            session_type: session_type.to_string(),
            status: "running".to_string(),
            attached: true,
            definition_id: definition_id.map(str::to_string),
        })
    }
    fn attach_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn close_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn list_sessions(&self, _: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        Ok(Vec::new())
    }
    fn list_connections_and_folders(&self, _: &str) -> Result<AgentConnectionsData, TerminalError> {
        unimplemented!()
    }
    fn list_definitions(&self, _: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        unimplemented!()
    }
    fn save_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn update_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionUpdateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_definition(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn create_folder(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn update_folder(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::FolderUpdateParams,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_folder(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_session_output(
        &self,
        _: &str,
        _: &str,
        _: OutputSender,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn unregister_session_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn register_monitoring_output(
        &self,
        _: &str,
        _: &str,
        _: MonitoringSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_monitoring_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn send_session_input(&self, _: &str, _: &str, _: &[u8]) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn resize_session(&self, _: &str, _: &str, _: u16, _: u16) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn apply_agent_settings(&self, _: &str, _: &AgentSettings) -> Result<(), TerminalError> {
        unimplemented!()
    }
}

/// Build a manager whose agent client is a [`RetainAgent`], returning the
/// recorded-clears handle alongside it.
fn make_test_manager_with_retain_agent() -> (
    SessionManager,
    std::sync::Arc<std::sync::Mutex<Vec<String>>>,
) {
    let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
    registry.register(
        "mock",
        "Mock",
        "mock",
        Box::new(|| Box::new(MockConnection::default())),
    );
    let (agent, cleared) = RetainAgent::new();
    (SessionManager::new(registry, Arc::new(agent)), cleared)
}

#[tokio::test]
async fn create_connection_retains_request_for_resilient_agent_session() {
    // #2473: a resilient **agent** session now retains its request (with the
    // agent_id the redrive cold-re-establishes the transport through), the same
    // way a resilient direct session does (#2454). Before this, retention was
    // guarded to `agent_id.is_none()`, so agent tabs never entered the backend
    // redrive.
    let (manager, _cleared) = make_test_manager_with_retain_agent();
    manager
        .create_connection(
            "mock",
            serde_json::json!({ "password": "secret" }),
            Some("agent-1"), // resilient AGENT session
            Some("tab-a:0"),
            false,
            true, // resilient
            MockEventEmitter::new(),
        )
        .await
        .expect("agent session should open");
    let req = manager
        .retained_request("tab-a")
        .expect("a resilient agent session retains its connection request");
    assert_eq!(
        req.agent_id.as_deref(),
        Some("agent-1"),
        "the retained request carries the agent_id the redrive re-connects through"
    );
    assert!(req.resilient, "the retained request is redrive-eligible");
}

#[tokio::test]
async fn create_connection_records_agent_session_id_on_the_retained_request() {
    // #2512: a resilient AGENT tab must retain the live agent session id it is
    // attached to (from the proxy's `remote_session_id()` after the initial
    // connect), so the redrive can re-attach to *that same* live session on
    // reconnect instead of minting a new one. A resilient DIRECT tab has no
    // agent session, so it retains `None`.
    let (manager, _cleared) = make_test_manager_with_retain_agent();

    manager
        .create_connection(
            "mock",
            serde_json::json!({ "password": "secret" }),
            Some("agent-1"), // resilient AGENT session
            Some("tab-a:0"),
            false,
            true, // resilient
            MockEventEmitter::new(),
        )
        .await
        .expect("agent session should open");
    let agent_req = manager
        .retained_request("tab-a")
        .expect("a resilient agent session retains its connection request");
    assert!(
        agent_req.agent_session_id.is_some(),
        "the retained request carries the live agent session id to re-attach to (#2512)"
    );

    manager
        .create_connection(
            "mock",
            serde_json::json!({ "password": "secret" }),
            None, // resilient DIRECT session
            Some("tab-d:0"),
            false,
            true,
            MockEventEmitter::new(),
        )
        .await
        .expect("direct session should open");
    let direct_req = manager
        .retained_request("tab-d")
        .expect("a resilient direct session retains its connection request");
    assert!(
        direct_req.agent_session_id.is_none(),
        "a direct (non-agent) tab has no agent session id to retain (#2512)"
    );
}

#[tokio::test]
async fn clear_retained_request_scrubs_agent_config_only_for_the_last_tab() {
    // #2473 refcount: one SSH transport is shared by every session on an agent,
    // so the per-agent transport config (#2472) must survive until the LAST tab
    // on that agent releases its retained request. Clearing one of two sibling
    // tabs must NOT scrub the config; clearing the last one must.
    let (manager, cleared) = make_test_manager_with_retain_agent();
    for tab in ["tab-x:0", "tab-y:0"] {
        manager
            .create_connection(
                "mock",
                serde_json::json!({ "password": "secret" }),
                Some("agent-1"),
                Some(tab),
                false,
                true,
                MockEventEmitter::new(),
            )
            .await
            .expect("agent session should open");
    }

    // First sibling clears: a tab on agent-1 still holds it → no scrub.
    manager.clear_retained_request_with_agent_scrub("tab-x");
    assert!(
        cleared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty(),
        "a sibling tab still holds agent-1, so its transport config must not be scrubbed"
    );

    // Last sibling clears: nothing left on agent-1 → scrub exactly once.
    manager.clear_retained_request_with_agent_scrub("tab-y");
    assert_eq!(
        &*cleared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        &["agent-1".to_string()],
        "the last tab on agent-1 releasing it scrubs the per-agent transport config once"
    );
}

#[tokio::test]
async fn clear_retained_request_with_agent_scrub_is_a_noop_for_direct_tabs() {
    // A direct (non-agent) tab has no per-agent config, so the refcounted scrub
    // must behave exactly like the plain per-tab clear and never touch the
    // agent config store.
    let (manager, cleared) = make_test_manager_with_retain_agent();
    manager
        .create_connection(
            "mock",
            serde_json::json!({ "password": "secret" }),
            None, // direct
            Some("tab-d:0"),
            false,
            true,
            MockEventEmitter::new(),
        )
        .await
        .expect("direct session should open");
    assert!(manager.has_retained_request("tab-d"));

    manager.clear_retained_request_with_agent_scrub("tab-d");
    assert!(!manager.has_retained_request("tab-d"));
    assert!(
        cleared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty(),
        "a direct tab has no agent config to scrub"
    );
}

#[tokio::test]
async fn create_connection_records_resilient_request_for_the_redrive() {
    // A resilient direct session records its connection request with
    // `resilient: true` — the sole gate the backend reconnect redrive (#2454)
    // reads to decide it owns the transport re-establishment for this tab.
    let manager = make_test_manager();
    manager
        .create_connection(
            "mock",
            serde_json::json!({ "password": "secret" }),
            None,
            Some("tab-on:0"),
            false,
            true, // resilient
            MockEventEmitter::new(),
        )
        .await
        .expect("session should open");
    let req = manager
        .retained_request("tab-on")
        .expect("a resilient direct session retains its request");
    assert!(
        req.resilient,
        "the retained request is redrive-eligible (the redrive gate)"
    );
}

#[tokio::test]
async fn create_connection_does_not_retain_for_non_resilient_session() {
    let manager = make_test_manager();
    manager
        .create_connection(
            "mock",
            serde_json::json!({}),
            None,
            Some("tab-nr:0"),
            false,
            false, // not resilient
            MockEventEmitter::new(),
        )
        .await
        .expect("session should open");
    assert!(
        !manager.has_retained_request("tab-nr"),
        "a non-resilient tab never reconnects, so nothing is retained"
    );
}

#[tokio::test]
async fn create_connection_without_tab_retains_nothing() {
    let manager = make_test_manager();
    manager
        .create_connection(
            "mock",
            serde_json::json!({}),
            None,
            None, // no connect_id → no tab id to key by
            false,
            true,
            MockEventEmitter::new(),
        )
        .await
        .expect("session should open");
    assert!(!manager.has_retained_request(""));
}

#[tokio::test]
async fn close_session_clears_the_retained_request() {
    let manager = make_test_manager();
    let session_id = manager
        .create_connection(
            "mock",
            serde_json::json!({ "password": "secret" }),
            None,
            Some("tab-c:0"),
            false,
            true,
            MockEventEmitter::new(),
        )
        .await
        .expect("session should open");
    assert!(manager.has_retained_request("tab-c"));

    manager
        .close_session(&session_id)
        .await
        .expect("close should succeed");
    assert!(
        !manager.has_retained_request("tab-c"),
        "closing a live session drops + zeroizes its retained request (#2454)"
    );
}

#[tokio::test]
async fn clear_retained_request_is_idempotent() {
    let manager = make_test_manager();
    // Clearing a tab that never retained anything is a safe no-op.
    manager.clear_retained_request("never-seen");
    assert!(!manager.has_retained_request("never-seen"));
}

#[tokio::test]
async fn emit_and_cleanup_clears_the_tab_id_identity_bridge() {
    let emitter = MockEventEmitter::new();
    let sessions = sessions_with_mock("sess-tab").await;
    let session_tab_ids = new_session_tab_ids();
    session_tab_ids.lock().unwrap().insert(
        "sess-tab".to_string(),
        TabBinding {
            tab_id: "tab-9".to_string(),
            resilient: false,
        },
    );

    SessionManager::emit_and_cleanup(
        "sess-tab",
        Vec::new(),
        &emitter,
        &sessions,
        &new_output_buffers(),
        &new_session_loggers(),
        &session_tab_ids,
    )
    .await;

    assert!(
        !session_tab_ids.lock().unwrap().contains_key("sess-tab"),
        "the natural-exit / dropped path clears the identity-bridge entry"
    );
}

#[tokio::test]
async fn create_connection_records_the_resilient_reconnect_flag() {
    let manager = make_test_manager();
    let session_id = manager
        .create_connection(
            "mock",
            serde_json::json!({}),
            None,
            Some("tab-r:0"),
            false,
            true, // resilient-reconnect tab
            MockEventEmitter::new(),
        )
        .await
        .expect("session should open");

    let binding = manager
        .session_tab_ids
        .lock()
        .unwrap()
        .get(&session_id)
        .cloned()
        .expect("a connect_id-bearing session records a binding");
    assert_eq!(binding.tab_id, "tab-r");
    assert!(
        binding.resilient,
        "the client's resilient-reconnect determination is recorded on the binding (#2439)"
    );
}

#[test]
fn drop_fold_classifies_a_genuine_exit_like_the_client() {
    // Clean exit (code 0) folds nothing — mirrors the client's `"clean"` reason.
    assert_eq!(drop_fold_for(Some(0), false), None);
    assert_eq!(drop_fold_for(Some(0), true), None);
    // A non-zero code is a drop: resilient → reconnect, otherwise dropped.
    assert_eq!(drop_fold_for(Some(1), false), Some(DropFold::Dropped));
    assert_eq!(drop_fold_for(Some(1), true), Some(DropFold::Reconnect));
    // An unknown code (`None`) — what the desktop `terminal-exit` always emits —
    // is a drop too, resilient-gated.
    assert_eq!(drop_fold_for(None, false), Some(DropFold::Dropped));
    assert_eq!(drop_fold_for(None, true), Some(DropFold::Reconnect));
}

#[test]
fn initial_connect_failed_tab_id_folds_only_the_initial_attempt() {
    // Initial attempt (retry 0) of a tab-bearing connect → fold that tab.
    assert_eq!(
        initial_connect_failed_tab_id(Some("tab-1:0")),
        Some("tab-1".to_string())
    );
    // A reconnect attempt (retry > 0) is owned by the client loop + backend timer.
    assert_eq!(initial_connect_failed_tab_id(Some("tab-1:2")), None);
    // No connect_id (e.g. internal agent-setup session) → None.
    assert_eq!(initial_connect_failed_tab_id(None), None);
    // A connect_id not carrying the tab-id:retry form → None.
    assert_eq!(initial_connect_failed_tab_id(Some("no-colon")), None);
    // An empty tab id is rejected rather than guessed.
    assert_eq!(initial_connect_failed_tab_id(Some(":0")), None);
}

/// A connection whose `connect_cancellable` fails **immediately** (no token
/// wait) — lets us exercise a genuine, non-cancelled connect failure (#2439).
#[derive(Default)]
struct ImmediateFailConnect;

#[async_trait::async_trait]
impl ConnectionType for ImmediateFailConnect {
    fn type_id(&self) -> &str {
        "failing"
    }
    fn display_name(&self) -> &str {
        "Failing"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Err(SessionError::SpawnFailed("connection refused".to_string()))
    }
    async fn connect_cancellable(
        &mut self,
        _settings: serde_json::Value,
        _cancel: Option<CancellationToken>,
    ) -> Result<(), SessionError> {
        // Fails at once regardless of the token, so the cancel token is never
        // fired — a genuine failure, not a cancellation.
        Err(SessionError::SpawnFailed("connection refused".to_string()))
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        false
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// A connection whose connect is rejected by **authentication** — returns the
/// typed `SessionError::AuthFailed` (SM-005), so the fold classifies it as an
/// auth rejection rather than a transient failure.
struct AuthFailConnect;

#[async_trait::async_trait]
impl ConnectionType for AuthFailConnect {
    fn type_id(&self) -> &str {
        "auth-failing"
    }
    fn display_name(&self) -> &str {
        "AuthFailing"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Err(SessionError::AuthFailed)
    }
    async fn connect_cancellable(
        &mut self,
        _settings: serde_json::Value,
        _cancel: Option<CancellationToken>,
    ) -> Result<(), SessionError> {
        Err(SessionError::AuthFailed)
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        false
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

fn auth_failing_manager() -> Arc<SessionManager> {
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "auth-failing",
        "AuthFailing",
        "mock",
        Box::new(|| Box::new(AuthFailConnect)),
    );
    Arc::new(SessionManager::new(registry, Arc::new(NullAgent)))
}

fn failing_manager() -> Arc<SessionManager> {
    let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
    registry.register(
        "failing",
        "Failing",
        "mock",
        Box::new(|| Box::new(ImmediateFailConnect)),
    );
    Arc::new(SessionManager::new(registry, Arc::new(NullAgent)))
}

/// A genuine (non-cancelled) **initial** **direct** connect failure folds
/// `session.connectFailed` server-side, keyed by the tab id (#2439). The
/// symmetric third arm of the command's connect/connected fold.
#[tokio::test]
async fn create_connection_folds_connect_failed_for_a_genuine_initial_direct_failure() {
    let manager = failing_manager();
    let emitter = MockEventEmitter::new();
    let result = manager
        .create_connection(
            "failing",
            serde_json::json!({}),
            None,            // no agent → direct connect
            Some("tab-f:0"), // initial attempt
            false,
            false,
            emitter.clone(),
        )
        .await;
    assert!(result.is_err(), "the connect must fail");

    let folds = emitter.connect_faileds.lock().unwrap();
    assert_eq!(
        folds.len(),
        1,
        "exactly one connect_failed fold for a genuine initial direct failure"
    );
    assert_eq!(folds[0].0, "tab-f", "keyed by the frontend tab id");
    assert!(
        folds[0].1.contains("connection refused"),
        "the failure error is carried into the fold"
    );
    assert!(
        !folds[0].2,
        "a transient failure must NOT be classified as an auth rejection (SM-005)"
    );
}

/// A genuine **auth rejection** on an initial direct connect is classified from
/// the typed `SessionError::AuthFailed` and threaded into the fold as
/// `auth_failed == true` (SM-005), so the source folds the non-retryable
/// terminal `AuthFailed` state rather than the transient `Failed`.
#[tokio::test]
async fn create_connection_classifies_a_genuine_auth_failure_at_the_source() {
    let manager = auth_failing_manager();
    let emitter = MockEventEmitter::new();
    let result = manager
        .create_connection(
            "auth-failing",
            serde_json::json!({}),
            None,            // no agent → direct connect
            Some("tab-a:0"), // initial attempt
            false,
            false,
            emitter.clone(),
        )
        .await;
    assert!(matches!(result, Err(TerminalError::AuthFailed(_))));

    let folds = emitter.connect_faileds.lock().unwrap();
    assert_eq!(folds.len(), 1, "exactly one connect_failed fold");
    assert_eq!(folds[0].0, "tab-a");
    assert!(
        folds[0].2,
        "a genuine auth rejection must be classified as auth_failed (SM-005)"
    );
}

/// A **reconnect attempt** (`retryCount > 0`) is owned by the client loop +
/// backend timer, so its failure is **not** folded as `connect_failed` (#2439).
#[tokio::test]
async fn create_connection_does_not_fold_connect_failed_for_a_reconnect_attempt() {
    let manager = failing_manager();
    let emitter = MockEventEmitter::new();
    let _ = manager
        .create_connection(
            "failing",
            serde_json::json!({}),
            None,
            Some("tab-f:2"), // a reconnect attempt
            false,
            false,
            emitter.clone(),
        )
        .await;
    assert!(
        emitter.connect_faileds.lock().unwrap().is_empty(),
        "a reconnect attempt's failure is not source-folded (client loop owns it)"
    );
}

/// A **cancellation** (a Stop mid-connect) is not a failure, so it folds no
/// `connect_failed` even though the connect returns an error (#2439/#952).
#[tokio::test]
async fn create_connection_does_not_fold_connect_failed_on_cancellation() {
    let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
    registry.register(
        "blocking",
        "Blocking",
        "mock",
        Box::new(|| Box::new(BlockingConnect)),
    );
    let manager = Arc::new(SessionManager::new(registry, Arc::new(NullAgent)));
    let emitter = MockEventEmitter::new();

    let spawned = manager.clone();
    let spawned_emitter = emitter.clone();
    let join = tokio::spawn(async move {
        spawned
            .create_connection(
                "blocking",
                serde_json::json!({}),
                None,
                Some("tab-c:0"), // initial attempt, but cancelled
                false,
                false,
                spawned_emitter,
            )
            .await
    });

    // Poll until the connect registers its token, then fire the cancel.
    let mut cancelled = false;
    for _ in 0..200 {
        if manager.cancel_connecting("tab-c:0") {
            cancelled = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        cancelled,
        "the connecting session should have been cancellable"
    );
    let result = join.await.expect("join");
    assert!(result.is_err(), "a cancelled connect returns an error");

    assert!(
        emitter.connect_faileds.lock().unwrap().is_empty(),
        "a cancellation is a Stop, not a failure — no connect_failed fold"
    );
}

/// A connection whose `connect_cancellable` blocks until its token fires —
/// lets us exercise mid-connect cancellation (#952) deterministically.
#[derive(Default)]
struct BlockingConnect;

#[async_trait::async_trait]
impl ConnectionType for BlockingConnect {
    fn type_id(&self) -> &str {
        "blocking"
    }
    fn display_name(&self) -> &str {
        "Blocking"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        // Only reached without a token; block long enough that a failed
        // cancellation would hang the test instead of passing.
        tokio::time::sleep(Duration::from_secs(30)).await;
        Ok(())
    }
    async fn connect_cancellable(
        &mut self,
        settings: serde_json::Value,
        cancel: Option<CancellationToken>,
    ) -> Result<(), SessionError> {
        match cancel {
            Some(token) => {
                token.cancelled().await;
                Err(SessionError::SpawnFailed("connect cancelled".to_string()))
            }
            None => self.connect(settings).await,
        }
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// Cancelling a connecting local session via its `connect_id` aborts the
/// in-flight connect and clears the tracker entry (#952).
#[tokio::test]
async fn cancel_connecting_aborts_in_flight_local_connect() {
    let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
    registry.register(
        "blocking",
        "Blocking",
        "mock",
        Box::new(|| Box::new(BlockingConnect)),
    );
    let manager = Arc::new(SessionManager::new(registry, Arc::new(NullAgent)));

    let spawned = manager.clone();
    let join = tokio::spawn(async move {
        spawned
            .create_connection(
                "blocking",
                serde_json::json!({}),
                None,
                Some("c1"),
                false,
                false,
                MockEventEmitter::new(),
            )
            .await
    });

    // Poll until the connect registers its token, then fire the cancel.
    let mut cancelled = false;
    for _ in 0..200 {
        if manager.cancel_connecting("c1") {
            cancelled = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        cancelled,
        "the connecting session should have been cancellable"
    );

    let result = join.await.expect("join");
    assert!(result.is_err(), "a cancelled connect must return an error");
    // The RAII guard cleared the entry, so a second cancel finds nothing.
    assert!(!manager.cancel_connecting("c1"));
}

/// A session opened via the spawn path is recorded with `spawned=true` in
/// the registry and surfaces the flag on its `SessionInfo`, while a normal
/// local session is recorded with `spawned=false` (#1466). This backend
/// marker is the source of truth the Open Connections panel groups from, so
/// a spawned container stays under "Spawned Containers" even after its tab
/// (the previous frontend-only marker) is closed.
#[tokio::test]
async fn spawn_path_marks_session_spawned_in_registry() {
    let manager = make_test_manager();

    let spawned_id = manager
        .create_connection(
            "mock",
            serde_json::json!({}),
            None,
            None,
            true,
            false,
            MockEventEmitter::new(),
        )
        .await
        .expect("spawned session should open");

    let plain_id = manager
        .create_connection(
            "mock",
            serde_json::json!({}),
            None,
            None,
            false,
            false,
            MockEventEmitter::new(),
        )
        .await
        .expect("plain session should open");

    let sessions = manager.list_sessions().await;
    let spawned = sessions
        .iter()
        .find(|s| s.id == spawned_id)
        .expect("spawned session listed");
    let plain = sessions
        .iter()
        .find(|s| s.id == plain_id)
        .expect("plain session listed");

    assert!(spawned.spawned, "spawn-path session must be marked spawned");
    assert!(
        !plain.spawned,
        "a normal local session must not be marked spawned"
    );

    // The marker must be serialized (camelCase `spawned`) so the frontend
    // `LocalSessionInfo` mirror can group from it.
    let json = serde_json::to_value(spawned).expect("serialize SessionInfo");
    assert_eq!(json["spawned"], serde_json::json!(true));
}

// ── Persistent session tests ──────────────────────────────────────

#[tokio::test]
async fn start_persistent_session_creates_record_and_emits_running() {
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    let session_id = manager
        .start_persistent_session(
            "conn-p1",
            "mock",
            serde_json::json!({}),
            None,
            emitter.clone(),
        )
        .await
        .expect("start should succeed");

    assert!(!session_id.is_empty());

    let ps = manager.persistent_sessions.lock().await;
    assert!(ps.contains_key("conn-p1"), "record must be inserted");
    assert_eq!(ps["conn-p1"].session_id, session_id);
    drop(ps);

    let events = emitter.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].state, "running");
    assert_eq!(events[0].connection_id, "conn-p1");
    assert_eq!(events[0].session_id.as_deref(), Some(session_id.as_str()));
    assert_eq!(events[0].attached_tab_count, 0);
}

#[tokio::test]
async fn start_persistent_session_is_idempotent() {
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    let first = manager
        .start_persistent_session(
            "conn-p1",
            "mock",
            serde_json::json!({}),
            None,
            emitter.clone(),
        )
        .await
        .unwrap();
    let second = manager
        .start_persistent_session(
            "conn-p1",
            "mock",
            serde_json::json!({}),
            None,
            emitter.clone(),
        )
        .await
        .unwrap();

    assert_eq!(first, second, "idempotent call must return same session ID");
    assert_eq!(
        emitter.events().len(),
        1,
        "only the first start should emit an event"
    );
}

#[tokio::test]
async fn stop_persistent_session_removes_record_and_emits_stopped() {
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    manager
        .start_persistent_session(
            "conn-p1",
            "mock",
            serde_json::json!({}),
            None,
            emitter.clone(),
        )
        .await
        .unwrap();

    manager
        .stop_persistent_session("conn-p1", emitter.clone())
        .await
        .unwrap();

    let ps = manager.persistent_sessions.lock().await;
    assert!(
        !ps.contains_key("conn-p1"),
        "record must be removed on stop"
    );
    drop(ps);

    let events = emitter.events();
    let last = events.last().expect("at least one event");
    assert_eq!(last.state, "stopped");
}

#[tokio::test]
async fn adopt_persistent_session_registers_record_and_emits_running() {
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    let returned = manager
        .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-1", emitter.clone())
        .await
        .unwrap();
    assert_eq!(returned, "agent-sess-1");

    let ps = manager.persistent_sessions.lock().await;
    let record = ps.get("conn-adopt").expect("record registered");
    assert_eq!(record.session_id, "agent-sess-1");
    assert_eq!(record.agent_id.as_deref(), Some("agent-A"));
    assert_eq!(record.remote_session_id.as_deref(), Some("agent-sess-1"));
    assert!(record.attached_tabs.is_empty());
    drop(ps);

    let last = emitter.events().last().cloned().expect("event emitted");
    assert_eq!(last.connection_id, "conn-adopt");
    assert_eq!(last.state, "running");
    assert_eq!(last.session_id.as_deref(), Some("agent-sess-1"));
}

#[tokio::test]
async fn adopt_persistent_session_is_idempotent_for_same_agent_session() {
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    manager
        .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-1", emitter.clone())
        .await
        .unwrap();
    // Second adopt with same args returns Ok with the same session_id.
    let returned = manager
        .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-1", emitter.clone())
        .await
        .unwrap();
    assert_eq!(returned, "agent-sess-1");
}

#[tokio::test]
async fn adopt_persistent_session_rejects_conflicting_agent_session() {
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    manager
        .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-1", emitter.clone())
        .await
        .unwrap();
    let err = manager
        .adopt_persistent_session("conn-adopt", "agent-A", "agent-sess-2", emitter.clone())
        .await;
    assert!(matches!(err, Err(TerminalError::SpawnFailed(_))));
}

#[tokio::test]
async fn attach_persistent_tab_emits_attached_with_tab_count() {
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    manager
        .start_persistent_session(
            "conn-p1",
            "mock",
            serde_json::json!({}),
            None,
            emitter.clone(),
        )
        .await
        .unwrap();

    let attach = manager
        .attach_persistent_tab("conn-p1", "tab-1", emitter.clone())
        .await
        .unwrap();
    assert_eq!(attach.count, 1);
    assert!(!attach.held_by_peer);

    let events = emitter.events();
    let last = events.last().unwrap();
    assert_eq!(last.state, "attached");
    assert_eq!(last.attached_tab_count, 1);
}

#[tokio::test]
async fn detach_persistent_tab_emits_running_when_no_tabs_remain() {
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    manager
        .start_persistent_session(
            "conn-p1",
            "mock",
            serde_json::json!({}),
            None,
            emitter.clone(),
        )
        .await
        .unwrap();

    manager
        .attach_persistent_tab("conn-p1", "tab-1", emitter.clone())
        .await
        .unwrap();

    let session_id = {
        let ps = manager.persistent_sessions.lock().await;
        ps["conn-p1"].session_id.clone()
    };

    let count = manager
        .detach_persistent_tab(&session_id, "tab-1", emitter.clone())
        .await
        .unwrap();
    assert_eq!(count, 0);

    let events = emitter.events();
    let last = events.last().unwrap();
    assert_eq!(last.state, "running");
    assert_eq!(last.attached_tab_count, 0);
}

#[tokio::test]
async fn list_persistent_sessions_returns_registered_sessions() {
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    let session_id = manager
        .start_persistent_session(
            "conn-p1",
            "mock",
            serde_json::json!({}),
            None,
            emitter.clone(),
        )
        .await
        .unwrap();

    let list = manager.list_persistent_sessions().await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].connection_id, "conn-p1");
    assert_eq!(list[0].session_id, session_id);
    assert_eq!(list[0].attached_tab_count, 0);
}

/// Verify `PersistentSessionStateEvent` serialises with snake_case field names
/// so the TypeScript frontend's `event.payload.connection_id` etc. resolve correctly.
#[test]
fn persistent_session_state_event_serialises_snake_case() {
    let event = PersistentSessionStateEvent {
        connection_id: "agent-1:def-1".to_string(),
        session_id: Some("sess-abc".to_string()),
        state: "running".to_string(),
        attached_tab_count: 2,
        error_message: None,
    };
    let json = serde_json::to_string(&event).unwrap();
    assert!(
        json.contains("\"connection_id\""),
        "must use snake_case; got: {json}"
    );
    assert!(
        json.contains("\"session_id\""),
        "must use snake_case; got: {json}"
    );
    assert!(
        json.contains("\"attached_tab_count\""),
        "must use snake_case; got: {json}"
    );
    assert!(
        !json.contains("\"connectionId\"") && !json.contains("\"sessionId\""),
        "camelCase must not appear; got: {json}"
    );
}

// ── SpyAgent for attach_persistent_tab regression tests ──────────

type AttachLog = std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>;

/// An `AgentRpcClient` implementation that records `attach_session` calls
/// and succeeds silently on `register_session_output`.
struct SpyAgent {
    attach_calls: AttachLog,
    /// When set, a plain `attach_session` is refused as held by another desktop
    /// (SM-003, #3404) until a `reclaim_session` takes the session over.
    held_by_peer: Arc<AtomicBool>,
    reclaim_calls: AttachLog,
    /// Output senders registered for re-attached sessions, so a test can stream
    /// output as the agent would after a Reclaim.
    outputs: Arc<std::sync::Mutex<Vec<OutputSender>>>,
}

impl SpyAgent {
    fn new() -> (Self, AttachLog) {
        let calls: AttachLog = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        (
            Self {
                attach_calls: calls.clone(),
                held_by_peer: Arc::new(AtomicBool::new(false)),
                reclaim_calls: Arc::new(std::sync::Mutex::new(Vec::new())),
                outputs: Arc::new(std::sync::Mutex::new(Vec::new())),
            },
            calls,
        )
    }

    /// A spy whose sessions are held by another desktop: plain attaches are
    /// refused with the typed [`TerminalError::SessionHeldByPeer`].
    fn held() -> Self {
        let (spy, _) = Self::new();
        spy.held_by_peer.store(true, Ordering::SeqCst);
        spy
    }
}

impl AgentRpcClient for SpyAgent {
    fn connect_agent(
        &self,
        _: &str,
        _: &RemoteAgentConfig,
        _: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        unimplemented!()
    }
    fn cancel_connect(&self, _: &str) -> bool {
        false
    }
    fn disconnect_agent(&self, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn is_connected(&self, _: &str) -> bool {
        false
    }
    fn get_capabilities(&self, _: &str) -> Option<AgentCapabilities> {
        None
    }
    fn shutdown_agent(&self, _: &str, _: Option<&str>) -> Result<u32, TerminalError> {
        unimplemented!()
    }
    fn send_request(&self, _: &str, _: &str, _: Value) -> Result<Value, TerminalError> {
        unimplemented!()
    }
    fn create_session(
        &self,
        _: &str,
        _: &str,
        _: Value,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        unimplemented!()
    }
    fn attach_session(&self, agent_id: &str, remote_sid: &str) -> Result<(), TerminalError> {
        self.attach_calls
            .lock()
            .unwrap()
            .push((agent_id.to_string(), remote_sid.to_string()));
        if self.held_by_peer.load(Ordering::SeqCst) {
            return Err(TerminalError::SessionHeldByPeer(
                "Session is held by another desktop".to_string(),
            ));
        }
        Ok(())
    }
    fn reclaim_session(&self, agent_id: &str, remote_sid: &str) -> Result<(), TerminalError> {
        self.reclaim_calls
            .lock()
            .unwrap()
            .push((agent_id.to_string(), remote_sid.to_string()));
        self.held_by_peer.store(false, Ordering::SeqCst);
        Ok(())
    }
    fn close_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn list_sessions(&self, _: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        unimplemented!()
    }
    fn list_connections_and_folders(&self, _: &str) -> Result<AgentConnectionsData, TerminalError> {
        unimplemented!()
    }
    fn list_definitions(&self, _: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        unimplemented!()
    }
    fn save_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn update_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionUpdateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_definition(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn create_folder(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn update_folder(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::FolderUpdateParams,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_folder(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_session_output(
        &self,
        _: &str,
        _: &str,
        tx: OutputSender,
    ) -> Result<(), TerminalError> {
        self.outputs.lock().unwrap().push(tx);
        Ok(())
    }
    fn unregister_session_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn register_monitoring_output(
        &self,
        _: &str,
        _: &str,
        _: MonitoringSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_monitoring_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn send_session_input(&self, _: &str, _: &str, _: &[u8]) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn resize_session(&self, _: &str, _: &str, _: u16, _: u16) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn apply_agent_settings(&self, _: &str, _: &AgentSettings) -> Result<(), TerminalError> {
        unimplemented!()
    }
}

/// Regression: `attach_persistent_tab` must NOT call `attach_session` for
/// local (non-agent) sessions where there is no agent_id or remote_session_id.
#[tokio::test]
async fn attach_persistent_tab_skips_daemon_reattach_for_local_session() {
    // NullAgent.attach_session panics (unimplemented!), so if it were called
    // by the local-session path this test would fail.
    let manager = make_test_manager();
    let emitter = MockPersistentEmitter::new();

    manager
        .start_persistent_session(
            "conn-local",
            "mock",
            serde_json::json!({}),
            None,
            emitter.clone(),
        )
        .await
        .unwrap();

    // Should succeed without panicking (no attach_session call).
    manager
        .attach_persistent_tab("conn-local", "tab-1", emitter.clone())
        .await
        .unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    // No assertion needed: if NullAgent.attach_session were called it would panic.
}

/// Regression: after an agent SSH disconnect, `emit_and_cleanup` removes the
/// desktop session from `sessions` but the daemon process on the remote host
/// is still alive. `attach_persistent_tab` must re-create the `RemoteProxy`
/// and re-insert it under the same session ID so the tab's `existingSessionId`
/// prop keeps working without any frontend state update.
#[tokio::test]
async fn attach_persistent_tab_reconnects_after_agent_disconnect() {
    let (spy, attach_calls) = SpyAgent::new();

    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "mock",
        "Mock",
        "mock",
        Box::new(|| Box::new(MockConnection::default())),
    );
    let manager = SessionManager::new(registry, Arc::new(spy));
    let emitter = MockPersistentEmitter::new();

    let session_id = manager
        .start_persistent_session(
            "conn-1",
            "mock",
            serde_json::json!({}),
            None,
            emitter.clone(),
        )
        .await
        .unwrap();

    // Inject agent-side session info as if this were a real remote session.
    {
        let mut sessions = manager.sessions.lock().await;
        if let Some(entry) = sessions.get_mut(&session_id) {
            entry.info.agent_id = Some("agent-1".to_string());
            entry.remote_session_id = Some("remote-1".to_string());
        }
    }
    // Also update the persistent record with the same info (mirrors what
    // start_persistent_session does when agent_id is Some).
    {
        let mut ps = manager.persistent_sessions.lock().await;
        if let Some(record) = ps.get_mut("conn-1") {
            record.agent_id = Some("agent-1".to_string());
            record.remote_session_id = Some("remote-1".to_string());
        }
    }

    // Simulate agent disconnect: remove the session from sessions (what
    // emit_and_cleanup does) but leave the persistent record intact.
    {
        let mut sessions = manager.sessions.lock().await;
        sessions.remove(&session_id);
    }
    assert!(
        !manager.sessions.lock().await.contains_key(&session_id),
        "session must be removed to simulate agent disconnect"
    );
    assert!(
        manager
            .persistent_sessions
            .lock()
            .await
            .contains_key("conn-1"),
        "persistent record must survive agent disconnect"
    );

    // Now simulate the user clicking "Attach" after the agent reconnects.
    manager
        .attach_persistent_tab("conn-1", "tab-after-reconnect", emitter.clone())
        .await
        .expect("attach must succeed after agent reconnect");

    // The session must have been re-inserted under the same session ID.
    assert!(
        manager.sessions.lock().await.contains_key(&session_id),
        "session must be re-created under the same ID after reconnect"
    );

    // attach_session must have been called (by reconnect_existing) to get the buffer replay.
    let calls = attach_calls.lock().unwrap();
    assert_eq!(
        calls.len(),
        1,
        "attach_session must be called once for reconnect"
    );
    assert_eq!(calls[0].0, "agent-1");
    assert_eq!(calls[0].1, "remote-1");
}

// ── Held by another desktop (SM-003, #3404) ─────────────────────────

/// Wait until `emitter` has emitted output containing `needle` for `session_id`.
async fn wait_for_emitted(emitter: &MockEventEmitter, session_id: &str, needle: &[u8]) -> bool {
    for _ in 0..100 {
        let found = emitter.outputs.lock().unwrap().iter().any(|e| {
            e.session_id == session_id && e.data.windows(needle.len()).any(|w| w == needle)
        });
        if found {
            return true;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    }
    false
}

/// A resilient agent tab's implicit re-attach (the reconnect redrive) refused
/// because another desktop holds the session is not an error: the desktop entry
/// and tab binding are registered and the refusal is reported as
/// `held_by_peer`, so the tab can fold `Evicted`. An explicit Reclaim then takes
/// the session over (a takeover attach) and output flows to the tab.
#[tokio::test]
async fn reattach_agent_session_held_by_peer_registers_entry_and_reclaims() {
    let spy = SpyAgent::held();
    let reclaim_calls = spy.reclaim_calls.clone();
    let outputs = spy.outputs.clone();
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(spy));
    let emitter = MockEventEmitter::new();

    let reattach = manager
        .reattach_agent_session("tab-held", "agent-1", "remote-1", emitter.clone())
        .await
        .expect("a held refusal is not an error");
    assert!(
        reattach.held_by_peer,
        "the refusal must be reported as held"
    );

    // The desktop entry + tab binding exist, so Reclaim can resolve the session.
    assert!(manager
        .sessions
        .lock()
        .await
        .contains_key(&reattach.session_id));
    assert_eq!(
        manager.agent_session_for_tab("tab-held").await,
        Some(("agent-1".to_string(), "remote-1".to_string()))
    );
    assert!(
        reclaim_calls.lock().unwrap().is_empty(),
        "never reclaims implicitly"
    );

    manager
        .reclaim_session("tab-held")
        .await
        .expect("reclaim from the held state succeeds");
    assert_eq!(
        reclaim_calls.lock().unwrap().as_slice(),
        &[("agent-1".to_string(), "remote-1".to_string())]
    );

    // Output the agent streams after the takeover reaches the tab's session.
    let tx = outputs
        .lock()
        .unwrap()
        .last()
        .cloned()
        .expect("output registered");
    tx.send(b"after-reclaim".to_vec()).unwrap();
    assert!(wait_for_emitted(&emitter, &reattach.session_id, b"after-reclaim").await);
}

/// An unheld implicit re-attach is unchanged: attached, not held.
#[tokio::test]
async fn reattach_agent_session_unheld_is_attached() {
    let (spy, attach_calls) = SpyAgent::new();
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(spy));

    let reattach = manager
        .reattach_agent_session("tab-1", "agent-1", "remote-1", MockEventEmitter::new())
        .await
        .unwrap();
    assert!(!reattach.held_by_peer);
    assert_eq!(attach_calls.lock().unwrap().len(), 1);
}

/// A generic (non-held) re-attach failure still surfaces as an error and
/// registers nothing.
#[tokio::test]
async fn reattach_agent_session_generic_failure_is_an_error() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(FailingAttachAgent));
    let result = manager
        .reattach_agent_session("tab-1", "agent-1", "remote-1", MockEventEmitter::new())
        .await;
    assert!(result.is_err());
    assert!(manager.sessions.lock().await.is_empty());
    assert_eq!(manager.agent_session_for_tab("tab-1").await, None);
}

/// A persistent tab whose re-attach is refused as held keeps the re-created
/// desktop entry, is bound to it (so Reclaim works) and reports `held_by_peer`
/// instead of failing the attach.
#[tokio::test]
async fn attach_persistent_tab_held_by_peer_keeps_entry_for_reclaim() {
    let spy = SpyAgent::held();
    let reclaim_calls = spy.reclaim_calls.clone();
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(spy));
    let emitter = MockPersistentEmitter::new();

    manager.persistent_sessions.lock().await.insert(
        "conn-held".to_string(),
        PersistentRecord {
            connection_id: "conn-held".to_string(),
            session_id: "sess-held".to_string(),
            attached_tabs: HashSet::new(),
            remote_session_id: Some("remote-1".to_string()),
            agent_id: Some("agent-1".to_string()),
        },
    );

    let attach = manager
        .attach_persistent_tab("conn-held", "tab-held", emitter.clone())
        .await
        .expect("a held refusal is not an attach error");
    assert!(attach.held_by_peer);
    assert_eq!(attach.session_id, "sess-held");
    assert_eq!(attach.count, 1);
    assert!(manager.sessions.lock().await.contains_key("sess-held"));

    manager
        .reclaim_session("tab-held")
        .await
        .expect("reclaim resolves through the tab binding");
    assert_eq!(reclaim_calls.lock().unwrap().len(), 1);
}

/// An `AgentRpcClient` whose plain attach fails with a generic error.
struct FailingAttachAgent;

impl AgentRpcClient for FailingAttachAgent {
    fn connect_agent(
        &self,
        _: &str,
        _: &RemoteAgentConfig,
        _: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        unimplemented!()
    }
    fn cancel_connect(&self, _: &str) -> bool {
        false
    }
    fn disconnect_agent(&self, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn is_connected(&self, _: &str) -> bool {
        false
    }
    fn get_capabilities(&self, _: &str) -> Option<AgentCapabilities> {
        None
    }
    fn shutdown_agent(&self, _: &str, _: Option<&str>) -> Result<u32, TerminalError> {
        unimplemented!()
    }
    fn send_request(&self, _: &str, _: &str, _: Value) -> Result<Value, TerminalError> {
        unimplemented!()
    }
    fn create_session(
        &self,
        _: &str,
        _: &str,
        _: Value,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        unimplemented!()
    }
    fn attach_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Err(TerminalError::RemoteError(
            "Agent connection lost".to_string(),
        ))
    }
    fn close_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn list_sessions(&self, _: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        unimplemented!()
    }
    fn list_connections_and_folders(&self, _: &str) -> Result<AgentConnectionsData, TerminalError> {
        unimplemented!()
    }
    fn list_definitions(&self, _: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        unimplemented!()
    }
    fn save_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn update_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionUpdateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_definition(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn create_folder(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn update_folder(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::FolderUpdateParams,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_folder(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_session_output(
        &self,
        _: &str,
        _: &str,
        _: OutputSender,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn unregister_session_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn register_monitoring_output(
        &self,
        _: &str,
        _: &str,
        _: MonitoringSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_monitoring_output(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn send_session_input(&self, _: &str, _: &str, _: &[u8]) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn resize_session(&self, _: &str, _: &str, _: u16, _: u16) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn apply_agent_settings(&self, _: &str, _: &AgentSettings) -> Result<(), TerminalError> {
        unimplemented!()
    }
}

// ── FileOps facade tests (#2076) ──────────────────────────────────
//
// The file-op methods were extracted into a `FileOps` facade
// (`session/file_ops.rs`). These lock in the manager's delegation and the
// exact error messages it must preserve across the refactor.

/// A minimal in-memory [`FileBrowser`] that records the paths it was asked
/// to list and echoes deterministic data back, so the manager's delegation
/// can be asserted without a real file backend.
struct MockFileBrowser {
    listed: Arc<std::sync::Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl FileBrowser for MockFileBrowser {
    async fn list_dir(
        &self,
        path: &str,
    ) -> Result<Vec<FileEntry>, termihub_core::errors::FileError> {
        self.listed.lock().unwrap().push(path.to_string());
        Ok(vec![FileEntry {
            name: "file.txt".to_string(),
            path: format!("{path}/file.txt"),
            is_directory: false,
            size: 3,
            modified: String::new(),
            permissions: None,
            writable: None,
            is_symlink: false,
            symlink_target: None,
        }])
    }
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, termihub_core::errors::FileError> {
        // Echo the requested path so the test can prove the argument reached
        // the browser through the facade.
        Ok(path.as_bytes().to_vec())
    }
    async fn write_file(
        &self,
        _path: &str,
        _data: &[u8],
    ) -> Result<(), termihub_core::errors::FileError> {
        Ok(())
    }
    async fn delete(&self, _path: &str) -> Result<(), termihub_core::errors::FileError> {
        Ok(())
    }
    async fn rename(&self, _from: &str, _to: &str) -> Result<(), termihub_core::errors::FileError> {
        Ok(())
    }
    async fn stat(&self, path: &str) -> Result<FileEntry, termihub_core::errors::FileError> {
        Ok(FileEntry {
            name: path.to_string(),
            path: path.to_string(),
            is_directory: false,
            size: 0,
            modified: String::new(),
            permissions: None,
            writable: None,
            is_symlink: false,
            symlink_target: None,
        })
    }
    async fn mkdir(&self, _path: &str) -> Result<(), termihub_core::errors::FileError> {
        Ok(())
    }
    async fn set_permissions(
        &self,
        _path: &str,
        _mode: u32,
    ) -> Result<(), termihub_core::errors::FileError> {
        Ok(())
    }
    async fn set_owner(
        &self,
        _path: &str,
        _uid: Option<u32>,
        _gid: Option<u32>,
    ) -> Result<(), termihub_core::errors::FileError> {
        Ok(())
    }
    async fn create_symlink(
        &self,
        _target: &str,
        _link_path: &str,
    ) -> Result<(), termihub_core::errors::FileError> {
        Ok(())
    }
    async fn copy(&self, _src: &str, _dest: &str) -> Result<(), termihub_core::errors::FileError> {
        Ok(())
    }
}

/// A connection that advertises a file-browser capability backed by a
/// [`MockFileBrowser`].
struct FileConnection {
    browser: MockFileBrowser,
}

#[async_trait::async_trait]
impl ConnectionType for FileConnection {
    fn type_id(&self) -> &str {
        "file"
    }
    fn display_name(&self) -> &str {
        "File"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: true,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _: u16, _: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        Some(&self.browser)
    }
}

/// The manager's file-op methods forward to the session's file browser,
/// passing the path through and returning the browser's result unchanged.
#[tokio::test]
async fn file_ops_delegate_to_session_file_browser() {
    let listed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session(
            "fs-1",
            Box::new(FileConnection {
                browser: MockFileBrowser {
                    listed: listed.clone(),
                },
            }),
        )
        .await;

    let entries = manager.list_files("fs-1", "/home").await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "file.txt");
    assert_eq!(listed.lock().unwrap().as_slice(), &["/home".to_string()]);

    // read_file delegates and returns the browser's bytes (which echo the path).
    let data = manager.read_file("fs-1", "/etc/hosts").await.unwrap();
    assert_eq!(data, b"/etc/hosts");
}

/// A session whose connection exposes no file browser yields the exact
/// `RemoteError("No file browser capability")` the manager returned before
/// the facade extraction.
#[tokio::test]
async fn file_ops_error_when_connection_has_no_file_browser() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session("no-fs", Box::new(MockConnection::default()))
        .await;
    match manager.read_file("no-fs", "/").await {
        Err(TerminalError::RemoteError(msg)) => {
            assert_eq!(msg, "No file browser capability");
        }
        other => panic!("expected RemoteError, got {other:?}"),
    }
}

/// An unknown session yields `SessionNotFound`, unchanged by the facade.
#[tokio::test]
async fn file_ops_error_when_session_unknown() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    let err = manager.read_file("ghost", "/").await.unwrap_err();
    assert!(matches!(err, TerminalError::SessionNotFound(_)));
}

/// The session-scoped SFTP advanced ops (#2312) refuse a session whose file
/// browser is not SFTP-backed: the `MockFileBrowser` uses the default
/// `FileBrowser::as_any` (returns `None`), so the downcast to
/// `SftpFileBrowser` fails and every entry point returns the "not supported"
/// `RemoteError` rather than misbehaving.
#[tokio::test]
async fn session_sftp_ops_error_when_browser_not_sftp_backed() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session(
            "fs-nonsftp",
            Box::new(FileConnection {
                browser: MockFileBrowser {
                    listed: Arc::new(std::sync::Mutex::new(Vec::new())),
                },
            }),
        )
        .await;

    let assert_not_supported = |res: Result<String, TerminalError>| match res {
        Err(TerminalError::RemoteError(msg)) => {
            assert!(
                msg.contains("does not support SFTP advanced operations"),
                "unexpected message: {msg}"
            );
        }
        other => panic!("expected RemoteError, got {other:?}"),
    };

    assert_not_supported(manager.session_realpath("fs-nonsftp", ".").await);
    // The transfer-handle resolver rejects the same way. `SftpFileBrowser` is
    // not `Debug`, so assert on the error without formatting the Ok value.
    match manager.sftp_transfer_browser("fs-nonsftp").await {
        Err(TerminalError::RemoteError(msg)) => {
            assert!(msg.contains("does not support SFTP advanced operations"))
        }
        Err(other) => panic!("expected RemoteError, got {other:?}"),
        Ok(_) => panic!("expected RemoteError for a non-SFTP session, got Ok"),
    }
    // has_exec_capability also rejects a non-SFTP session (it cannot silently
    // report `false` — that verdict only applies to a real SFTP connection).
    assert!(matches!(
        manager.session_has_exec_capability("fs-nonsftp").await,
        Err(TerminalError::RemoteError(_))
    ));
}

/// The session-scoped SFTP ops surface `SessionNotFound` for an unknown
/// session, exactly like the rest of the file-ops facade (#2312).
#[tokio::test]
async fn session_sftp_ops_error_when_session_unknown() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    assert!(matches!(
        manager.session_realpath("ghost", ".").await,
        Err(TerminalError::SessionNotFound(_))
    ));
    assert!(matches!(
        manager.sftp_transfer_browser("ghost").await,
        Err(TerminalError::SessionNotFound(_))
    ));
}

// ── MonitoringController facade tests (#2110) ─────────────────────
//
// The session-monitoring methods were extracted into a
// `MonitoringController` facade (`session/monitoring_controller.rs`). These
// lock in the manager's delegation, the preserved error messages, and — for
// the provider-driven controls — that each call reaches the session's
// monitoring provider unchanged. `start_session_monitoring` needs a Tauri
// `AppHandle` (no mock runtime is wired for these unit tests), so it is
// exercised via the build and the event-serialisation test above; the four
// handle-free controls are covered directly here.

/// A monitoring provider that records the controller's calls in order, so a
/// test can assert the delegation reached it with the exact arguments.
#[derive(Default)]
struct RecordingMonitoringProvider {
    calls: Arc<std::sync::Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl MonitoringProvider for RecordingMonitoringProvider {
    async fn subscribe(
        &self,
    ) -> Result<termihub_core::monitoring::MonitoringSubscription, termihub_core::errors::CoreError>
    {
        self.calls.lock().unwrap().push("subscribe".to_string());
        let (_stats_tx, stats_rx) = tokio::sync::mpsc::channel(1);
        let (_status_tx, status_rx) = tokio::sync::mpsc::channel(1);
        Ok(termihub_core::monitoring::MonitoringSubscription {
            stats: stats_rx,
            status: status_rx,
        })
    }
    async fn unsubscribe(&self) -> Result<(), termihub_core::errors::CoreError> {
        self.calls.lock().unwrap().push("unsubscribe".to_string());
        Ok(())
    }
    async fn set_interval(&self, interval: std::time::Duration) {
        self.calls
            .lock()
            .unwrap()
            .push(format!("set_interval:{}", interval.as_millis()));
    }
    async fn set_paused(&self, paused: bool) {
        self.calls
            .lock()
            .unwrap()
            .push(format!("set_paused:{paused}"));
    }
    async fn cancel_connect(&self) {
        self.calls
            .lock()
            .unwrap()
            .push("cancel_connect".to_string());
    }
}

/// A connection that advertises a monitoring capability backed by a
/// [`RecordingMonitoringProvider`]. The provider is held in an `Arc` so the
/// connection can expose it via `monitoring_handle` (CONC-007).
struct MonitoringConnection {
    provider: Arc<RecordingMonitoringProvider>,
}

#[async_trait::async_trait]
impl ConnectionType for MonitoringConnection {
    fn type_id(&self) -> &str {
        "monitoring"
    }
    fn display_name(&self) -> &str {
        "Monitoring"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: true,
            file_browser: false,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _: u16, _: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        Some(self.provider.as_ref())
    }
    fn monitoring_handle(&self) -> Option<Arc<dyn MonitoringProvider + Send + Sync>> {
        Some(self.provider.clone())
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// The provider-driven monitoring controls (pause, interval, cancel) and
/// `stop` forward to the session's monitoring provider with their arguments
/// intact — the interval is clamped to `>= 1ms` exactly as before the
/// facade extraction, and `stop` unsubscribes even with no running task.
#[tokio::test]
async fn monitoring_controls_delegate_to_session_provider() {
    let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session(
            "mon-1",
            Box::new(MonitoringConnection {
                provider: Arc::new(RecordingMonitoringProvider {
                    calls: calls.clone(),
                }),
            }),
        )
        .await;

    manager
        .set_session_monitoring_paused("mon-1", true)
        .await
        .unwrap();
    manager
        .set_session_monitoring_interval("mon-1", 500)
        .await
        .unwrap();
    // 0 is clamped to 1ms (interval_ms.max(1)).
    manager
        .set_session_monitoring_interval("mon-1", 0)
        .await
        .unwrap();
    manager.cancel_session_monitoring("mon-1").await.unwrap();
    // No push task was registered, so stop only unsubscribes.
    manager.stop_session_monitoring("mon-1").await.unwrap();

    assert_eq!(
        calls.lock().unwrap().as_slice(),
        &[
            "set_paused:true".to_string(),
            "set_interval:500".to_string(),
            "set_interval:1".to_string(),
            "cancel_connect".to_string(),
            "unsubscribe".to_string(),
        ]
    );
}

/// A session whose connection exposes no monitoring provider yields the
/// exact `RemoteError("No monitoring capability")` the manager returned
/// before the facade extraction, for both provider-required controls.
#[tokio::test]
async fn monitoring_controls_error_when_connection_has_no_capability() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session("no-mon", Box::new(MockConnection::default()))
        .await;

    match manager.set_session_monitoring_paused("no-mon", true).await {
        Err(TerminalError::RemoteError(msg)) => {
            assert_eq!(msg, "No monitoring capability");
        }
        other => panic!("expected RemoteError, got {other:?}"),
    }
    match manager.set_session_monitoring_interval("no-mon", 100).await {
        Err(TerminalError::RemoteError(msg)) => {
            assert_eq!(msg, "No monitoring capability");
        }
        other => panic!("expected RemoteError, got {other:?}"),
    }
}

/// The provider-required controls surface `SessionNotFound` for an unknown
/// session, unchanged by the facade.
#[tokio::test]
async fn monitoring_controls_error_when_session_unknown() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    assert!(matches!(
        manager
            .set_session_monitoring_paused("ghost", true)
            .await
            .unwrap_err(),
        TerminalError::SessionNotFound(_)
    ));
    assert!(matches!(
        manager
            .set_session_monitoring_interval("ghost", 100)
            .await
            .unwrap_err(),
        TerminalError::SessionNotFound(_)
    ));
}

/// `stop` and `cancel` are best-effort: an unknown session is treated as
/// already gone and returns `Ok(())` rather than erroring.
#[tokio::test]
async fn stop_and_cancel_monitoring_are_noops_for_unknown_session() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager.stop_session_monitoring("ghost").await.unwrap();
    manager.cancel_session_monitoring("ghost").await.unwrap();
}

// ── CONC-007: no `sessions` lock held across a provider network call ──

/// A monitoring provider whose `unsubscribe` parks until released, firing a
/// signal once it is in flight — lets a test prove the `sessions` map lock
/// is not held across a provider (network) call.
struct BlockingMonitoringProvider {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl MonitoringProvider for BlockingMonitoringProvider {
    async fn subscribe(
        &self,
    ) -> Result<termihub_core::monitoring::MonitoringSubscription, termihub_core::errors::CoreError>
    {
        unreachable!("this test drives unsubscribe, not subscribe")
    }
    async fn unsubscribe(&self) -> Result<(), termihub_core::errors::CoreError> {
        // Announce we are mid-call, then park until released — all while,
        // under the fix, holding no `sessions` lock.
        self.entered.notify_one();
        self.release.notified().await;
        Ok(())
    }
    async fn set_interval(&self, _interval: std::time::Duration) {}
    async fn set_paused(&self, _paused: bool) {}
    async fn cancel_connect(&self) {}
}

/// A connection exposing a [`BlockingMonitoringProvider`] via an owned
/// handle (CONC-007).
struct BlockingMonitoringConnection {
    provider: Arc<BlockingMonitoringProvider>,
}

#[async_trait::async_trait]
impl ConnectionType for BlockingMonitoringConnection {
    fn type_id(&self) -> &str {
        "blocking-monitoring"
    }
    fn display_name(&self) -> &str {
        "Blocking Monitoring"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: true,
            file_browser: false,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _: u16, _: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        Some(self.provider.as_ref())
    }
    fn monitoring_handle(&self) -> Option<Arc<dyn MonitoringProvider + Send + Sync>> {
        Some(self.provider.clone())
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// CONC-007: a monitoring provider (network) call must run with no
/// `sessions` map lock held. While one session's `unsubscribe` is parked
/// mid-call, an unrelated op that needs the map lock must still make
/// progress; under the pre-fix code (lock held across the provider call)
/// this would deadlock.
#[tokio::test]
async fn monitoring_provider_call_does_not_hold_sessions_lock() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let provider = Arc::new(BlockingMonitoringProvider {
        entered: entered.clone(),
        release: release.clone(),
    });

    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session(
            "mon-block",
            Box::new(BlockingMonitoringConnection { provider }),
        )
        .await;

    // Drive stop → unsubscribe, which parks inside the provider.
    let bg = manager.clone();
    let stop = tokio::spawn(async move { bg.stop_session_monitoring("mon-block").await });

    // Wait until unsubscribe is confirmed in flight.
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .expect("unsubscribe should reach the provider");

    // The map lock must be free: an unrelated op that needs it completes
    // promptly instead of blocking behind the parked unsubscribe.
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        manager.insert_test_session("other", Box::new(MockConnection::default())),
    )
    .await
    .expect("sessions map must stay lockable during a provider network call");

    // Release the provider and confirm the stop completed cleanly.
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), stop)
        .await
        .expect("stop task should join")
        .expect("stop task should not panic")
        .expect("stop_session_monitoring should succeed");
}

// ── test_connection: validate without persisting or leaving a session (UX-007) ──

/// A connection whose connect is rejected because the host is **unreachable** —
/// returns the typed `SessionError::ConnectionFailed` (the transport/timeout
/// discriminant), so `test_connection` can classify it distinctly from an auth
/// rejection (I18N-002 / ERR-003).
struct UnreachableConnect;

#[async_trait::async_trait]
impl ConnectionType for UnreachableConnect {
    fn type_id(&self) -> &str {
        "unreachable"
    }
    fn display_name(&self) -> &str {
        "Unreachable"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Err(SessionError::ConnectionFailed(
            "no route to host".to_string(),
        ))
    }
    async fn connect_cancellable(
        &mut self,
        _settings: serde_json::Value,
        _cancel: Option<CancellationToken>,
    ) -> Result<(), SessionError> {
        Err(SessionError::ConnectionFailed(
            "no route to host".to_string(),
        ))
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        false
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// A reachable connection validates successfully, is **torn down immediately**
/// (never left live), and leaves **nothing** in the `sessions` map — the core
/// validate-and-teardown contract of `test_connection` (UX-007).
#[tokio::test]
async fn test_connection_succeeds_tears_down_and_leaves_no_session() {
    let disconnected = Arc::new(AtomicBool::new(false));
    let flag = disconnected.clone();
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "spy",
        "Spy",
        "mock",
        Box::new(move || Box::new(DisconnectSpy::new(flag.clone()))),
    );
    let manager = SessionManager::new(registry, Arc::new(NullAgent));

    let result = manager
        .test_connection("spy", serde_json::json!({}), None, Some("test-1:0"))
        .await;

    assert!(
        result.is_ok(),
        "a reachable connection must validate: {result:?}"
    );
    assert!(
        disconnected.load(Ordering::SeqCst),
        "the probe connection must be disconnected (never left live)"
    );
    assert!(
        manager.sessions.lock().await.is_empty(),
        "test_connection must not register a session"
    );
    // The RAII guard cleared the connect token, so nothing is left in flight.
    assert!(!manager.cancel_connecting("test-1:0"));
}

/// A genuine **auth rejection** surfaces as the typed `SessionError::AuthFailed`,
/// which the command layer maps to `TerminalError::AuthFailed` (the `auth_failed`
/// machine code) — and no session is left behind.
#[tokio::test]
async fn test_connection_classifies_auth_failure() {
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "auth-failing",
        "AuthFailing",
        "mock",
        Box::new(|| Box::new(AuthFailConnect)),
    );
    let manager = SessionManager::new(registry, Arc::new(NullAgent));

    let result = manager
        .test_connection("auth-failing", serde_json::json!({}), None, None)
        .await;

    assert!(
        matches!(result, Err(SessionError::AuthFailed)),
        "an auth rejection must surface as the typed AuthFailed, got {result:?}"
    );
    // End-to-end: the command layer classifies it as the IPC AuthFailed variant.
    let ipc = TerminalError::from_session_spawn(result.unwrap_err());
    assert!(matches!(ipc, TerminalError::AuthFailed(_)));
    assert!(
        manager.sessions.lock().await.is_empty(),
        "a failed test must not register a session"
    );
}

/// An **unreachable host** surfaces as the typed `SessionError::ConnectionFailed`,
/// which the command layer maps to the coded `TerminalError::unreachable` — a
/// distinct classification from an auth failure — and leaves no session.
#[tokio::test]
async fn test_connection_classifies_unreachable_host() {
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "unreachable",
        "Unreachable",
        "mock",
        Box::new(|| Box::new(UnreachableConnect)),
    );
    let manager = SessionManager::new(registry, Arc::new(NullAgent));

    let result = manager
        .test_connection("unreachable", serde_json::json!({}), None, None)
        .await;

    assert!(
        matches!(result, Err(SessionError::ConnectionFailed(_))),
        "an unreachable host must surface as the typed ConnectionFailed, got {result:?}"
    );
    let ipc = TerminalError::from_session_spawn(result.unwrap_err());
    assert!(
        matches!(ipc, TerminalError::ConnectionFailed(_)),
        "unreachable must map to the ConnectionFailed IPC variant"
    );
    assert!(
        manager.sessions.lock().await.is_empty(),
        "a failed test must not register a session"
    );
}

/// A hung test connect is abortable via `cancel_connecting` (the same #952
/// token map a real connect uses), so a test can never hang un-cancellably —
/// and the aborted probe leaves no session.
#[tokio::test]
async fn test_connection_is_cancellable_when_the_connect_hangs() {
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "blocking",
        "Blocking",
        "mock",
        Box::new(|| Box::new(BlockingConnect)),
    );
    let manager = Arc::new(SessionManager::new(registry, Arc::new(NullAgent)));

    let spawned = manager.clone();
    let join = tokio::spawn(async move {
        spawned
            .test_connection("blocking", serde_json::json!({}), None, Some("test-c:0"))
            .await
    });

    // Poll until the probe registers its token, then fire the cancel.
    let mut cancelled = false;
    for _ in 0..200 {
        if manager.cancel_connecting("test-c:0") {
            cancelled = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(cancelled, "the connecting test probe should be cancellable");

    let result = join.await.expect("join");
    assert!(
        result.is_err(),
        "a cancelled test connect must return an error"
    );
    assert!(
        manager.sessions.lock().await.is_empty(),
        "a cancelled test must not register a session"
    );
    // The RAII guard cleared the entry, so a second cancel finds nothing.
    assert!(!manager.cancel_connecting("test-c:0"));
}

/// Tab close vs. session ownership (#3401).
mod close_ownership;

// ── tab close cancels the connect's OTP prompt (#3437) ─────────────────

mod ki_prompt_owner {
    use super::*;
    use crate::session::ssh_keyboard_interactive::{
        SshKeyboardInteractiveEventSink, SshKeyboardInteractivePromptClosedEvent,
        SshKeyboardInteractivePromptEvent, SshKeyboardInteractivePrompter,
    };
    use termihub_core::backends::ssh::keyboard_interactive::{
        KbdInteractiveAnswer, KbdInteractivePrompt, KbdInteractiveRequest,
        KeyboardInteractivePrompter,
    };

    #[derive(Default)]
    struct RecordingSink {
        prompts: std::sync::Mutex<Vec<SshKeyboardInteractivePromptEvent>>,
        closed: std::sync::Mutex<Vec<String>>,
    }

    impl SshKeyboardInteractiveEventSink for RecordingSink {
        fn emit_prompt(&self, event: &SshKeyboardInteractivePromptEvent) {
            self.prompts.lock().unwrap().push(event.clone());
        }
        fn emit_closed(&self, event: &SshKeyboardInteractivePromptClosedEvent) {
            self.closed.lock().unwrap().push(event.prompt_id.clone());
        }
    }

    /// An SSH-like connect whose auth waits (up to the 300 s prompt timeout)
    /// on a keyboard-interactive answer. It deliberately ignores the cancel
    /// token, so only cancelling the owned prompt can end it early.
    struct PromptingConnect {
        prompter: Arc<SshKeyboardInteractivePrompter>,
    }

    #[async_trait::async_trait]
    impl ConnectionType for PromptingConnect {
        fn type_id(&self) -> &str {
            "prompting"
        }
        fn display_name(&self) -> &str {
            "Prompting"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: vec![] }
        }
        fn capabilities(&self) -> Capabilities {
            BlockingConnect.capabilities()
        }
        async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
            let request = KbdInteractiveRequest {
                host: "bastion".to_string(),
                port: 22,
                username: "alice".to_string(),
                name: String::new(),
                instructions: String::new(),
                prompts: vec![KbdInteractivePrompt {
                    prompt: "Verification code: ".to_string(),
                    echo: false,
                }],
                round: 1,
                via: None,
            };
            match tokio::time::timeout(Duration::from_secs(300), self.prompter.prompt(&request))
                .await
            {
                Ok(KbdInteractiveAnswer::Responses(_)) => Ok(()),
                Ok(KbdInteractiveAnswer::Cancelled) => Err(SessionError::AuthCancelled),
                Err(_) => Err(SessionError::SpawnFailed("prompt timed out".to_string())),
            }
        }
        async fn connect_cancellable(
            &mut self,
            settings: serde_json::Value,
            _cancel: Option<CancellationToken>,
        ) -> Result<(), SessionError> {
            self.connect(settings).await
        }
        async fn disconnect(&mut self) -> Result<(), SessionError> {
            Ok(())
        }
        fn is_connected(&self) -> bool {
            true
        }
        fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
            Ok(())
        }
        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
            Ok(())
        }
        fn subscribe_output(&self) -> OutputReceiver {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }
        fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
            None
        }
        fn file_browser(&self) -> Option<&dyn FileBrowser> {
            None
        }
    }

    /// Closing a tab whose direct SSH connect waits on an OTP prompt (the
    /// `cancel_connecting` command: token + owned-prompt cancel) cancels that
    /// prompt, closes its dialog and returns the connect as cancelled at once —
    /// not after the 300 s prompt timeout. Another tab's prompt is untouched.
    #[tokio::test(start_paused = true)]
    async fn tab_close_cancels_only_its_own_prompt_and_aborts_the_connect() {
        let sink = Arc::new(RecordingSink::default());
        let prompter = Arc::new(SshKeyboardInteractivePrompter::new(sink.clone()));
        let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
        let factory_prompter = prompter.clone();
        registry.register(
            "prompting",
            "Prompting",
            "mock",
            Box::new(move || {
                Box::new(PromptingConnect {
                    prompter: factory_prompter.clone(),
                })
            }),
        );
        let manager = Arc::new(SessionManager::new(registry, Arc::new(NullAgent)));

        let connect = |connect_id: &'static str| {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .create_connection(
                        "prompting",
                        serde_json::json!({}),
                        None,
                        Some(connect_id),
                        false,
                        false,
                        MockEventEmitter::new(),
                    )
                    .await
            })
        };
        let closing = connect("tab-a:0");
        let other = connect("tab-b:0");
        while sink.prompts.lock().unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
        let owner_of = |owner: &str| {
            sink.prompts
                .lock()
                .unwrap()
                .iter()
                .find(|p| p.owner.as_deref() == Some(owner))
                .map(|p| p.prompt_id.clone())
                .expect("prompt carries its owning connect id")
        };
        let closing_prompt = owner_of("tab-a:0");
        let other_prompt = owner_of("tab-b:0");

        // What the `cancel_connecting` command does on tab close.
        let started = tokio::time::Instant::now();
        assert!(manager.cancel_connecting("tab-a:0"));
        assert_eq!(prompter.cancel_owned_by("tab-a:0"), 1);

        let result = closing.await.expect("join");
        assert!(
            matches!(result, Err(TerminalError::Cancelled)),
            "the connect ends as a user cancel, got {result:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "cancelled promptly, not after the prompt timeout"
        );
        assert_eq!(*sink.closed.lock().unwrap(), vec![closing_prompt]);

        // The other tab's prompt is still waiting — and still answerable.
        assert!(!other.is_finished());
        assert!(prompter.resolve(&other_prompt, Some(vec!["123456".into()])));
        let session = other.await.expect("join").expect("other tab connects");
        manager.close_session(&session).await.ok();
    }
}
