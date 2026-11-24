//! Live output and scrollback snapshots share one stream position (#5990).
//!
//! A persistent session re-created after an agent disconnect gets the daemon's
//! buffer as live output first. Every emitted chunk says where it starts, and a
//! repaint where it ends, so a tab can join the two without a gap or an overlap.

use super::*;
use crate::session::output_capture::ScrollbackReplay;

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

/// The agent's `session.getBuffer` answer.
fn buffer_reply(bytes: &[u8]) -> Step {
    use base64::Engine;
    Step::Reply(serde_json::json!({
        "data": base64::engine::general_purpose::STANDARD.encode(bytes)
    }))
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
    agent.send_replay_start(b"$ ".to_vec()).unwrap();
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
async fn attached(
    buffer: &[u8],
) -> (
    Arc<SessionManager>,
    MockEventEmitter,
    crate::terminal::backend::OutputSender,
) {
    let spy = Arc::new(spy_agent().always("send_request", buffer_reply(buffer)));
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
        agent.send_replay_start(buffer[..first].to_vec()).unwrap();
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

/// When the rest does not come in time the repaint is what is here, and the
/// rest follows as live output: the history is shown once either way.
#[tokio::test]
async fn a_re_forward_that_stalls_is_still_shown_once() {
    let buffer = heartbeats(600);
    for first in [6_000, 8_192] {
        let (manager, emitter, agent) = attached(&buffer).await;
        agent.send_replay_start(buffer[..first].to_vec()).unwrap();
        chunks_until(&emitter, "sess-1", first).await;
        let repaint = manager.get_remote_session_buffer("sess-1").await.unwrap();
        agent.send(buffer[first..].to_vec()).unwrap();
        let chunks = chunks_until(&emitter, "sess-1", buffer.len()).await;
        let all = shown(&repaint, &chunks);
        assert_eq!(all.len(), buffer.len(), "first={first}");
        assert!(all == buffer);
    }
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
        .send_replay_start(pieces.next().unwrap().to_vec())
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
        agent.send_replay_start(replay.to_vec()).unwrap();
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
    agent.send_replay_start(b"$ ls\r\n$ ".to_vec()).unwrap();
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

/// The late cleanup of an ended stream leaves the capture of the stream that
/// started after it under the same id.
#[tokio::test]
async fn the_cleanup_of_an_ended_stream_leaves_the_next_one() {
    let emitter = MockEventEmitter::new();
    let buffers = new_output_buffers();
    let (old, new) = (new_capture(), new_capture());
    for (current, kept) in [(&new, true), (&old, false)] {
        let sessions = sessions_with_mock("sess-1").await;
        buffers
            .lock()
            .unwrap()
            .insert("sess-1".to_string(), current.clone());
        SessionManager::emit_and_cleanup(
            "sess-1",
            Vec::new(),
            &emitter,
            &sessions,
            &old,
            &buffers,
            &new_session_loggers(),
            &new_session_tab_ids(),
        )
        .await;
        assert_eq!(buffers.lock().unwrap().contains_key("sess-1"), kept);
    }
}
