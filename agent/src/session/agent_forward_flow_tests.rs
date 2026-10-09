//! Flow control for desktop port-forward streams (#4284): a stream opened with
//! a window never has more than that many unacknowledged bytes in flight
//! toward the desktop, acks inbound bytes once they reach the target, and
//! frees its state on teardown. A stream opened without one (an older desktop)
//! is relayed unbounded, as before.

use std::time::Duration;

use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::UnboundedReceiver;

use super::*;
use crate::protocol::methods::AGENT_FORWARD_ACK;
use termihub_core::session::forward_window::AGENT_FORWARD_WINDOW;

type Rx = UnboundedReceiver<JsonRpcNotification>;

fn relay() -> (Arc<AgentForwardRelay>, Rx) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    (AgentForwardRelay::new(tx), rx)
}

/// A target that has connected to the relay, plus the relay stream id.
async fn connected(
    relay: &Arc<AgentForwardRelay>,
    sid: &str,
    window: Option<u64>,
) -> (TcpStream, Option<u64>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let granted = relay
        .connect_tcp_windowed(sid, "127.0.0.1", port, window)
        .await
        .expect("connect");
    let (server, _) = listener.accept().await.unwrap();
    (server, granted)
}

/// A target that writes `total` bytes as fast as the socket takes them.
fn flood(mut server: TcpStream, total: usize) -> tokio::task::JoinHandle<TcpStream> {
    tokio::spawn(async move {
        let chunk = vec![0xA5u8; 64 * 1024];
        let mut sent = 0;
        while sent < total {
            let n = chunk.len().min(total - sent);
            if server.write_all(&chunk[..n]).await.is_err() {
                break;
            }
            sent += n;
        }
        server
    })
}

/// Decode the data notifications that arrive until the stream is quiet for
/// `quiet`, returning the bytes received.
async fn drain_data(rx: &mut Rx, quiet: Duration) -> usize {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut got = 0;
    while let Ok(Some(n)) = tokio::time::timeout(quiet, rx.recv()).await {
        if n.method == AGENT_FORWARD_DATA {
            got += b64
                .decode(n.params["data"].as_str().unwrap())
                .unwrap()
                .len();
        }
    }
    got
}

/// A target faster than the desktop: with no acks, the agent reads (and
/// queues toward the desktop) at most the window, however much the target
/// has to send.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_windowed_stream_never_runs_more_than_the_window_ahead() {
    let (relay, mut rx) = relay();
    let window = 64 * 1024;
    let (server, granted) = connected(&relay, "pf#1", Some(window)).await;
    assert_eq!(
        granted,
        Some(window),
        "the agent grants the requested window"
    );
    let _target = flood(server, 4 * 1024 * 1024);

    let first = drain_data(&mut rx, Duration::from_millis(300)).await;
    assert_eq!(
        first, window as usize,
        "exactly the window is in flight while the desktop acks nothing"
    );

    // An ack returns credit: exactly that much more is read.
    relay.ack("pf#1", 16 * 1024).await;
    let more = drain_data(&mut rx, Duration::from_millis(300)).await;
    assert_eq!(more, 16 * 1024);
}

/// With the desktop acking what it consumes, a windowed stream still carries
/// everything, in order, end to end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_windowed_stream_with_acks_carries_everything() {
    let (relay, mut rx) = relay();
    let (mut server, _) = connected(&relay, "pf#2", Some(32 * 1024)).await;
    let total = 1024 * 1024;
    let payload: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
    let expected = payload.clone();
    tokio::spawn(async move {
        server.write_all(&payload).await.unwrap();
        server.shutdown().await.unwrap();
        // Keep the read side open until the relay closes.
        let mut sink = Vec::new();
        let _ = server.read_to_end(&mut sink).await;
    });

    let b64 = base64::engine::general_purpose::STANDARD;
    let mut received = Vec::new();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("stream progresses")
            .expect("channel open");
        match n.method.as_str() {
            m if m == AGENT_FORWARD_DATA => {
                let data = b64.decode(n.params["data"].as_str().unwrap()).unwrap();
                relay.ack("pf#2", data.len() as u64).await;
                received.extend(data);
            }
            m if m == AGENT_FORWARD_CLOSE => break,
            _ => {}
        }
    }
    assert_eq!(received.len(), expected.len());
    assert!(received == expected, "bytes arrive intact and in order");
}

