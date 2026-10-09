//! Frontend flow control (PERF2-002, #4307): the frontend's pause/resume
//! reaches the session's output reader, which then stops reading the output
//! channel so the PTY reader is backpressured.

use super::*;

use std::time::Duration;

/// Poll `cond` until it holds or a generous deadline passes.
async fn eventually(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    cond()
}

fn emitted(emitter: &MockEventEmitter) -> Vec<u8> {
    emitter
        .outputs
        .lock()
        .unwrap()
        .iter()
        .flat_map(|e| e.data.iter().copied())
        .collect()
}

#[tokio::test]
async fn set_output_flow_pauses_and_resumes_the_session_reader() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager
        .insert_test_session("s", Box::new(MockConnection::default()))
        .await;
    let gate = manager
        .output_flow_gate("s")
        .await
        .expect("a live session has a flow gate");

    let emitter = MockEventEmitter::new();
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);
    let reader_emitter = emitter.clone();
    let sessions = manager.sessions.clone();
    let handle = tokio::spawn(async move {
        SessionManager::run_output_reader(
            "s".to_string(),
            rx,
            reader_emitter,
            sessions,
            false,
            new_capture(),
            new_output_buffers(),
            new_session_loggers(),
            new_session_tab_ids(),
            CancellationToken::new(),
            Some(gate),
        )
        .await;
    });

    manager.set_output_flow("s", true).await;
    tx.send(b"held".to_vec()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        emitted(&emitter).is_empty(),
        "paused session still emitted output"
    );

    manager.set_output_flow("s", false).await;
    assert!(
        eventually(|| emitted(&emitter) == b"held").await,
        "resumed session did not emit the held output"
    );

    drop(tx);
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("reader did not finish")
        .expect("reader panicked");
}

#[tokio::test]
async fn set_output_flow_on_unknown_session_is_a_no_op() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager.set_output_flow("missing", true).await;
    assert!(manager.output_flow_gate("missing").await.is_none());
}
