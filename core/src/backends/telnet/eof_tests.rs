//! A telnet session whose connection ends must end its output stream (#5569).
//!
//! The session manager only learns that a session ended when the backend's
//! output channel closes. The reader used to stop on EOF or a read error but
//! keep the stored output sender, so a tab whose server hung up stayed green
//! and `connected`, with no disconnect overlay and no Reconnect. These tests
//! use a real loopback TCP server. Every wait returns as soon as its condition
//! holds; the ceilings only bound a hang.

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

/// Read the client's opening negotiation offer (`IAC WILL NAWS`), so the
/// server has finished negotiating and has no unread data when it closes.
fn read_opening_offer(peer: &mut TcpStream) {
    peer.set_read_timeout(Some(CEILING)).expect("read timeout");
    let mut offer = [0u8; 3];
    peer.read_exact(&mut offer).expect("read the opening offer");
    assert_eq!(offer, [IAC, WILL, negotiation::OPT_NAWS]);
}

/// Wait until the output stream ends. Output before the end is discarded.
/// Returns `false` if it was still open after [`CEILING`].
async fn stream_ends(rx: &mut OutputReceiver) -> bool {
    tokio::time::timeout(CEILING, async { while rx.recv().await.is_some() {} })
        .await
        .is_ok()
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

/// The server negotiates, sends a line and hangs up (FIN): the subscriber gets
/// the line, then the stream ends and the session reports disconnected.
#[tokio::test]
async fn server_close_after_negotiation_ends_the_output_stream() {
    let (telnet, mut peer) = connect_to_server().await;
    let mut rx = telnet.subscribe_output();
    read_opening_offer(&mut peer);
    peer.write_all(b"bye\r\n").expect("write");
    drop(peer);

    let mut seen = Vec::new();
    let ended = tokio::time::timeout(CEILING, async {
        while let Some(chunk) = rx.recv().await {
            seen.extend_from_slice(&chunk);
        }
    })
    .await
    .is_ok();
    assert!(ended, "the output stream must end after the server closed");
    assert!(
        seen.windows(3).any(|w| w == b"bye"),
        "output sent before the close is still delivered; got {:?}",
        String::from_utf8_lossy(&seen)
    );
    assert!(!telnet.is_connected(), "a closed session is not connected");
}

/// The server resets the connection (RST): the read fails, and that ends the
/// stream just like a clean close.
#[tokio::test]
async fn connection_reset_ends_the_output_stream() {
    let (telnet, mut peer) = connect_to_server().await;
    let mut rx = telnet.subscribe_output();
    read_opening_offer(&mut peer);
    // A zero linger makes the close send RST instead of FIN.
    socket2::SockRef::from(&peer)
        .set_linger(Some(Duration::ZERO))
        .expect("set linger");
    drop(peer);

    assert!(
        stream_ends(&mut rx).await,
        "the output stream must end after a reset"
    );
    assert!(!telnet.is_connected(), "a reset session is not connected");
}

/// A server that closes before anyone subscribed: the first subscriber still
/// sees the end, so a session that died during connect is reported too.
#[tokio::test]
async fn close_before_the_first_subscribe_still_ends_the_stream() {
    let (telnet, mut peer) = connect_to_server().await;
    read_opening_offer(&mut peer);
    drop(peer);
    assert!(
        eventually(|| !telnet.is_connected()).await,
        "the reader must notice the close"
    );
    let mut rx = telnet.subscribe_output();
    assert!(stream_ends(&mut rx).await, "the output stream must end");
}

/// A failed write ends the session. The peer never reads, so with a short
/// write timeout the socket buffers fill and a write fails; the session must
/// then end its output stream instead of staying `connected` while every
/// keystroke vanishes.
#[tokio::test(flavor = "multi_thread")]
async fn failed_write_ends_the_output_stream() {
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
    let failed = loop {
        if telnet.write(&chunk).is_err() {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
    };
    assert!(failed, "writes to a peer that never reads must fail");
    assert!(
        stream_ends(&mut rx).await,
        "a failed write must end the output stream"
    );
    assert!(!telnet.is_connected());
}

/// Reconnecting the same instance right after a disconnect keeps working: the
/// old reader thread's exit does not end the new connection's output stream.
#[tokio::test]
async fn an_old_reader_does_not_end_a_new_connection() {
    let (mut telnet, _old_peer) = connect_to_server().await;
    telnet.disconnect().await.expect("disconnect");

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let accept = std::thread::spawn(move || listener.accept());
    telnet
        .connect(serde_json::json!({ "host": addr.ip().to_string(), "port": addr.port() }))
        .await
        .expect("reconnect");
    let (mut peer, _) = accept.join().expect("accept thread").expect("accept");
    let mut rx = telnet.subscribe_output();

    // Give the old reader several read timeouts to notice and exit.
    tokio::time::sleep(READ_TIMEOUT * 5).await;
    peer.write_all(b"still here\r\n").expect("write");

    let mut seen = Vec::new();
    let got = tokio::time::timeout(CEILING, async {
        while !seen.windows(10).any(|w| w == b"still here") {
            match rx.recv().await {
                Some(chunk) => seen.extend_from_slice(&chunk),
                None => return false,
            }
        }
        true
    })
    .await;
    assert_eq!(
        got,
        Ok(true),
        "the new connection's stream must stay open; got {:?}",
        String::from_utf8_lossy(&seen)
    );
    assert!(telnet.is_connected());
}

/// A reader context over a loopback socket, with its own `alive` flag and the
/// given shared output sender slot.
fn reader_context(
    alive: bool,
    output_tx: Arc<Mutex<Option<OutputSender>>>,
) -> (reader::ReaderContext, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let client = TcpStream::connect(listener.local_addr().expect("addr")).expect("connect");
    let (peer, _) = listener.accept().expect("accept");
    let ctx = reader::ReaderContext {
        stream: client.try_clone().expect("clone"),
        writer: Arc::new(SharedWriter::new(client)),
        negotiator: Arc::new(Mutex::new(Negotiator::new(DEFAULT_TERMINAL_TYPE))),
        alive: Arc::new(AtomicBool::new(alive)),
        output_tx,
        auto_login: None,
    };
    (ctx, peer)
}

/// A reader that finds its connection dead drops the output sender, so the
/// session manager sees the stream end.
#[test]
fn a_reader_that_finds_the_end_drops_the_sender() {
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let output_tx = Arc::new(Mutex::new(Some(tx)));
    let (ctx, _peer) = reader_context(true, output_tx.clone());
    reader::end_session(&ctx);
    assert!(!ctx.alive.load(Ordering::SeqCst));
    assert!(output_tx.lock().unwrap().is_none());
}

/// A reader stopped by someone else (`disconnect`, `interrupt_io`, the drop
/// guard) leaves the sender alone: by then it may belong to a new connection
/// of the same `Telnet`, which must keep its stream.
#[test]
fn a_stopped_reader_leaves_the_sender_alone() {
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let output_tx = Arc::new(Mutex::new(Some(tx)));
    let (ctx, _peer) = reader_context(false, output_tx.clone());
    reader::end_session(&ctx);
    assert!(output_tx.lock().unwrap().is_some());
}

/// Only the socket's own read timeout is benign. A real `ETIMEDOUT` (a peer
/// that failed the keepalive probes) ends the session on Unix; Windows reports
/// its read timeout as `TimedOut`, so there it stays benign.
#[test]
fn only_the_read_timeout_is_benign() {
    use std::io::{Error, ErrorKind};
    assert!(reader::is_read_timeout(&Error::from(ErrorKind::WouldBlock)));
    assert_eq!(
        reader::is_read_timeout(&Error::from(ErrorKind::TimedOut)),
        cfg!(windows)
    );
    assert!(!reader::is_read_timeout(&Error::from(
        ErrorKind::ConnectionReset
    )));
    assert!(!reader::is_read_timeout(&Error::from(
        ErrorKind::ConnectionAborted
    )));
}
