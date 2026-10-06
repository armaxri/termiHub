//! Untrusted-peer validation of runner frames (#4182): what the host accepts,
//! what it ignores, and what kills the runner.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use termihub_plugin_runner::ipc::{
    Alive, Heartbeat, Hello, Log, Message, SessionRef, PROTOCOL_VERSION,
};

use super::*;

fn shared() -> Arc<Shared> {
    Shared::new(
        "probe".to_owned(),
        None,
        Arc::new(PluginLogLimiter::default()),
    )
}

/// Register a session the way `SandboxedPlugin::register_session` does.
fn register(shared: &Shared) -> (u32, Arc<AtomicBool>, tokio::sync::mpsc::Receiver<Vec<u8>>) {
    let id = shared.next_session.fetch_add(1, Ordering::SeqCst);
    let alive = Arc::new(AtomicBool::new(true));
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    shared.sessions.lock().unwrap().insert(
        id,
        SessionSlot {
            output: Arc::new(Mutex::new(Some(tx))),
            alive: Arc::clone(&alive),
            reply: None,
        },
    );
    (id, alive, rx)
}

fn log(session_id: Option<u32>, level: u32, message: String) -> Message {
    Message::Log(Log {
        session_id,
        level,
        message,
        truncated: false,
    })
}

#[test]
fn output_for_a_live_session_is_delivered() {
    let shared = shared();
    let (id, _alive, mut rx) = register(&shared);
    shared
        .dispatch(Message::Output {
            session_id: id,
            data: b"hi".to_vec(),
        })
        .unwrap();
    assert_eq!(rx.try_recv().unwrap(), b"hi");
}

#[test]
fn frames_for_a_never_allocated_session_are_violations() {
    let shared = shared();
    let (id, _alive, _rx) = register(&shared);
    for bad in [0, id + 1, u32::MAX] {
        assert!(shared
            .dispatch(Message::Output {
                session_id: bad,
                data: vec![]
            })
            .is_err());
        assert!(shared
            .dispatch(Message::Alive(Alive {
                session_id: bad,
                alive: false
            }))
            .is_err());
        assert!(shared
            .dispatch(Message::Closed(SessionRef { session_id: bad }))
            .is_err());
        assert!(shared.dispatch(log(Some(bad), 3, "x".into())).is_err());
    }
}

#[test]
fn late_frames_for_a_retired_session_are_ignored() {
    let shared = shared();
    let (id, _alive, _rx) = register(&shared);
    shared.retire(id);
    assert!(shared
        .dispatch(Message::Output {
            session_id: id,
            data: b"late".to_vec()
        })
        .is_ok());
    assert!(shared
        .dispatch(Message::Closed(SessionRef { session_id: id }))
        .is_ok());
}

#[test]
fn alive_updates_flip_session_liveness() {
    let shared = shared();
    let (id, alive, _rx) = register(&shared);
    shared
        .dispatch(Message::Alive(Alive {
            session_id: id,
            alive: false,
        }))
        .unwrap();
    assert!(!alive.load(Ordering::SeqCst));
}

#[test]
fn log_lines_are_bounded_and_levels_checked() {
    let shared = shared();
    assert!(shared.dispatch(log(None, 3, "fine".into())).is_ok());
    assert!(shared.dispatch(log(None, 0, "bad level".into())).is_err());
    assert!(shared.dispatch(log(None, 99, "bad level".into())).is_err());
    // Over the bound even after lossy decoding: a hostile runner.
    let huge = "x".repeat(MAX_WIRE_LOG_BYTES + 1);
    assert!(shared.dispatch(log(None, 3, huge)).is_err());
    // Within the wire bound but over the message bound: emitted, truncated.
    let long = "y".repeat(MAX_LOG_MESSAGE_BYTES + 10);
    assert!(shared.dispatch(log(None, 3, long)).is_ok());
}

#[test]
fn handshake_frames_after_the_handshake_are_violations() {
    let shared = shared();
    let hello = Message::Hello(Hello {
        runner_version: "x".into(),
        protocol_version: PROTOCOL_VERSION,
        pid: 1,
    });
    assert!(shared.dispatch(hello).is_err());
}

