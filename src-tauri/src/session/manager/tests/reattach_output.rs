//! Live output and scrollback snapshots share one stream position (#5990).
//!
//! A persistent session re-created after an agent disconnect gets the daemon's
//! buffer as live output first. Every emitted chunk says where it starts, and a
//! repaint where it ends, so a tab can join the two without a gap or an overlap.

use super::*;

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
    agent.send(b"$ ".to_vec()).unwrap();
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

/// A repaint read before the re-forward arrived holds nothing: the re-forward
/// is then shown as the live output it is, not skipped.
#[tokio::test]
async fn a_repaint_before_the_re_forward_holds_nothing() {
    let spy = Arc::new(spy_agent().always("send_request", buffer_reply(b"$ ")));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), spy.clone());
    let emitter = MockEventEmitter::new();
    persistent_session(&manager).await;
    manager
        .attach_persistent_tab("conn-1", "tab-1", emitter.clone())
        .await
        .expect("attach");
    let repaint = manager.get_remote_session_buffer("sess-1").await.unwrap();
    assert_eq!((repaint.data.len(), repaint.end_offset), (0, 0));

    let agent = spy.session_outputs.lock().unwrap().last().cloned().unwrap();
    agent.send(b"$ ".to_vec()).unwrap();
    let chunks = chunks_until(&emitter, "sess-1", 2).await;
    assert_eq!(chunks[0].0, 0);
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

/// A Reclaim makes the daemon send its whole buffer again on the same stream:
/// a later repaint shows it once, and the positions go on.
#[tokio::test]
async fn a_reclaim_does_not_leave_the_buffer_in_the_repaint_twice() {
    let spy = Arc::new(spy_agent().always("reclaim_session", Step::Ok));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), spy.clone());
    let emitter = MockEventEmitter::new();
    let reattach = manager
        .reattach_agent_session("tab-1", "agent-1", "remote-1", emitter.clone())
        .await
        .expect("attach");
    let sid = reattach.session_id;
    let agent = spy.session_outputs.lock().unwrap().last().cloned().unwrap();
    agent.send(b"$ ls\r\n".to_vec()).unwrap();
    chunks_until(&emitter, &sid, 6).await;

    manager.reclaim_session("tab-1").await.expect("reclaim");
    agent.send(b"$ ls\r\n$ ".to_vec()).unwrap();
    let chunks = chunks_until(&emitter, &sid, 14).await;
    contiguous(&chunks);

    let repaint = manager.replay_scrollback(&sid).await;
    assert_eq!(repaint.data, b"$ ls\r\n$ ");
    assert_eq!(repaint.end_offset, 14);
}
