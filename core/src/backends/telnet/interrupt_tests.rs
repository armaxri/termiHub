//! Closing a telnet session whose write is parked (#4394).
//!
//! A peer that stops reading fills the socket buffers until `write` parks in
//! the kernel. A tab close calls [`ConnectionType::interrupt_io`] before the
//! exclusive `disconnect`, and that must free the socket promptly. These use a
//! real loopback TCP peer that never reads. Every wait polls its condition and
//! returns as soon as it holds; the ceilings only bound a hang.

use super::*;
use std::io::Read;
use std::net::TcpListener;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

/// Upper bound for one wait. Conditions usually hold within milliseconds.
const CEILING: Duration = Duration::from_secs(20);

/// How long the written-byte counter must stay flat before the writer is
/// considered parked inside `write`.
const PARKED_FOR: Duration = Duration::from_millis(300);

/// Connect a [`Telnet`] to a loopback peer that is accepted but never read.
async fn connect_to_silent_peer() -> (Telnet, TcpStream) {
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

#[tokio::test]
async fn connect_sets_a_write_timeout() {
    let (telnet, _peer) = connect_to_silent_peer().await;
    let state = telnet.state.as_ref().expect("connected state");
    let writer = state.writer.lock().expect("lock writer");
    assert_eq!(
        writer.write_timeout().expect("read write timeout"),
        Some(WRITE_TIMEOUT),
        "a write to a stalled peer must not park until TCP gives up"
    );
}

#[tokio::test]
async fn interrupt_io_when_not_connected_is_noop() {
    Telnet::new().interrupt_io();
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupt_io_frees_a_socket_whose_write_is_parked() {
    let (telnet, mut peer) = connect_to_silent_peer().await;
    let telnet = Arc::new(telnet);

    // Write until the peer's receive buffer and our send buffer are full and
    // `write` parks.
    let written = Arc::new(AtomicU64::new(0));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<(), SessionError>>();
    let writer = {
        let telnet = telnet.clone();
        let written = written.clone();
        std::thread::spawn(move || {
            let chunk = vec![b'x'; 64 * 1024];
            let result = loop {
                if let Err(e) = telnet.write(&chunk) {
                    break Err(e);
                }
                written.fetch_add(chunk.len() as u64, Ordering::SeqCst);
            };
            let _ = done_tx.send(result);
        })
    };

    let deadline = Instant::now() + CEILING;
    let mut last = written.load(Ordering::SeqCst);
    let mut flat_since = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(20));
        let now = written.load(Ordering::SeqCst);
        if now != last {
            last = now;
            flat_since = Instant::now();
        } else if flat_since.elapsed() >= PARKED_FOR {
            break;
        }
        assert!(Instant::now() < deadline, "socket write never parked");
    }
    assert!(
        done_rx.try_recv().is_err(),
        "the writer must be parked inside write(), not finished"
    );

    telnet.interrupt_io();
    assert!(
        !telnet.is_connected(),
        "interrupt_io marks the session dead"
    );

    // Unix: the shutdown wakes the parked `send`, with the peer still not
    // reading. (Windows does not promise that; see `interrupt_io`.)
    #[cfg(unix)]
    {
        let result = done_rx
            .recv_timeout(CEILING)
            .expect("interrupt_io must make the parked write return");
        assert!(result.is_err(), "the interrupted write reports an error");
    }

    // Every platform: the peer sees the connection end (EOF or reset) after
    // draining whatever was already in flight.
    peer.set_read_timeout(Some(CEILING)).expect("peer timeout");
    let mut buf = vec![0u8; 256 * 1024];
    let deadline = Instant::now() + CEILING;
    loop {
        match peer.read(&mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                assert_ne!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock,
                    "peer never saw the socket close"
                );
                assert_ne!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut,
                    "peer never saw the socket close"
                );
                break;
            }
        }
        assert!(Instant::now() < deadline, "peer never saw the socket close");
    }

    #[cfg(not(unix))]
    {
        let result = done_rx
            .recv_timeout(CEILING)
            .expect("the write must return once the socket is shut down");
        assert!(result.is_err(), "the interrupted write reports an error");
    }
    writer.join().expect("writer thread");
}