#[test]
fn a_pong_must_answer_a_ping_that_was_sent() {
    let shared = shared();
    // No ping sent yet: any pong is forged.
    assert!(shared
        .dispatch(Message::Pong(Heartbeat { nonce: 1 }))
        .is_err());
    {
        let mut beat = shared.heartbeat.lock().unwrap();
        beat.last_sent = 2;
        beat.outstanding_since = Some(std::time::Instant::now());
    }
    // A stale duplicate is ignored and leaves the ping outstanding.
    assert!(shared
        .dispatch(Message::Pong(Heartbeat { nonce: 1 }))
        .is_ok());
    assert!(shared.heartbeat.lock().unwrap().outstanding_since.is_some());
    // A pong from the future is a violation.
    assert!(shared
        .dispatch(Message::Pong(Heartbeat { nonce: 3 }))
        .is_err());
    // The answer clears it.
    assert!(shared
        .dispatch(Message::Pong(Heartbeat { nonce: 2 }))
        .is_ok());
    assert!(shared.heartbeat.lock().unwrap().outstanding_since.is_none());
}

#[test]
fn the_first_recorded_cause_wins_and_reaches_the_exit_hook() {
    let shared = shared();
    let seen = Arc::new(Mutex::new(None));
    let sink = Arc::clone(&seen);
    shared.set_exit_hook(Box::new(move |cause| {
        *sink.lock().unwrap() = Some(cause.clone());
    }));
    assert_eq!(shared.exit_cause(), None);
    shared.violation("bad frame");
    shared.set_pending_cause(RunnerExitCause::Stopped);
    assert_eq!(
        shared.exit_cause(),
        Some(RunnerExitCause::InvalidData {
            detail: "bad frame".into()
        })
    );
    // Reaping makes it final and runs the hook once.
    shared.finish(None);
    shared.finish(None);
    assert_eq!(seen.lock().unwrap().clone(), shared.exit_cause());
    assert!(shared.dead.load(Ordering::SeqCst));

    // A hook installed after the exit runs at once.
    let late = Arc::new(Mutex::new(None));
    let sink = Arc::clone(&late);
    shared.set_exit_hook(Box::new(move |cause| {
        *sink.lock().unwrap() = Some(cause.clone());
    }));
    assert_eq!(late.lock().unwrap().clone(), shared.exit_cause());
}

#[test]
fn an_unprovoked_exit_is_classified_from_its_status() {
    let shared = shared();
    shared.finish(None);
    assert_eq!(
        shared.exit_cause(),
        Some(RunnerExitCause::Crashed {
            signal: None,
            exit_code: None
        })
    );
}

#[test]
fn a_reported_allocation_failure_makes_the_exit_out_of_memory() {
    let shared = shared();
    shared.expect_stderr();
    Arc::clone(&shared)
        .forward_stderr(&b"plugin says hi\nmemory allocation of 1048576 bytes failed\n"[..]);
    shared.finish(None);
    assert_eq!(shared.exit_cause(), Some(RunnerExitCause::OutOfMemory));
    assert!(!is_allocation_failure(b"memory allocation of lots"));
    assert!(is_allocation_failure(
        b"memory allocation of 8 bytes failed\r\n"
    ));
}

#[test]
fn marking_dead_ends_every_session_and_releases_waiters() {
    let shared = shared();
    let (id, alive, mut rx) = register(&shared);
    let (tx, reply) = std::sync::mpsc::sync_channel(1);
    shared.sessions.lock().unwrap().get_mut(&id).unwrap().reply = Some(tx);
    shared.mark_dead("test");
    assert!(!alive.load(Ordering::SeqCst));
    assert!(matches!(
        reply.try_recv(),
        Ok(Reply::Failed(PluginError::NotAlive))
    ));
    // The output sender was dropped: the stream ends.
    assert!(rx.try_recv().is_err());
    assert!(rx.is_closed());
}
