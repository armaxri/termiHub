//! The daemon's writes to its worker are bounded (#3890).
//!
//! These drive the real `daemon_loop` in paused tokio time over in-memory
//! duplex connections, so the stall deadline elapses instantly and exactly. The
//! 64 KiB duplex capacity stands in for the socket buffer a worker that stops
//! reading leaves full.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::super::{daemon_loop, WorkerAcceptor};
use super::recovery_guard::FakeConnection;
use crate::daemon::protocol::{
    self, INTENT_RECOVERY, INTENT_TAKEOVER, MSG_ATTACH_INTENT, MSG_BUFFER_REPLAY, MSG_CAPABILITIES,
    MSG_DETACH, MSG_ERROR, MSG_EVICTED, MSG_KILL, MSG_OUTPUT, MSG_READY,
};
use crate::daemon::transport::{BoxedReader, BoxedWriter};
use crate::daemon::worker_sink::WRITE_STALL_TIMEOUT;

/// Socket-buffer stand-in for every worker connection.
const PIPE: usize = 64 * 1024;
/// The daemon's ring buffer in these tests.
const RING: usize = 64 * 1024;
/// Output chunk the fake PTY produces.
const CHUNK: usize = 4 * 1024;
/// How long a responsive daemon may take to answer anything, in virtual time.
const PROMPT: Duration = Duration::from_secs(5);

/// Connections handed to the loop instead of a real endpoint listener.
struct TestAcceptor(mpsc::UnboundedReceiver<(BoxedReader, BoxedWriter)>);

impl WorkerAcceptor for TestAcceptor {
    fn accept(
        &mut self,
    ) -> impl std::future::Future<Output = std::io::Result<(BoxedReader, BoxedWriter)>> + Send
    {
        let rx = &mut self.0;
        async move {
            match rx.recv().await {
                Some(conn) => Ok(conn),
                None => std::future::pending().await,
            }
        }
    }
}

/// A running daemon loop: its connection inlet, its fake PTY output, its task.
struct Daemon {
    conns: mpsc::UnboundedSender<(BoxedReader, BoxedWriter)>,
    output: mpsc::Sender<Vec<u8>>,
    task: JoinHandle<()>,
}

fn spawn_daemon() -> Daemon {
    let (conns, conn_rx) = mpsc::unbounded_channel();
    let (output, output_rx) = mpsc::channel::<Vec<u8>>(16);
    let task = tokio::spawn(async move {
        let mut acceptor = TestAcceptor(conn_rx);
        let _ = daemon_loop(
            "write-bound",
            Box::new(FakeConnection),
            output_rx,
            &mut acceptor,
            RING,
            None,
        )
        .await;
    });
    Daemon {
        conns,
        output,
        task,
    }
}

/// The worker end of one connection.
struct Worker {
    reader: ReadHalf<DuplexStream>,
    writer: WriteHalf<DuplexStream>,
}

/// How the daemon answered a connect.
#[derive(Debug, PartialEq)]
enum Attach {
    /// Handshake done; carries the buffer replay (empty when there was none).
    Ready(Vec<u8>),
    /// Refused because a live worker holds the session (AGT-015).
    Refused,
}

impl Worker {
    /// Connect, declaring `intent` like a real worker does.
    async fn connect(daemon: &Daemon, intent: u8) -> Self {
        let (client, server) = tokio::io::duplex(PIPE);
        let (server_r, server_w) = tokio::io::split(server);
        daemon
            .conns
            .send((Box::new(server_r), Box::new(server_w)))
            .expect("daemon accepting");
        let (reader, mut writer) = tokio::io::split(client);
        protocol::write_frame_async(&mut writer, MSG_ATTACH_INTENT, &[intent])
            .await
            .unwrap();
        Self { reader, writer }
    }

    /// Read the daemon's answer to the connect, or `None` if it gave none
    /// within [`PROMPT`] (an unresponsive loop).
    async fn handshake(&mut self) -> Option<Attach> {
        let run = async {
            let mut replay = Vec::new();
            loop {
                let frame = protocol::read_frame_async(&mut self.reader).await.ok()??;
                match frame.msg_type {
                    MSG_ERROR => return Some(Attach::Refused),
                    MSG_BUFFER_REPLAY => replay = frame.payload,
                    MSG_CAPABILITIES => {}
                    MSG_READY => return Some(Attach::Ready(replay)),
                    other => panic!("unexpected handshake frame 0x{other:02x}"),
                }
            }
        };
        tokio::time::timeout(PROMPT, run).await.ok().flatten()
    }

