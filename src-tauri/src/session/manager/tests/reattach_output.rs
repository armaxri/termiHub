//! Live output and scrollback snapshots share one stream position (#5990).
//!
//! A persistent session re-created after an agent disconnect gets the daemon's
//! buffer as live output first. Every emitted chunk says where it starts, and a
//! repaint where it ends, so a tab can join the two without a gap or an overlap.

use super::*;
use crate::session::output_capture::ScrollbackReplay;
use crate::test_support::agent_rpc::Gate;

/// Poll until `emitter` got `len` bytes for `session_id`; returns the chunks.
async fn chunks_until(
    emitter: &MockEventEmitter,
    session_id: &str,
    len: usize,
) -> Vec<(u64, Vec<u8>)> {
    for _ in 0..300 {
        let chunks: Vec<(u64, Vec<u8>)> = emitter
            .outputs
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.session_id == session_id)
            .map(|e| (e.offset, e.data.clone()))
            .collect();
        if chunks.iter().map(|(_, d)| d.len()).sum::<usize>() >= len {
            return chunks;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{len} bytes were never emitted");
}

/// Assert that the chunks follow each other without a gap; returns their bytes.
fn contiguous(chunks: &[(u64, Vec<u8>)]) -> Vec<u8> {
    let mut all = Vec::new();
    for (offset, data) in chunks {
        assert_eq!(*offset, all.len() as u64, "a gap or an overlap: {chunks:?}");
        all.extend_from_slice(data);
    }
    all
}

async fn persistent_session(manager: &SessionManager) {
    manager.persistent_sessions.lock().await.insert(
        "conn-1".to_string(),
        PersistentRecord {
            connection_id: "conn-1".to_string(),
            session_id: "sess-1".to_string(),
            attached_tabs: HashSet::new(),
            remote_session_id: Some("remote-1".to_string()),
            agent_id: Some("agent-1".to_string()),
        },
    );
}

/// The replay id the fake agent uses.
const REPLAY: u64 = 7;

/// The `session.getBuffer` answer of an agent that does not say where its
/// buffer ends (before 0.45.0).
fn old_buffer_reply(bytes: &[u8]) -> Step {
    use base64::Engine;
    Step::Reply(serde_json::json!({
        "session_id": "remote-1",
        "data": base64::engine::general_purpose::STANDARD.encode(bytes)
    }))
}

/// The answer of a current agent: `bytes` end `end` bytes into the replay.
fn buffer_reply_at(bytes: &[u8], end: usize) -> Step {
    let Step::Reply(mut reply) = old_buffer_reply(bytes) else {
        unreachable!()
    };
    reply["replay_id"] = REPLAY.into();
    reply["end_position"] = end.into();
    Step::Reply(reply)
}

/// [`buffer_reply_at`] for a buffer that is all that was sent.
fn buffer_reply(bytes: &[u8]) -> Step {
    buffer_reply_at(bytes, bytes.len())
}

/// The answer to input typed right after a re-attach is emitted, and starts
/// exactly where the repaint of the moment before ended.
#[tokio::test]
async fn output_after_a_reattach_starts_where_the_repaint_ended() {
    let spy = Arc::new(spy_agent().always("send_request", buffer_reply(b"$ ")));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), spy.clone());
    let emitter = MockEventEmitter::new();
    persistent_session(&manager).await;
    manager
        .attach_persistent_tab("conn-1", "tab-1", emitter.clone())
        .await
        .expect("attach");
    let agent = spy.session_outputs.lock().unwrap().last().cloned().unwrap();

    // The daemon re-forwards its buffer as live output.
    agent.send_replay_start(REPLAY, b"$ ".to_vec()).unwrap();
    chunks_until(&emitter, "sess-1", 2).await;
    let repaint = manager.get_remote_session_buffer("sess-1").await.unwrap();
    assert_eq!(repaint.data, b"$ ");
    assert_eq!(repaint.end_offset, 2);

    // The answer comes before any tab subscribed.
    agent.send(b"echo hi\r\nhi\r\n$ ".to_vec()).unwrap();
    let chunks = chunks_until(&emitter, "sess-1", 17).await;
    assert_eq!(contiguous(&chunks), b"$ echo hi\r\nhi\r\n$ ");
    assert!(chunks[1..]
        .iter()
        .all(|(offset, _)| *offset >= repaint.end_offset));
}

