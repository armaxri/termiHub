//! Two attaches of one persistent session at the same time (#6033).
//!
//! Each used to see the session gone and re-create it: the last to register
//! the output route got the output, the last to insert its entry owned the
//! session, and when those were not the same attach the tab showed nothing.

use super::*;
use crate::test_support::agent_rpc::Gate;

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

/// Poll until `done` holds.
async fn until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..300 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never: {what}");
}

/// A spy whose first call to `held` waits for `gate`, then answers `then`.
fn held_at(held: &'static str, gate: &Gate, then: Step) -> Arc<FakeAgent> {
    Arc::new(
        spy_agent()
            .always("send_request", Step::Reply(serde_json::json!({})))
            .on(held, Step::Hang(gate.clone(), Box::new(then))),
    )
}

/// Attach `tab_id` in the background.
fn attach(
    manager: &Arc<SessionManager>,
    emitter: &MockEventEmitter,
    tab_id: &'static str,
) -> tokio::task::JoinHandle<Result<PersistentAttach, TerminalError>> {
    let manager = manager.clone();
    let emitter = emitter.clone();
    tokio::spawn(async move {
        manager
            .attach_persistent_tab("conn-1", tab_id, emitter)
            .await
    })
}

/// Start attach `tab-1`, hold it at `held`, start attach `tab-2`, then let both go.
async fn two_attaches(
    held: &'static str,
    then: Step,
    peer_holds: bool,
) -> (
    Arc<SessionManager>,
    MockEventEmitter,
    Arc<FakeAgent>,
    [Result<PersistentAttach, TerminalError>; 2],
) {
    let gate = Gate::new();
    let _open = gate.open_on_drop();
    let spy = held_at(held, &gate, then);
    spy.held_by_peer.store(peer_holds, Ordering::SeqCst);
    let manager = Arc::new(SessionManager::new(
        ConnectionTypeRegistry::new(),
        spy.clone(),
    ));
    let emitter = MockEventEmitter::new();
    persistent_session(&manager).await;
    let first = attach(&manager, &emitter, "tab-1");
    until("the first attach is held", || spy.calls_to(held).len() == 1).await;
    let second = attach(&manager, &emitter, "tab-2");
    tokio::time::sleep(Duration::from_millis(100)).await;
    gate.open();
    let results = [first.await.unwrap(), second.await.unwrap()];
    (manager, emitter, spy, results)
}

/// Held between the liveness check and the insert, before the output route is
/// registered or after it: one re-creation, whose entry gets the output and ends
/// with the stream.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_attaches_at_once_end_in_one_stream_its_entry_owns() {
    for held in ["register_session_output", "attach_session"] {
        let (manager, emitter, spy, [first, second]) = two_attaches(held, Step::Ok, false).await;
        let (first, second) = (first.expect("first"), second.expect("second"));
        assert_eq!(first.session_id, "sess-1");
        assert_eq!(second.session_id, "sess-1");
        assert_eq!(spy.calls_to("attach_session").len(), 1, "held at {held}");
        assert_eq!(
            spy.session_outputs.lock().unwrap().len(),
            1,
            "held at {held}"
        );
        assert_eq!(second.count, 2, "held at {held}");

        let route = spy.session_outputs.lock().unwrap()[0].clone();
        route.send(b"hello".to_vec()).unwrap();
        until("the output arrives", || {
            emitter
                .outputs
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.session_id == "sess-1" && e.data == b"hello")
        })
        .await;

        // The agent's end of the stream: the session ends.
        drop(route);
        spy.session_outputs.lock().unwrap().clear();
        until("the session ends", || {
            emitter
                .exits
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.session_id == "sess-1")
        })
        .await;
        assert!(!manager.sessions.lock().await.contains_key("sess-1"));
    }
}

/// The first re-creation fails: the second attach tries again, and succeeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_re_creation_lets_the_attach_waiting_for_it_try() {
    let (manager, _emitter, spy, [first, second]) =
        two_attaches("attach_session", Step::fail("Agent connection lost"), false).await;
    assert!(first.is_err());
    assert_eq!(second.expect("second").session_id, "sess-1");
    assert_eq!(spy.calls_to("attach_session").len(), 2);
    assert!(manager.sessions.lock().await.contains_key("sess-1"));
}

/// Another desktop holds the session: every attach of it says so, the one that
/// waited for the re-creation and a later one too (#6110), until a Reclaim.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_attach_of_a_held_session_says_it_is_held() {
    let (manager, emitter, spy, [first, second]) =
        two_attaches("register_session_output", Step::Ok, true).await;
    assert!(first.expect("first").held_by_peer);
    assert!(second.expect("second").held_by_peer);
    let later = manager
        .attach_persistent_tab("conn-1", "tab-3", emitter.clone())
        .await
        .expect("later");
    assert!(later.held_by_peer);

    manager.reclaim_session("tab-1").await.expect("reclaim");
    assert_eq!(spy.calls_to("reclaim_session").len(), 1);
    let after = manager
        .attach_persistent_tab("conn-1", "tab-4", emitter.clone())
        .await
        .expect("after the reclaim");
    assert!(!after.held_by_peer);
}