    /// Output frames until none arrives for [`PROMPT`] or the connection ends.
    async fn drain_output(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while let Ok(Ok(Some(frame))) =
            tokio::time::timeout(PROMPT, protocol::read_frame_async(&mut self.reader)).await
        {
            if frame.msg_type == MSG_OUTPUT {
                out.extend_from_slice(&frame.payload);
            }
        }
        out
    }
}

/// Byte `n` of the fake PTY's output stream: gaps and reordering are visible.
fn stream_byte(n: usize) -> u8 {
    (n % 251) as u8
}

fn stream(range: std::ops::Range<usize>) -> Vec<u8> {
    range.map(stream_byte).collect()
}

/// Produce the output stream in [`CHUNK`]s, one every `pace`, until `stop` is
/// set or `limit` bytes are out. Returns how many bytes it produced.
fn spawn_producer(
    output: mpsc::Sender<Vec<u8>>,
    pace: Duration,
    limit: usize,
    stop: Arc<AtomicBool>,
) -> JoinHandle<usize> {
    tokio::spawn(async move {
        let mut produced = 0;
        while produced < limit && !stop.load(Ordering::SeqCst) {
            let chunk = stream(produced..produced + CHUNK);
            if output.send(chunk).await.is_err() {
                break;
            }
            produced += CHUNK;
            tokio::time::sleep(pace).await;
        }
        produced
    })
}

/// A worker that stops reading while output floods is dropped within the stall
/// bound. Throughout, the loop keeps serving (a second worker's recovery
/// connect is answered promptly), and afterwards a new worker attaches and gets
/// the output — including what was produced while nobody was attached — as a
/// gap-free replay followed by live output.
#[tokio::test(start_paused = true)]
async fn a_worker_that_stops_reading_under_a_flood_is_dropped_within_the_bound() {
    let daemon = spawn_daemon();
    let mut wedged = Worker::connect(&daemon, INTENT_TAKEOVER).await;
    assert_eq!(wedged.handshake().await, Some(Attach::Ready(Vec::new())));

    // From here on `wedged` never reads again.
    let stop = Arc::new(AtomicBool::new(false));
    let producer = spawn_producer(
        daemon.output.clone(),
        Duration::from_millis(10),
        usize::MAX,
        Arc::clone(&stop),
    );
    let flood_start = Instant::now();

    // Probe once a second with a recovery connect: refused while the wedged
    // worker still holds the session, accepted once the daemon dropped it.
    let (mut next, replay) = loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let mut probe = Worker::connect(&daemon, INTENT_RECOVERY).await;
        match probe.handshake().await {
            Some(Attach::Refused) => {
                assert!(
                    flood_start.elapsed() <= WRITE_STALL_TIMEOUT + Duration::from_secs(2),
                    "the wedged worker must be dropped within the bound"
                );
            }
            Some(Attach::Ready(replay)) => break (probe, replay),
            None => panic!("the daemon loop stalled behind the wedged worker"),
        }
    };
    let dropped_after = flood_start.elapsed();
    assert!(
        dropped_after >= WRITE_STALL_TIMEOUT,
        "a worker is not dropped before the bound: {dropped_after:?}"
    );
    assert!(
        dropped_after <= WRITE_STALL_TIMEOUT + Duration::from_secs(2),
        "dropped at {dropped_after:?}"
    );

    stop.store(true, Ordering::SeqCst);
    let produced = producer.await.unwrap();
    let mut seen = replay;
    seen.extend(next.drain_output().await);
    assert!(seen.len() >= RING, "the replay carries the detached output");
    assert_eq!(
        seen,
        stream(produced - seen.len()..produced),
        "replay then live output is the gap-free tail of the stream"
    );

    // The dropped worker's socket is closed: it drains what was sent, then EOF.
    let mut rest = Vec::new();
    tokio::time::timeout(PROMPT, wedged.reader.read_to_end(&mut rest))
        .await
        .expect("the wedged worker's connection is closed")
        .unwrap();
    daemon.task.abort();
}

