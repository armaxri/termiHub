//! Output a server sends before anyone subscribes must not be lost (#4719).
//!
//! The session manager calls `connect` and only then `subscribe_output`. A
//! server that writes its greeting the moment it accepts can have those bytes
//! read by the reader thread inside that gap. They used to go into a channel
//! whose receiver `connect` had already dropped, so a banner (or a whole
//! one-shot payload) vanished and the terminal stayed blank.

use super::*;
use std::io::Write;
use std::net::TcpListener;
use std::time::Instant;

/// Upper bound for one wait. The payload normally arrives within milliseconds.
const CEILING: Duration = Duration::from_secs(10);

/// What the loopback server sends as soon as it accepts the client.
const GREETING: &[u8] = b"TH_EARLY_GREETING\r\n";

/// Connect a [`Telnet`] to a loopback server that writes [`GREETING`] on accept
/// and then holds the connection open. Returns the client and the server side.
async fn connect_to_greeting_server() -> (Telnet, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let accept = std::thread::spawn(move || {
        let (mut peer, _) = listener.accept()?;
        peer.write_all(GREETING)?;
        Ok::<_, std::io::Error>(peer)
    });
    let mut telnet = Telnet::new();
    telnet
        .connect(serde_json::json!({ "host": addr.ip().to_string(), "port": addr.port() }))
        .await
        .expect("connect");
    let peer = accept.join().expect("accept thread").expect("accept");
    (telnet, peer)
}

/// Receive until `needle` has been seen, or fail after [`CEILING`].
async fn receive_until(rx: &mut OutputReceiver, needle: &[u8]) -> Vec<u8> {
    let deadline = Instant::now() + CEILING;
    let mut seen = Vec::new();
    while !seen.windows(needle.len()).any(|w| w == needle) {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Some(chunk)) => seen.extend_from_slice(&chunk),
            Ok(None) => panic!(
                "output channel closed before {:?} arrived; got {:?}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&seen)
            ),
            Err(_) => panic!(
                "timed out waiting for {:?}; got {:?}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&seen)
            ),
        }
    }
    seen
}

/// The greeting is read (and would have been dropped) before the subscriber
/// exists: the server wrote it on accept, and the test only subscribes after
/// the reader thread has had ample time to read it.
#[tokio::test]
async fn output_sent_before_the_first_subscribe_is_delivered() {
    let (telnet, _peer) = connect_to_greeting_server().await;
    // Let the reader thread read and forward the greeting first. Without the
    // fix this is exactly the window in which the bytes were discarded.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut rx = telnet.subscribe_output();
    receive_until(&mut rx, b"TH_EARLY_GREETING").await;
}

/// Later output still reaches the subscriber once the early output was taken.
#[tokio::test]
async fn output_after_the_first_subscribe_still_flows() {
    let (telnet, mut peer) = connect_to_greeting_server().await;
    let mut rx = telnet.subscribe_output();
    receive_until(&mut rx, b"TH_EARLY_GREETING").await;
    peer.write_all(b"TH_LATER_OUTPUT\r\n").expect("write later");
    receive_until(&mut rx, b"TH_LATER_OUTPUT").await;
}

/// A second subscribe still replaces the first (the documented contract), and
/// the new subscriber gets what arrives afterwards.
#[tokio::test]
async fn a_second_subscribe_replaces_the_first() {
    let (telnet, mut peer) = connect_to_greeting_server().await;
    let mut first = telnet.subscribe_output();
    receive_until(&mut first, b"TH_EARLY_GREETING").await;
    let mut second = telnet.subscribe_output();
    peer.write_all(b"TH_SECOND_SUBSCRIBER\r\n")
        .expect("write later");
    receive_until(&mut second, b"TH_SECOND_SUBSCRIBER").await;
}

/// A server that sends its payload and closes at once: the subscriber gets the
/// payload and then sees the channel end, so the session reports the exit.
#[tokio::test]
async fn early_output_then_close_is_delivered_and_ends_the_stream() {
    let (mut telnet, peer) = connect_to_greeting_server().await;
    drop(peer);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut rx = telnet.subscribe_output();
    receive_until(&mut rx, b"TH_EARLY_GREETING").await;
    let _ = telnet.disconnect().await;
    let ended = tokio::time::timeout(CEILING, async { while rx.recv().await.is_some() {} }).await;
    assert!(
        ended.is_ok(),
        "the output stream must end after the session closed"
    );
}