/// The agent's buffer is only an addition: without it the repaint is what this
/// desktop captured.
#[tokio::test]
async fn a_failed_buffer_read_falls_back_to_the_capture() {
    let spy = Arc::new(spy_agent().always("send_request", Step::fail("busy")));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), spy.clone());
    let emitter = MockEventEmitter::new();
    persistent_session(&manager).await;
    manager
        .attach_persistent_tab("conn-1", "tab-1", emitter.clone())
        .await
        .expect("attach");
    assert!(
        manager.get_remote_session_buffer("sess-1").await.is_err(),
        "nothing captured and nothing read"
    );
    let agent = spy.session_outputs.lock().unwrap().last().cloned().unwrap();
    agent.send(b"$ ".to_vec()).unwrap();
    chunks_until(&emitter, "sess-1", 2).await;
    let repaint = manager.get_remote_session_buffer("sess-1").await.unwrap();
    assert_eq!(repaint.data, b"$ ");
}

/// Output of `lines` lines, all alike but one in the middle: text alone cannot
/// place a part of it.
fn heartbeats(lines: usize) -> Vec<u8> {
    let mut all = b"heartbeat OK\r\n".repeat(lines);
    all.extend_from_slice(b"ERROR disk full\r\n");
    all.extend(b"heartbeat OK\r\n".repeat(lines));
    all
}

/// An attached session whose agent answers `session.getBuffer` with `buffer`.
async fn attached(buffer: &[u8]) -> Attached {
    attached_to(buffer_reply(buffer)).await
}

type Attached = (
    Arc<SessionManager>,
    MockEventEmitter,
    crate::terminal::backend::OutputSender,
);

/// An attached session whose agent answers `session.getBuffer` with `reply`.
async fn attached_to(reply: Step) -> Attached {
    attached_by(&Arc::new(spy_agent().always("send_request", reply))).await
}

/// A session attached through `spy`.
async fn attached_by(spy: &Arc<FakeAgent>) -> Attached {
    let manager = Arc::new(SessionManager::new(
        ConnectionTypeRegistry::new(),
        spy.clone(),
    ));
    let emitter = MockEventEmitter::new();
    persistent_session(&manager).await;
    manager
        .attach_persistent_tab("conn-1", "tab-1", emitter.clone())
        .await
        .expect("attach");
    let agent = spy.session_outputs.lock().unwrap().last().cloned().unwrap();
    (manager, emitter, agent)
}

/// What a tab shows: the repaint, then the live output after its end.
fn shown(repaint: &ScrollbackReplay, chunks: &[(u64, Vec<u8>)]) -> Vec<u8> {
    let live = contiguous(chunks);
    let mut all = repaint.data.clone();
    all.extend_from_slice(&live[repaint.end_offset as usize..]);
    all
}