/// A stream opened without a window (an older desktop) is relayed unbounded,
/// exactly as before #4284: no acks are needed for everything to arrive.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unwindowed_stream_needs_no_acks() {
    let (relay, mut rx) = relay();
    let (server, granted) = connected(&relay, "pf#3", None).await;
    assert_eq!(granted, None, "no window requested, none granted");
    let total = 2 * AGENT_FORWARD_WINDOW;
    let _target = flood(server, total);
    let got = drain_data(&mut rx, Duration::from_millis(500)).await;
    assert_eq!(got, total);
}

/// A requested window larger than the agent's maximum is capped to it.
#[tokio::test]
async fn an_oversized_window_request_is_capped() {
    let (relay, _rx) = relay();
    let (_server, granted) = connected(&relay, "pf#4", Some(u64::MAX)).await;
    assert_eq!(granted, Some(AGENT_FORWARD_WINDOW as u64));
}

/// Desktop bytes on a windowed stream are acknowledged once written to the
/// target, so the desktop can keep its own window open.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inbound_bytes_are_acked_after_reaching_the_target() {
    let (relay, mut rx) = relay();
    let (mut server, _) = connected(&relay, "pf#5", Some(64 * 1024)).await;

    relay.write("pf#5", vec![1u8; 1000]).await;
    relay.write("pf#5", vec![2u8; 500]).await;
    let mut buf = vec![0u8; 1500];
    server.read_exact(&mut buf).await.unwrap();

    let mut acked = 0u64;
    while acked < 1500 {
        let n = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("ack in time")
            .unwrap();
        if n.method == AGENT_FORWARD_ACK {
            assert_eq!(n.params["stream_id"], "pf#5");
            acked += n.params["bytes"].as_u64().unwrap();
        }
    }
    assert_eq!(acked, 1500);
}

/// A desktop that overruns the window it was granted breaks the protocol:
/// the stream is closed rather than buffering without bound.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_inbound_overrun_closes_the_stream() {
    let (relay, mut rx) = relay();
    let (_server, _) = connected(&relay, "pf#6", Some(1024)).await;

    relay.write("pf#6", vec![0u8; 4096]).await;
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("close in time")
            .unwrap();
        if n.method == AGENT_FORWARD_CLOSE {
            assert_eq!(n.params["stream_id"], "pf#6");
            break;
        }
    }
    assert!(relay.streams.lock().await.is_empty());
}

/// Teardown frees every piece of per-stream state: a desktop `close` while the
/// reader is parked on an exhausted window, and a target hangup.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn teardown_frees_the_stream_state() {
    let (relay, mut rx) = relay();
    let (server, _) = connected(&relay, "pf#7", Some(1024)).await;
    let _target = flood(server, 1024 * 1024);
    // The reader parks once the window is spent.
    assert_eq!(drain_data(&mut rx, Duration::from_millis(200)).await, 1024);

    relay.close_stream("pf#7").await;
    assert!(relay.streams.lock().await.is_empty());
    assert!(relay.tcp_readers.lock().await.is_empty());

    let (server, _) = connected(&relay, "pf#8", Some(1024)).await;
    drop(server);
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("close in time")
            .unwrap();
        if n.method == AGENT_FORWARD_CLOSE && n.params["stream_id"] == "pf#8" {
            break;
        }
    }
    assert!(relay.streams.lock().await.is_empty());
    assert!(relay.tcp_readers.lock().await.is_empty());
}

/// Acks for an unknown or unwindowed stream are harmless no-ops.
#[tokio::test]
async fn stray_acks_are_ignored() {
    let (relay, _rx) = relay();
    relay.ack("nope#1", 10).await;
    let (_server, _) = connected(&relay, "pf#9", None).await;
    relay.ack("pf#9", 10).await;
}
