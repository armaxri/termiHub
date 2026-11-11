//! Self-tests for the scriptable [`FakeAgent`](super::FakeAgent).

use super::*;

#[test]
fn scripted_steps_answer_in_order_then_fall_back_to_always() {
    let agent = FakeAgent::offline()
        .on("close_session", Step::fail("first close fails"))
        .always("close_session", Step::Ok);
    assert!(agent.close_session("a", "r1").is_err());
    assert!(agent.close_session("a", "r2").is_ok());
    assert!(agent.close_session("a", "r3").is_ok());
    assert_eq!(
        agent.calls_to("close_session"),
        vec![
            vec!["a".to_string(), "r1".to_string()],
            vec!["a".to_string(), "r2".to_string()],
            vec!["a".to_string(), "r3".to_string()],
        ]
    );
}

#[test]
#[should_panic(expected = "unscripted call to attach_session")]
fn an_unscripted_method_panics() {
    let _ = FakeAgent::offline().attach_session("a", "r");
}

#[test]
fn a_held_session_refuses_attach_until_reclaimed() {
    let agent = FakeAgent::default().always("attach_session", Step::Ok);
    agent.held_by_peer.store(true, Ordering::SeqCst);
    assert!(matches!(
        agent.attach_session("a", "r"),
        Err(TerminalError::SessionHeldByPeer(_))
    ));
    agent.reclaim_session("a", "r").unwrap();
    agent.attach_session("a", "r").unwrap();
    assert_eq!(agent.calls_to("attach_session").len(), 2);
    assert_eq!(agent.calls_to("reclaim_session").len(), 1);
}

#[test]
fn a_hanging_step_blocks_until_its_gate_opens() {
    let gate = Gate::new();
    let agent = Arc::new(FakeAgent::default().on(
        "attach_session",
        Step::Hang(gate.clone(), Box::new(Step::Ok)),
    ));
    let worker = {
        let agent = agent.clone();
        std::thread::spawn(move || agent.attach_session("a", "r"))
    };
    std::thread::sleep(Duration::from_millis(20));
    assert!(!worker.is_finished(), "the attach must hang on the gate");
    gate.open();
    worker.join().unwrap().unwrap();
}

#[test]
fn a_delayed_step_answers_after_its_delay() {
    let agent = FakeAgent::default().on(
        "close_session",
        Step::Delay(Duration::from_millis(20), Box::new(Step::fail("late"))),
    );
    let started = std::time::Instant::now();
    assert!(agent.close_session("a", "r").is_err());
    assert!(started.elapsed() >= Duration::from_millis(20));
}

#[test]
fn new_session_mints_a_running_attached_session() {
    let agent = FakeAgent::default().always("create_session", Step::NewSession);
    let a = agent
        .create_session("a", "local", json!({}), Some("T"), None)
        .unwrap();
    let b = agent
        .create_session("a", "local", json!({}), None, Some("def-1"))
        .unwrap();
    assert_ne!(a.session_id, b.session_id);
    assert_eq!(a.title, "T");
    assert_eq!(b.title, "mock");
    assert_eq!(b.definition_id.as_deref(), Some("def-1"));
    assert!(a.attached);
}
