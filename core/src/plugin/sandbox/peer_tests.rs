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
    assert!(shared
        .dispatch(Message::Pong(Heartbeat { nonce: 1 }))
        .is_ok());
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
