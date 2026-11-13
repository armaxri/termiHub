//! A telnet session that ends on its own reports why (#5696): a server that
//! closes the connection cleanly is `RemoteClosed`, a reset or a failed write
//! is `IoError`, a peer that failed the keepalive probes is `Timeout`. The
//! frontend writes "connection closed by server" for the first and
//! "connection lost" for the rest. Uses a real loopback TCP server, like
//! `eof_tests`.

use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Instant;

/// Upper bound for one wait. Conditions usually hold within milliseconds.
const CEILING: Duration = Duration::from_secs(20);

/// Connect a [`Telnet`] to a loopback server and return both sides.
async fn connect_to_server() -> (Telnet, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let accept = std::thread::spawn(move || listener.accept());
    let mut telnet = Telnet::new();
    telnet
        .connect(serde_json::json!({ "host": addr.ip().to_string(), "port": addr.port() }))
        .await
        .expect("connect");
    let (peer, _) = accept.join().expect("accept thread").expect("accept");
    (telnet, peer)
}

/// Read the client's whole opening negotiation offer, so a close sends FIN
/// rather than RST (see `eof_tests::read_opening_offer`).
fn read_opening_offer(peer: &mut TcpStream) {
    peer.set_read_timeout(Some(CEILING)).expect("read timeout");
    let mut offer = [0u8; 6];
    peer.read_exact(&mut offer).expect("read the opening offer");
}

/// Wait until the output stream ends. Returns `false` after [`CEILING`].
async fn stream_ends(rx: &mut OutputReceiver) -> bool {
    tokio::time::timeout(CEILING, async { while rx.recv().await.is_some() {} })
        .await
        .is_ok()
}

#[tokio::test]
async fn a_live_session_has_no_end_cause() {
    let (telnet, _peer) = connect_to_server().await;
    assert_eq!(telnet.end_cause(), None);
}

#[tokio::test]
async fn a_clean_server_close_is_remote_closed() {
    let (telnet, mut peer) = connect_to_server().await;
    let mut rx = telnet.subscribe_output();
    read_opening_offer(&mut peer);
    drop(peer);
    assert!(stream_ends(&mut rx).await, "the output stream must end");
    assert_eq!(telnet.end_cause(), Some(SessionEndCause::RemoteClosed));
}

#[tokio::test]
async fn a_connection_reset_is_an_io_error() {
    let (telnet, mut peer) = connect_to_server().await;
    let mut rx = telnet.subscribe_output();
    read_opening_offer(&mut peer);
    // A zero linger makes the close send RST instead of FIN.
    socket2::SockRef::from(&peer)
        .set_linger(Some(Duration::ZERO))
        .expect("set linger");
    drop(peer);
    assert!(stream_ends(&mut rx).await, "the output stream must end");
    assert_eq!(telnet.end_cause(), Some(SessionEndCause::IoError));
}

/// The failed write shuts the socket down, so the reader then reads an
/// end-of-stream: that must not turn the failure into a clean close.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_write_is_an_io_error_not_a_remote_close() {
    let (telnet, _peer) = connect_to_server().await;
    let mut rx = telnet.subscribe_output();
    let state = telnet.state.as_ref().expect("connected");
    state
        .writer
        .stream()
        .set_write_timeout(Some(Duration::from_millis(200)))
        .expect("set write timeout");
    let chunk = vec![b'x'; 64 * 1024];
    let deadline = Instant::now() + CEILING;
    while telnet.write(&chunk).is_ok() {
        assert!(
            Instant::now() < deadline,
            "writes to a stalled peer must fail"
        );
    }
    assert!(stream_ends(&mut rx).await, "the output stream must end");
    assert_eq!(telnet.end_cause(), Some(SessionEndCause::IoError));
}

#[tokio::test]
async fn a_deliberate_disconnect_has_no_end_cause() {
    let (mut telnet, mut peer) = connect_to_server().await;
    read_opening_offer(&mut peer);
    telnet.disconnect().await.expect("disconnect");
    drop(peer);
    assert_eq!(telnet.end_cause(), None);
}

/// A reconnect starts with a clean slate: the previous connection's cause
/// does not carry over.
#[tokio::test]
async fn a_reconnect_clears_the_previous_cause() {
    let (mut telnet, mut peer) = connect_to_server().await;
    let mut rx = telnet.subscribe_output();
    read_opening_offer(&mut peer);
    drop(peer);
    assert!(stream_ends(&mut rx).await);
    assert!(telnet.end_cause().is_some());
    telnet.disconnect().await.expect("disconnect");

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let accept = std::thread::spawn(move || listener.accept());
    telnet
        .connect(serde_json::json!({ "host": addr.ip().to_string(), "port": addr.port() }))
        .await
        .expect("reconnect");
    let (mut peer, _) = accept.join().expect("accept thread").expect("accept");
    peer.write_all(b"hi").expect("write");
    assert_eq!(telnet.end_cause(), None);
}

/// A read error's cause: a real `ETIMEDOUT` (failed keepalive) is a timeout,
/// anything else an I/O error.
#[test]
fn read_errors_map_to_their_cause() {
    use std::io::{Error, ErrorKind};
    assert_eq!(
        reader::cause_of_read_error(&Error::from(ErrorKind::TimedOut)),
        SessionEndCause::Timeout
    );
    assert_eq!(
        reader::cause_of_read_error(&Error::from(ErrorKind::ConnectionReset)),
        SessionEndCause::IoError
    );
    assert_eq!(
        reader::cause_of_read_error(&Error::from(ErrorKind::ConnectionAborted)),
        SessionEndCause::IoError
    );
}