/// A slow worker that keeps reading — a little at a time, pausing just under
/// the stall bound between reads — is never dropped, even though the output far
/// exceeds the queue budget, and receives every byte in order.
#[tokio::test(start_paused = true)]
async fn a_slow_but_reading_worker_keeps_the_session_and_all_output() {
    let daemon = spawn_daemon();
    let mut slow = Worker::connect(&daemon, INTENT_TAKEOVER).await;
    assert_eq!(slow.handshake().await, Some(Attach::Ready(Vec::new())));

    const TOTAL: usize = 2 * 1024 * 1024 + CHUNK;
    let producer = spawn_producer(
        daemon.output.clone(),
        Duration::ZERO,
        TOTAL,
        Arc::new(AtomicBool::new(false)),
    );

    let mut raw = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    let mut output = Vec::new();
    while output.len() < TOTAL {
        tokio::time::sleep(WRITE_STALL_TIMEOUT - Duration::from_secs(1)).await;
        let n = slow.reader.read(&mut buf).await.unwrap();
        assert_ne!(n, 0, "a reading worker must not be disconnected");
        raw.extend_from_slice(&buf[..n]);
        // Peel complete frames off the raw bytes.
        while raw.len() >= 5 {
            let len = u32::from_be_bytes([raw[1], raw[2], raw[3], raw[4]]) as usize;
            if raw.len() < 5 + len {
                break;
            }
            assert_eq!(raw[0], MSG_OUTPUT);
            output.extend_from_slice(&raw[5..5 + len]);
            raw.drain(..5 + len);
        }
    }
    assert_eq!(producer.await.unwrap(), TOTAL);
    assert_eq!(output, stream(0..TOTAL), "every byte, in order");

    // Still attached: a recovery connect is refused.
    let mut probe = Worker::connect(&daemon, INTENT_RECOVERY).await;
    assert_eq!(probe.handshake().await, Some(Attach::Refused));
    daemon.task.abort();
}

/// Output produced while no worker is attached is replayed on the next attach.
#[tokio::test(start_paused = true)]
async fn output_produced_while_detached_is_replayed_on_reattach() {
    let daemon = spawn_daemon();
    let mut first = Worker::connect(&daemon, INTENT_TAKEOVER).await;
    assert_eq!(first.handshake().await, Some(Attach::Ready(Vec::new())));
    protocol::write_frame_async(&mut first.writer, MSG_DETACH, &[])
        .await
        .unwrap();
    let mut rest = Vec::new();
    tokio::time::timeout(PROMPT, first.reader.read_to_end(&mut rest))
        .await
        .expect("detach closes the connection")
        .unwrap();

    daemon
        .output
        .send(b"while-detached".to_vec())
        .await
        .unwrap();
    // Let the loop take it into the ring buffer before the next connect.
    tokio::time::sleep(Duration::from_millis(1)).await;
    let mut second = Worker::connect(&daemon, INTENT_RECOVERY).await;
    assert_eq!(
        second.handshake().await,
        Some(Attach::Ready(b"while-detached".to_vec()))
    );
    daemon.task.abort();
}

/// No deadlock: while a wedged worker has the loop paused on its full queue, a
/// takeover still attaches at once (the incumbent is evicted, not waited on)
/// and a kill from the new worker ends the session.
#[tokio::test(start_paused = true)]
async fn a_takeover_and_kill_are_served_while_the_worker_is_wedged() {
    let daemon = spawn_daemon();
    let mut wedged = Worker::connect(&daemon, INTENT_TAKEOVER).await;
    assert_eq!(wedged.handshake().await, Some(Attach::Ready(Vec::new())));
    let stop = Arc::new(AtomicBool::new(false));
    let producer = spawn_producer(
        daemon.output.clone(),
        Duration::from_millis(1),
        usize::MAX,
        Arc::clone(&stop),
    );
    // Well past the point where the socket and the queue budget are full, and
    // well before the stall bound.
    tokio::time::sleep(WRITE_STALL_TIMEOUT / 3).await;

    let start = Instant::now();
    let mut next = Worker::connect(&daemon, INTENT_TAKEOVER).await;
    assert!(
        matches!(next.handshake().await, Some(Attach::Ready(_))),
        "a takeover attaches while the incumbent is wedged"
    );
    assert!(start.elapsed() < PROMPT);

    stop.store(true, Ordering::SeqCst);
    producer.await.unwrap();
    protocol::write_frame_async(&mut next.writer, MSG_KILL, &[])
        .await
        .unwrap();
    // Keep reading so the new worker is not the one stalling the exit.
    let reader = tokio::spawn(async move { next.drain_output().await });
    tokio::time::timeout(PROMPT, daemon.task)
        .await
        .expect("the kill ends the session")
        .unwrap();
    reader.await.unwrap();

    // The evicted worker's connection was closed (it may or may not have had
    // room left for the eviction notice).
    let mut rest = Vec::new();
    tokio::time::timeout(PROMPT, wedged.reader.read_to_end(&mut rest))
        .await
        .expect("the evicted worker's connection is closed")
        .unwrap();
    let _ = MSG_EVICTED;
}
