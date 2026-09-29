//! The daemon's outbound queue to its worker (#3890), in paused tokio time over
//! an in-memory duplex whose small capacity stands in for the socket buffer.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncReadExt, DuplexStream};
use tokio::time::Instant;

use super::{SinkEvent, WorkerSink, OUTBOUND_BUDGET_BYTES, WRITE_STALL_TIMEOUT};
use crate::daemon::protocol::{self, MSG_OUTPUT};

/// Socket-buffer stand-in: small, so a worker that stops reading fills it fast.
const PIPE: usize = 4 * 1024;

fn sink_pair() -> (WorkerSink, DuplexStream) {
    let (client, server) = tokio::io::duplex(PIPE);
    (WorkerSink::spawn(Box::new(server)), client)
}

/// Payload `i` of a numbered stream, so reordering or loss is visible.
fn chunk(i: usize, len: usize) -> Vec<u8> {
    (0..len).map(|j| ((i * 31 + j) % 251) as u8).collect()
}

/// Read every frame until EOF.
async fn read_all_frames(client: &mut DuplexStream) -> Vec<protocol::Frame> {
    let mut frames = Vec::new();
    while let Some(frame) = protocol::read_frame_async(client).await.unwrap() {
        frames.push(frame);
    }
    frames
}

/// Whether the sink reports anything within `limit`.
async fn event_within(sink: &mut WorkerSink, limit: Duration) -> Option<SinkEvent> {
    tokio::time::timeout(limit, sink.next_event()).await.ok()
}

#[tokio::test(start_paused = true)]
async fn frames_reach_the_worker_in_order() {
    let (sink, mut client) = sink_pair();
    let sent: Vec<Vec<u8>> = (0..200).map(|i| chunk(i, 1500)).collect();
    for payload in &sent {
        sink.send(MSG_OUTPUT, payload);
    }
    let reader = tokio::spawn(async move { read_all_frames(&mut client).await });
    sink.close(Duration::from_secs(5)).await;

    let got = reader.await.unwrap();
    assert_eq!(got.len(), sent.len());
    for (frame, payload) in got.iter().zip(&sent) {
        assert_eq!(frame.msg_type, MSG_OUTPUT);
        assert_eq!(&frame.payload, payload);
    }
}

#[tokio::test(start_paused = true)]
async fn a_worker_that_stops_reading_is_reported_at_the_stall_bound() {
    let (mut sink, client) = sink_pair();
    let start = Instant::now();
    sink.send(MSG_OUTPUT, &chunk(0, 64 * 1024));

    match sink.next_event().await {
        SinkEvent::Finished(Err(e)) => assert_eq!(e.kind(), io::ErrorKind::TimedOut),
        other => panic!("expected a stall timeout, got {other:?}"),
    }
    assert_eq!(start.elapsed(), WRITE_STALL_TIMEOUT);
    drop(client);
}

/// A worker that reads only a little, and waits just under the bound between
/// reads, is never dropped and receives every byte in order — the deadline is
/// on progress, not on how long a frame or the whole queue takes.
#[tokio::test(start_paused = true)]
async fn a_slow_but_reading_worker_is_never_dropped() {
    let (mut sink, mut client) = sink_pair();
    let sent: Vec<Vec<u8>> = (0..8).map(|i| chunk(i, 16 * 1024)).collect();
    for payload in &sent {
        sink.send(MSG_OUTPUT, payload);
    }
    let expected: Vec<u8> = sent
        .iter()
        .flat_map(|p| protocol::encode_frame(MSG_OUTPUT, p))
        .collect();
    let total = expected.len();

    let reader = tokio::spawn(async move {
        let mut got = Vec::new();
        let mut buf = [0u8; 1024];
        while got.len() < total {
            tokio::time::sleep(WRITE_STALL_TIMEOUT - Duration::from_secs(1)).await;
            let n = client.read(&mut buf).await.unwrap();
            got.extend_from_slice(&buf[..n]);
        }
        (got, client)
    });
    let start = Instant::now();
    tokio::select! {
        ev = sink.next_event() => panic!("a reading worker must not be dropped: {ev:?}"),
        joined = reader => {
            let (got, _client) = joined.unwrap();
            assert_eq!(got, expected, "every byte, in order");
        }
    }
    assert!(
        start.elapsed() > WRITE_STALL_TIMEOUT * 10,
        "the transfer really was slow: {:?}",
        start.elapsed()
    );
    assert!(event_within(&mut sink, Duration::from_secs(60))
        .await
        .is_none());
}

#[tokio::test(start_paused = true)]
async fn the_budget_pauses_forwarding_and_room_resumes_it() {
    let (mut sink, mut client) = sink_pair();
    assert!(sink.has_room());
    let frames = OUTBOUND_BUDGET_BYTES / (32 * 1024) + 1;
    for i in 0..frames {
        sink.send(MSG_OUTPUT, &chunk(i, 32 * 1024));
    }
    assert!(!sink.has_room(), "over the budget, forwarding pauses");

    let reader = tokio::spawn(async move {
        let mut n = 0;
        while protocol::read_frame_async(&mut client)
            .await
            .unwrap()
            .is_some()
        {
            n += 1;
            if n == frames {
                break;
            }
        }
        (n, client)
    });
    assert!(matches!(sink.next_event().await, SinkEvent::Room));
    assert!(sink.has_room());
    let (n, _client) = reader.await.unwrap();
    assert_eq!(n, frames, "pausing loses nothing");
}

#[tokio::test(start_paused = true)]
async fn with_room_the_sink_reports_nothing_while_healthy() {
    let (mut sink, _client) = sink_pair();
    sink.send(MSG_OUTPUT, b"hi");
    assert!(event_within(&mut sink, Duration::from_secs(24 * 3600))
        .await
        .is_none());
}

#[tokio::test(start_paused = true)]
async fn close_drains_queued_frames_then_closes() {
    let (sink, mut client) = sink_pair();
    sink.send(MSG_OUTPUT, b"one");
    sink.send(MSG_OUTPUT, b"two");
    let reader = tokio::spawn(async move { read_all_frames(&mut client).await });
    sink.close(Duration::from_secs(1)).await;
    let got = reader.await.unwrap();
    let payloads: Vec<&[u8]> = got.iter().map(|f| f.payload.as_slice()).collect();
    assert_eq!(payloads, [b"one".as_slice(), b"two".as_slice()]);
}

#[tokio::test(start_paused = true)]
async fn close_on_a_worker_that_is_not_reading_is_bounded() {
    let (sink, mut client) = sink_pair();
    sink.send(MSG_OUTPUT, &chunk(0, 64 * 1024));
    let start = Instant::now();
    sink.close(Duration::from_secs(1)).await;
    assert_eq!(start.elapsed(), Duration::from_secs(1));

    // The socket is closed: the worker drains what fit, then sees EOF.
    let mut rest = Vec::new();
    client.read_to_end(&mut rest).await.unwrap();
    assert!(rest.len() <= PIPE);
}

#[tokio::test(start_paused = true)]
async fn dropping_the_sink_closes_the_socket_at_once() {
    let (sink, mut client) = sink_pair();
    sink.send(MSG_OUTPUT, &chunk(0, 64 * 1024));
    drop(sink);
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_millis(10), client.read_to_end(&mut rest))
        .await
        .expect("EOF without waiting for any deadline")
        .unwrap();
}