/// The buffer's answer overtakes the re-forward, which is in pieces: the
/// repaint waits for the rest, so it ends where the buffer does.
#[tokio::test]
async fn a_repaint_waits_for_a_re_forward_that_is_still_arriving() {
    let buffer = heartbeats(600);
    for first in [1, 6_000, 8_192] {
        let (manager, emitter, agent) = attached(&buffer).await;
        agent
            .send_replay_start(REPLAY, buffer[..first].to_vec())
            .unwrap();
        chunks_until(&emitter, "sess-1", first).await;
        let reading = tokio::spawn({
            let manager = manager.clone();
            async move { manager.get_remote_session_buffer("sess-1").await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!reading.is_finished(), "the repaint did not wait");
        agent.send(buffer[first..].to_vec()).unwrap();

        let repaint = reading.await.unwrap().unwrap();
        assert!(repaint.data == buffer, "first={first}");
        assert_eq!(repaint.end_offset, buffer.len() as u64);
    }
}

/// The agent came back as another worker, whose replay ids have no order with
/// the old one's (#6007): its answer overtakes its replay, and waits for it.
#[tokio::test]
async fn a_repaint_waits_for_the_replay_of_a_new_worker() {
    for old_worker in [REPLAY - 1, REPLAY + 1] {
        let (manager, emitter, agent) = attached(b"one two ").await;
        agent
            .send_replay_start(old_worker, b"one ".to_vec())
            .unwrap();
        chunks_until(&emitter, "sess-1", 4).await;
        let reading = tokio::spawn({
            let manager = manager.clone();
            async move { manager.get_remote_session_buffer("sess-1").await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        agent
            .send_replay_start(REPLAY, b"one two ".to_vec())
            .unwrap();

        let repaint = reading.await.unwrap().unwrap();
        assert_eq!(repaint.data, b"one two ", "old worker's id {old_worker}");
        assert_eq!(repaint.end_offset, 12);
    }
}

/// An answer about a replay that another one overtook is known to be too old:
/// the repaint takes the capture at once instead of waiting for its time limit.
#[tokio::test]
async fn an_answer_that_a_later_replay_overtook_is_not_waited_for() {
    let gate = Gate::new();
    let _release = gate.open_on_drop();
    let reply = Step::Hang(gate.clone(), Box::new(buffer_reply(b"one ")));
    let spy = Arc::new(spy_agent().always("send_request", reply));
    let (manager, emitter, agent) = attached_by(&spy).await;
    agent.send_replay_start(REPLAY, b"one ".to_vec()).unwrap();
    chunks_until(&emitter, "sess-1", 4).await;
    let reading = tokio::spawn({
        let manager = manager.clone();
        async move { manager.get_remote_session_buffer("sess-1").await }
    });
    spy.wait_for_request("session.getBuffer").await;
    agent
        .send_replay_start(REPLAY + 1, b"one two ".to_vec())
        .unwrap();
    chunks_until(&emitter, "sess-1", 12).await;
    gate.open();

    let repaint = tokio::time::timeout(Duration::from_secs(1), reading)
        .await
        .expect("the repaint waited")
        .unwrap()
        .unwrap();
    assert_eq!(repaint.data, b"one two ");
    assert_eq!(repaint.end_offset, 12);
}

/// When the rest does not come in time the repaint is what is here, and the
/// rest follows as live output: the history is shown once either way.
#[tokio::test]
async fn a_re_forward_that_stalls_is_still_shown_once() {
    let buffer = heartbeats(600);
    for first in [6_000, 8_192] {
        let (manager, emitter, agent) = attached(&buffer).await;
        agent
            .send_replay_start(REPLAY, buffer[..first].to_vec())
            .unwrap();
        chunks_until(&emitter, "sess-1", first).await;
        let repaint = manager.get_remote_session_buffer("sess-1").await.unwrap();
        agent.send(buffer[first..].to_vec()).unwrap();
        let chunks = chunks_until(&emitter, "sess-1", buffer.len()).await;
        let all = shown(&repaint, &chunks);
        assert_eq!(all.len(), buffer.len(), "first={first}");
        assert!(all == buffer);
    }
}

/// A full agent ring larger than the capture: it has dropped the start of what
/// it sent again, so its length says nothing about where it ends. Every line is
/// alike, so only the position can tell where the two meet, and the capture is
/// 14 bytes behind when the buffer is read.
#[tokio::test]
async fn a_full_agent_buffer_is_joined_by_position() {
    let line = b"heartbeat OK\r\n";
    let capacity = termihub_core::buffer::DEFAULT_BUFFER_CAPACITY;
    // What the agent sent since the attach: 3 MiB, one odd line in the middle.
    let mut sent = line.repeat(3 * capacity / line.len() / 2);
    sent.extend_from_slice(b"ERROR disk full\r\n");
    sent.extend(line.repeat(3 * capacity / line.len() / 2));
    // Its ring keeps the last 2 MiB of it.
    let ring = 2 * capacity;
    let buffer = &sent[sent.len() - ring..];
    let (manager, emitter, agent) = attached_to(buffer_reply_at(buffer, sent.len())).await;
    let here = sent.len() - 14;
    agent
        .send_replay_start(REPLAY, sent[..here].to_vec())
        .unwrap();
    chunks_until(&emitter, "sess-1", here).await;
    let reading = tokio::spawn({
        let manager = manager.clone();
        async move { manager.get_remote_session_buffer("sess-1").await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!reading.is_finished(), "14 bytes are missing");
    agent.send(sent[here..].to_vec()).unwrap();

    let repaint = reading.await.unwrap().unwrap();
    assert_eq!(repaint.end_offset, sent.len() as u64);
    assert_eq!(repaint.data.len(), ring, "the agent's whole buffer, once");
    assert!(repaint.data == buffer);
}

/// An agent from before 0.45.0 says neither where a replay starts nor where its
/// buffer ends: no wait and no extension, and nothing lost or shown twice.
#[tokio::test]
async fn an_older_agent_gets_the_capture_only_repaint() {
    let buffer = heartbeats(600);
    let (manager, emitter, agent) = attached_to(old_buffer_reply(&buffer)).await;
    agent.send(buffer[..6_000].to_vec()).unwrap();
    chunks_until(&emitter, "sess-1", 6_000).await;
    let started = std::time::Instant::now();
    let repaint = manager.get_remote_session_buffer("sess-1").await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(1), "it waited");
    assert_eq!(repaint.data, buffer[..6_000]);
    agent.send(buffer[6_000..].to_vec()).unwrap();
    let chunks = chunks_until(&emitter, "sess-1", buffer.len()).await;
    assert!(shown(&repaint, &chunks) == buffer);
}

/// Nothing is here yet, but the agent has it: the tab is told that it comes.
/// An agent without a buffer for the session has nothing to send.
#[tokio::test]
async fn an_empty_repaint_says_whether_the_history_is_coming() {
    for (reply, coming) in [
        (old_buffer_reply(b"$ "), true),
        (old_buffer_reply(b""), false),
    ] {
        let (manager, _emitter, _agent) = attached_to(reply).await;
        let repaint = manager.get_remote_session_buffer("sess-1").await.unwrap();
        assert!(repaint.data.is_empty());
        assert_eq!(repaint.coming, coming);
    }
}

/// The session ends while the repaint waits: that is an error, not an empty
/// history a tab would replace its own scrollback with.
#[tokio::test]
async fn a_session_that_ends_during_the_wait_is_an_error() {
    let (manager, emitter, agent) = attached(b"0123456789").await;
    agent.send_replay_start(REPLAY, b"01".to_vec()).unwrap();
    chunks_until(&emitter, "sess-1", 2).await;
    let reading = tokio::spawn({
        let manager = manager.clone();
        async move { manager.get_remote_session_buffer("sess-1").await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!reading.is_finished());
    manager.close_session("sess-1").await.expect("close");
    let result = reading.await.unwrap();
    assert!(
        matches!(result, Err(TerminalError::SessionNotFound(_))),
        "{result:?}"
    );
}

/// A buffer larger than the capture is shown in full, once.
#[tokio::test]
async fn a_buffer_larger_than_the_capture_is_shown_in_full() {
    let buffer: Vec<u8> = (0..300_000u32)
        .flat_map(|i| format!("{i:07}\r\n").into_bytes())
        .collect();
    assert!(buffer.len() > 2 * termihub_core::buffer::DEFAULT_BUFFER_CAPACITY);
    let (manager, emitter, agent) = attached(&buffer).await;
    let mut pieces = buffer.chunks(65_536);
    agent
        .send_replay_start(REPLAY, pieces.next().unwrap().to_vec())
        .unwrap();
    for piece in pieces {
        agent.send(piece.to_vec()).unwrap();
    }
    agent.send(b"live".to_vec()).unwrap();
    let chunks = chunks_until(&emitter, "sess-1", buffer.len() + 4).await;

    let repaint = manager.get_remote_session_buffer("sess-1").await.unwrap();
    let mut expected = buffer.clone();
    expected.extend_from_slice(b"live");
    assert_eq!(repaint.data.len(), expected.len());
    assert!(repaint.data == expected);
    assert!(shown(&repaint, &chunks) == expected);
}

/// Every attach makes the agent send the whole buffer again on the stream the
/// tab already has. Whoever attached, a later repaint shows the history once.
#[tokio::test]
async fn a_repaint_shows_the_history_once_whoever_attached_again() {
    // What the stream had before, what the agent sends again, what follows.
    type Case = (&'static str, &'static [u8], &'static [u8], &'static [u8]);
    let cases: [Case; 4] = [
        // Reclaim and Take over: the desktop was evicted meanwhile.
        ("take over", b"$ ls\r\n", b"$ ls\r\nout\r\n$ ", b"pwd"),
        // A fresh session prints its prompt before the attach of its start.
        ("fresh start", b"$ ", b"$ ", b""),
        // A transport reconnect attaches from a new agent worker.
        (
            "transport reconnect",
            b"$ top\r\n",
            b"$ top\r\nq\r\n",
            b"$ ",
        ),
        ("nothing new", b"$ ", b"$ ", b"x"),
    ];
    for (name, before, replay, after) in cases {
        let history = [replay, after].concat();
        let (manager, emitter, agent) = attached(&history).await;
        agent.send(before.to_vec()).unwrap();
        chunks_until(&emitter, "sess-1", before.len()).await;
        agent.send_replay_start(REPLAY, replay.to_vec()).unwrap();
        if !after.is_empty() {
            agent.send(after.to_vec()).unwrap();
        }
        let total = before.len() + history.len();
        contiguous(&chunks_until(&emitter, "sess-1", total).await);

        for repaint in [
            manager.get_remote_session_buffer("sess-1").await.unwrap(),
            manager.replay_scrollback("sess-1").await,
        ] {
            assert_eq!(repaint.data, history, "{name}");
            assert_eq!(repaint.end_offset, total as u64, "{name}");
        }
    }
}

/// The take-over command attaches past the session manager: the same stream
/// still knows that its history starts over.
#[tokio::test]
async fn an_attach_past_the_session_manager_restarts_the_history_too() {
    let spy = Arc::new(spy_agent().always("reclaim_session", Step::Ok));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), spy.clone());
    let emitter = MockEventEmitter::new();
    let sid = manager
        .reattach_agent_session("tab-1", "agent-1", "remote-1", emitter.clone())
        .await
        .expect("attach")
        .session_id;
    let agent = spy.session_outputs.lock().unwrap().last().cloned().unwrap();
    agent.send(b"$ ls\r\n".to_vec()).unwrap();
    chunks_until(&emitter, &sid, 6).await;

    // As `take_over_agent_session` does.
    crate::terminal::agent_manager::AgentRpcClient::reclaim_session(&*spy, "agent-1", "remote-1")
        .expect("take over");
    agent
        .send_replay_start(REPLAY, b"$ ls\r\n$ ".to_vec())
        .unwrap();
    chunks_until(&emitter, &sid, 14).await;
    assert_eq!(manager.replay_scrollback(&sid).await.data, b"$ ls\r\n$ ");
}

/// A session created again under its id starts a new stream, with a larger
/// epoch, and its repaint holds nothing of the old one.
#[tokio::test]
async fn a_new_stream_of_the_same_session_has_a_larger_epoch() {
    let spy = Arc::new(spy_agent().always("send_request", buffer_reply(b"")));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), spy.clone());
    let emitter = MockEventEmitter::new();
    persistent_session(&manager).await;
    let mut epochs = Vec::new();
    for text in [b"old".as_slice(), b"new"] {
        manager
            .attach_persistent_tab("conn-1", "tab-1", emitter.clone())
            .await
            .expect("attach");
        let agent = spy.session_outputs.lock().unwrap().last().cloned().unwrap();
        agent.send(text.to_vec()).unwrap();
        chunks_until(&emitter, "sess-1", 3 * (epochs.len() + 1)).await;
        let repaint = manager.replay_scrollback("sess-1").await;
        assert_eq!(repaint.data, text);
        assert_eq!(repaint.end_offset, 3);
        epochs.push(repaint.epoch);
        // The agent goes away: the desktop session ends, the record stays.
        manager.close_session("sess-1").await.expect("close");
    }
    assert!(epochs[1] > epochs[0], "{epochs:?}");
    let emitted: Vec<u64> = emitter
        .outputs
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.epoch)
        .collect();
    assert_eq!(emitted, epochs);
}

/// The end of a stream names it (#6032): a tab attached to a newer stream of
/// the same id can tell an exit event of the older one that is still on its way.
#[tokio::test]
async fn the_exit_event_says_which_stream_ended() {
    let spy = Arc::new(spy_agent().always("send_request", buffer_reply(b"")));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), spy.clone());
    let emitter = MockEventEmitter::new();
    persistent_session(&manager).await;
    let mut epochs = Vec::new();
    for round in 1..=2 {
        manager
            .attach_persistent_tab("conn-1", "tab-1", emitter.clone())
            .await
            .expect("attach");
        epochs.push(manager.replay_scrollback("sess-1").await.epoch);
        // The agent's end of the stream.
        spy.session_outputs.lock().unwrap().clear();
        for _ in 0..300 {
            if emitter.exits.lock().unwrap().len() == round {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    let ended: Vec<u64> = emitter
        .exits
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.epoch)
        .collect();
    assert_eq!(ended, epochs);
    assert!(epochs[1] > epochs[0], "{epochs:?}");
}

/// What one session id has in the manager: its entry, capture, logger and tab.
struct Registered {
    sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
    buffers: OutputBuffers,
    loggers: SessionLoggers,
    tabs: SessionTabIds,
    dir: tempfile::TempDir,
}

impl Registered {
    fn new() -> Self {
        Self {
            sessions: Arc::default(),
            buffers: new_output_buffers(),
            loggers: new_session_loggers(),
            tabs: new_session_tab_ids(),
            dir: tempfile::tempdir().expect("temp dir"),
        }
    }

    /// Start a stream of `sess-1` in `sessions`, as an attach does.
    fn start(&self, sessions: &mut HashMap<String, SessionEntry>) -> Arc<StdMutex<OutputCapture>> {
        let id = "sess-1".to_string();
        let entry = mock_entry(&id);
        let capture = entry.capture.clone();
        sessions.insert(id.clone(), entry);
        self.buffers
            .lock()
            .unwrap()
            .insert(id.clone(), capture.clone());
        let log = SessionLogConfig::new(self.dir.path().join("out.log"), false);
        let logger = SessionLogger::open(log, Box::new(|| "T".to_string())).expect("logger");
        self.loggers
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::new(StdMutex::new(logger)));
        self.tabs.lock().unwrap().insert(
            id,
            TabBinding {
                tab_id: "tab-1".to_string(),
                resilient: false,
                agent_id: None,
            },
        );
        capture
    }

    /// Whether the entry, the capture, the logger and the tab are there.
    async fn present(&self) -> [bool; 4] {
        [
            self.sessions.lock().await.contains_key("sess-1"),
            self.buffers.lock().unwrap().contains_key("sess-1"),
            self.loggers.lock().unwrap().contains_key("sess-1"),
            self.tabs.lock().unwrap().contains_key("sess-1"),
        ]
    }

    async fn cleanup<E: EventEmitter>(&self, emitter: &E, capture: &Arc<StdMutex<OutputCapture>>) {
        SessionManager::emit_and_cleanup(
            "sess-1",
            Vec::new(),
            emitter,
            &self.sessions,
            capture,
            &self.buffers,
            &self.loggers,
            &self.tabs,
        )
        .await;
    }
}

/// The cleanup of a stream comes when its session is attached again already
/// (#6004): the session goes on, so nothing of it is removed and no tab hears
/// that it ended.
#[tokio::test]
async fn a_late_cleanup_leaves_a_session_that_was_attached_again() {
    let emitter = MockEventEmitter::new();
    let registered = Arc::new(Registered::new());
    let mut sessions = registered.sessions.lock().await;
    let old = registered.start(&mut sessions);
    // The cleanup waits for the session map while the session is closed and
    // attached again.
    let late = tokio::spawn({
        let (registered, emitter) = (registered.clone(), emitter.clone());
        async move { registered.cleanup(&emitter, &old).await }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    sessions.remove("sess-1");
    let new = registered.start(&mut sessions);
    drop(sessions);
    tokio::time::timeout(Duration::from_secs(10), late)
        .await
        .expect("the cleanup ends")
        .expect("cleanup");

    assert_eq!(registered.present().await, [true; 4]);
    assert!(Arc::ptr_eq(
        &capture_of(&registered.sessions, "sess-1").await,
        &new
    ));
    assert!(emitter.exits.lock().unwrap().is_empty());
    assert!(emitter.session_drops.lock().unwrap().is_empty());

    // Its own cleanup removes all of it.
    registered.cleanup(&emitter, &new).await;
    assert_eq!(registered.present().await, [false; 4]);
    assert_eq!(emitter.exits.lock().unwrap().len(), 1);
}

/// Attaches `registered` again the moment the session's end is announced.
#[derive(Clone)]
struct AttachAtExit(Arc<Registered>);

impl EventEmitter for AttachAtExit {
    fn emit_output(&self, _event: &TerminalOutputEvent) -> bool {
        true
    }
    fn emit_exit(&self, _event: &TerminalExitEvent) {
        let mut sessions = self
            .0
            .sessions
            .try_lock()
            .expect("no lock at the exit event");
        assert!(
            !sessions.contains_key("sess-1"),
            "an attach must not find the ended session"
        );
        self.0.start(&mut sessions);
    }
}

#[tokio::test]
async fn a_cleanup_leaves_a_session_attached_again_at_its_exit_event() {
    let registered = Arc::new(Registered::new());
    let old = registered.start(&mut *registered.sessions.lock().await);

    registered
        .cleanup(&AttachAtExit(registered.clone()), &old)
        .await;

    assert_eq!(registered.present().await, [true; 4]);
}

/// A session closed on purpose has no entry any more when its reader ends.
#[tokio::test]
async fn the_cleanup_of_a_closed_session_removes_the_rest_and_ends_its_tab() {
    let emitter = MockEventEmitter::new();
    let registered = Registered::new();
    let capture = registered.start(&mut *registered.sessions.lock().await);
    registered.sessions.lock().await.remove("sess-1");

    registered.cleanup(&emitter, &capture).await;

    assert_eq!(registered.present().await, [false; 4]);
    assert_eq!(emitter.exits.lock().unwrap().len(), 1);
}
