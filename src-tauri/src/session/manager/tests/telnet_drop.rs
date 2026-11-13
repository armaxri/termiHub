//! A telnet server that hangs up must end the session (#5569).
//!
//! The tab used to stay green and `connected` after the server closed the
//! connection: the telnet reader never ended its output stream, so the
//! manager never emitted `terminal-exit` and never folded the drop. These run
//! the real telnet backend against a loopback server.

use super::*;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// Upper bound for one wait. Conditions usually hold within milliseconds.
const CEILING: Duration = Duration::from_secs(20);

fn telnet_manager() -> SessionManager {
    let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
    registry.register(
        "telnet",
        "Telnet",
        "telnet",
        Box::new(|| Box::new(termihub_core::backends::telnet::Telnet::new())),
    );
    SessionManager::new(registry, Arc::new(FakeAgent::offline()))
}

/// Open a telnet tab against `listener`; returns the session id and the
/// accepted server side, with the client's opening offer already read.
async fn open_tab(
    manager: &SessionManager,
    listener: &TcpListener,
    connect_id: &str,
    emitter: &MockEventEmitter,
) -> (String, TcpStream) {
    let addr = listener.local_addr().expect("local_addr");
    let session_id = manager
        .create_connection(
            "telnet",
            serde_json::json!({ "host": addr.ip().to_string(), "port": addr.port() }),
            None,
            Some(connect_id),
            false,
            false,
            emitter.clone(),
        )
        .await
        .expect("telnet session should open");
    let (mut peer, _) = listener.accept().expect("accept");
    peer.set_read_timeout(Some(CEILING)).expect("read timeout");
    // The whole opening negotiation offer (`IAC WILL NAWS`, `IAC DO SGA` in
    // the default character mode). Read all of it: a socket closed with
    // unread data resets instead of closing cleanly (#5696).
    let mut offer = [0u8; 6];
    peer.read_exact(&mut offer).expect("read the opening offer");
    (session_id, peer)
}

/// Poll `cond` until it holds or [`CEILING`] passes.
async fn eventually(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + CEILING;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    cond()
}

fn output_contains(emitter: &MockEventEmitter, needle: &[u8]) -> bool {
    let outputs = emitter.outputs.lock().unwrap();
    let all: Vec<u8> = outputs.iter().flat_map(|e| e.data.clone()).collect();
    all.windows(needle.len()).any(|w| w == needle)
}

#[tokio::test(flavor = "multi_thread")]
async fn server_close_folds_the_drop_and_a_reconnect_works() {
    let manager = telnet_manager();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");

    let first = MockEventEmitter::new();
    let (session_id, peer) = open_tab(&manager, &listener, "tab-t:0", &first).await;
    drop(peer);

    assert!(
        eventually(|| first.exits.lock().unwrap().len() == 1).await,
        "a server-side close must emit terminal-exit"
    );
    assert_eq!(
        first.exits.lock().unwrap()[0].end_cause,
        Some(SessionEndCause::RemoteClosed),
        "a clean server close carries its cause (#5696)"
    );
    assert_eq!(
        first.session_drops.lock().unwrap().as_slice(),
        &[("tab-t".to_string(), DropFold::Dropped)],
        "the drop folds the tab to Disconnected (overlay with Reconnect)"
    );
    let deadline = Instant::now() + CEILING;
    while manager
        .list_sessions()
        .await
        .iter()
        .any(|s| s.id == session_id)
    {
        assert!(Instant::now() < deadline, "the dead session is removed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Reconnect: the tab's next attempt opens a fresh session that works.
    let second = MockEventEmitter::new();
    let (new_id, mut peer) = open_tab(&manager, &listener, "tab-t:1", &second).await;
    assert_ne!(new_id, session_id);
    peer.write_all(b"welcome back\r\n").expect("write");
    assert!(
        eventually(|| output_contains(&second, b"welcome back")).await,
        "the reconnected session carries output"
    );
    assert!(second.exits.lock().unwrap().is_empty());
    manager.close_session(&new_id).await.expect("close");
}

/// A reset link carries an I/O-error cause, so the tab reads "connection
/// lost" rather than "closed by server" (#5696).
#[tokio::test(flavor = "multi_thread")]
async fn a_reset_link_carries_an_io_error_cause() {
    let manager = telnet_manager();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let emitter = MockEventEmitter::new();
    let (_session_id, peer) = open_tab(&manager, &listener, "tab-r:0", &emitter).await;
    socket2::SockRef::from(&peer)
        .set_linger(Some(Duration::ZERO))
        .expect("set linger");
    drop(peer);

    assert!(
        eventually(|| emitter.exits.lock().unwrap().len() == 1).await,
        "a reset must emit terminal-exit"
    );
    assert_eq!(
        emitter.exits.lock().unwrap()[0].end_cause,
        Some(SessionEndCause::IoError)
    );
}
