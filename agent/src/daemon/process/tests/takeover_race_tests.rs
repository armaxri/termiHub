//! The loser of a takeover race gets a typed eviction, never a torn handshake
//! (#4409).
//!
//! Two workers that take over the same session at once both attach, one after
//! the other, and the second evicts the first — often moments after the first
//! attached, while its handshake is still queued. These drive the real
//! `daemon_loop` in paused tokio time over in-memory connections whose daemon
//! side accepts each write only after a delay: the stand-in for a Windows named
//! pipe on a loaded host, where every queued frame waits for its own I/O
//! completion and the runtime can be busy elsewhere for over a second.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncWrite, DuplexStream};
use tokio::time::Sleep;

use super::write_bound_tests::{spawn_daemon, Attach, Daemon, Worker};
use crate::daemon::protocol::{self, INTENT_TAKEOVER, MSG_EVICTED};

/// How long each daemon-side write takes to be accepted: longer than the
/// historical 1 s wall-clock cap on draining an evicted worker's queue, short
/// enough that a three-frame handshake plus eviction fits the harness's
/// prompt bound.
const SLOW_WRITE: Duration = Duration::from_millis(1500);

/// A writer that accepts each write only once [`SLOW_WRITE`] has passed.
struct SlowWriter<W> {
    inner: W,
    delay: Option<Pin<Box<Sleep>>>,
}

impl<W: AsyncWrite + Unpin> AsyncWrite for SlowWriter<W> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let delay = self
            .delay
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(SLOW_WRITE)));
        if delay.as_mut().poll(cx).is_pending() {
            return Poll::Pending;
        }
        self.delay = None;
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Connect a worker whose daemon-side writes are slow, declaring a takeover.
async fn connect_slow_takeover(daemon: &Daemon) -> Worker {
    let (client, server) = tokio::io::duplex(64 * 1024);
    let (server_r, server_w) = tokio::io::split::<DuplexStream>(server);
    let slow = SlowWriter {
        inner: server_w,
        delay: None,
    };
    daemon
        .conns
        .send((Box::new(server_r), Box::new(slow)))
        .expect("daemon accepting");
    let (reader, writer) = tokio::io::split(client);
    let mut worker = Worker { reader, writer };
    worker.send_intent(INTENT_TAKEOVER).await;
    worker
}

/// Whether the worker's next frame is `MSG_EVICTED`.
async fn is_evicted(worker: &mut Worker) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(10),
            protocol::read_frame_async(&mut worker.reader),
        )
        .await,
        Ok(Ok(Some(frame))) if frame.msg_type == MSG_EVICTED
    )
}

/// Two racing takeovers both finish their handshake, and exactly one of them
/// is then evicted — the loser reads `MSG_READY` and then `MSG_EVICTED`, never a
/// connection closed mid-handshake, however slowly its frames go out.
#[tokio::test(start_paused = true)]
async fn the_loser_of_a_takeover_race_reads_ready_then_evicted() {
    let daemon = spawn_daemon();
    let mut holder = Worker::connect(&daemon, INTENT_TAKEOVER).await;
    assert_eq!(holder.handshake().await, Some(Attach::Ready(Vec::new())));

    let mut b = connect_slow_takeover(&daemon).await;
    let mut c = connect_slow_takeover(&daemon).await;

    let (hb, hc) = tokio::join!(b.handshake(), c.handshake());
    assert_eq!(
        hb,
        Some(Attach::Ready(Vec::new())),
        "B must finish its handshake, not see the connection closed"
    );
    assert_eq!(
        hc,
        Some(Attach::Ready(Vec::new())),
        "C must finish its handshake, not see the connection closed"
    );

    let (b_evicted, c_evicted) = tokio::join!(is_evicted(&mut b), is_evicted(&mut c));
    assert!(
        b_evicted ^ c_evicted,
        "exactly one racer is evicted (B: {b_evicted}, C: {c_evicted})"
    );
    daemon.task.abort();
}
