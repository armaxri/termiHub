//! The worker's half of the session heartbeat (#3140).
//!
//! The reader tests run in paused tokio time over an in-memory duplex that plays
//! the daemon, so the probe interval and the reap bound elapse instantly and
//! exactly. The last test drives a real `DaemonClient::connect` to check what
//! the worker advertises in its handshake.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::DuplexStream;
use tokio::sync::Mutex;
use tokio::time::Instant;

use super::super::*;
use super::recording_exit_hook;
use crate::daemon::heartbeat::{HEARTBEAT_MAX_MISSED, HEARTBEAT_REAP_BOUND};

/// A simulated day.
const LONG_IDLE: Duration = Duration::from_secs(24 * 60 * 60);

type NotificationRx = tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>;

/// A worker-side connection to a simulated daemon: the reader and writer the
/// client holds, plus the daemon's end of the duplex.
struct Harness {
    reader: BoxedReader,
    writer: DaemonWriterHandle,
    daemon: DuplexStream,
}

fn harness() -> Harness {
    let (client_sock, daemon) = tokio::io::duplex(64 * 1024);
    let (read_half, write_half) = tokio::io::split(client_sock);
    let writer: BoxedWriter = Box::new(write_half);
    Harness {
        reader: Box::new(read_half),
        writer: Arc::new(Mutex::new(Some(writer))),
        daemon,
    }
}

/// Run the client reader with `negotiated` heartbeat support on a task; the
/// returned flag flips once the reader tears the session down.
fn spawn_reader(
    reader: BoxedReader,
    writer: DaemonWriterHandle,
    negotiated: bool,
) -> (Arc<AtomicBool>, Arc<AtomicBool>, NotificationRx) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (on_exit, ran) = recording_exit_hook();
    let alive = Arc::new(AtomicBool::new(true));
    let alive_for_task = alive.clone();
    tokio::spawn(async move {
        reader_loop_with_heartbeat(reader, writer, negotiated, &tx, &alive_for_task, on_exit).await;
    });
    (alive, ran, rx)
}

/// Read every frame already sitting in the daemon's end, without waiting.
async fn drain_frames(daemon: &mut DuplexStream) -> Vec<protocol::Frame> {
    let mut frames = Vec::new();
    while let Ok(Ok(Some(frame))) =
        tokio::time::timeout(Duration::from_millis(1), protocol::read_frame_async(daemon)).await
    {
        frames.push(frame);
    }
    frames
}

/// A daemon that advertised heartbeat support and then went fully silent is
/// failed at exactly the reap bound — the session is marked dead and the exit
/// hook runs, so reconnect / redrive takes over — after one ping per interval.
#[tokio::test(start_paused = true)]
async fn a_silent_heartbeat_daemon_is_failed_within_the_bound() {
    let Harness {
        reader,
        writer,
        mut daemon,
    } = harness();
    let (alive, ran, _rx) = spawn_reader(reader, writer, true);

    let start = Instant::now();
    while !ran.load(Ordering::SeqCst) {
        assert!(
            start.elapsed() <= HEARTBEAT_REAP_BOUND * 4,
            "the wedge was never detected"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let elapsed = start.elapsed();

    assert!(
        elapsed >= HEARTBEAT_REAP_BOUND && elapsed <= HEARTBEAT_REAP_BOUND + Duration::from_secs(1),
        "reaped after {elapsed:?}, bound is {HEARTBEAT_REAP_BOUND:?}"
    );
    assert!(
        !alive.load(Ordering::SeqCst),
        "the wedged session is marked dead"
    );
    let pings = drain_frames(&mut daemon).await;
    assert_eq!(pings.len(), HEARTBEAT_MAX_MISSED as usize);
    assert!(pings
        .iter()
        .all(|f| f.msg_type == MSG_PING && f.payload.is_empty()));
}

/// A pre-heartbeat daemon (support not negotiated) is never pinged and never
/// failed, however long the session idles — the agent-binary-swap case.
#[tokio::test(start_paused = true)]
async fn a_pre_heartbeat_daemon_is_never_pinged_or_failed() {
    let Harness {
        reader,
        writer,
        mut daemon,
    } = harness();
    let (alive, ran, _rx) = spawn_reader(reader, writer, false);

    tokio::time::sleep(LONG_IDLE).await;

    assert!(
        alive.load(Ordering::SeqCst),
        "a legacy idle session stays up"
    );
    assert!(!ran.load(Ordering::SeqCst));
    assert!(drain_frames(&mut daemon).await.is_empty(), "no pings sent");
}

/// An idle heartbeat daemon that answers every ping keeps the session for a
/// day, and its pongs never surface as terminal output.
#[tokio::test(start_paused = true)]
async fn an_idle_daemon_that_answers_pings_keeps_the_session() {
    let Harness {
        reader,
        writer,
        daemon,
    } = harness();
    let (alive, ran, mut rx) = spawn_reader(reader, writer, true);

    let (mut daemon_read, mut daemon_write) = tokio::io::split(daemon);
    let answered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let answered_for_task = answered.clone();
    tokio::spawn(async move {
        while let Ok(Some(frame)) = protocol::read_frame_async(&mut daemon_read).await {
            if frame.msg_type == MSG_PING {
                protocol::write_frame_async(&mut daemon_write, MSG_PONG, &[])
                    .await
                    .unwrap();
                answered_for_task.fetch_add(1, Ordering::SeqCst);
            }
        }
    });

    tokio::time::sleep(LONG_IDLE).await;

    assert!(
        alive.load(Ordering::SeqCst),
        "a healthy idle session stays up"
    );
    assert!(!ran.load(Ordering::SeqCst));
    assert!(
        answered.load(Ordering::SeqCst) > 0,
        "the idle daemon was pinged"
    );
    assert!(
        rx.try_recv().is_err(),
        "pongs are never forwarded as output"
    );
}

/// The daemon's probe is answered with a bare pong and produces no output
/// notification — whether or not this connection arms its own reaping.
#[tokio::test(start_paused = true)]
async fn a_daemon_ping_is_answered_with_a_pong_and_no_output() {
    let Harness {
        reader,
        writer,
        mut daemon,
    } = harness();
    let (alive, _ran, mut rx) = spawn_reader(reader, writer, false);

    protocol::write_frame_async(&mut daemon, MSG_DAEMON_PING, &[])
        .await
        .unwrap();
    let reply = tokio::time::timeout(
        Duration::from_secs(5),
        protocol::read_frame_async(&mut daemon),
    )
    .await
    .expect("the worker answers the probe")
    .unwrap()
    .expect("a reply frame");

    assert_eq!(reply.msg_type, MSG_AGENT_PONG);
    assert!(reply.payload.is_empty());
    assert!(alive.load(Ordering::SeqCst));
    assert!(rx.try_recv().is_err(), "a probe has no output side effect");
}

/// A real connect advertises heartbeat support right after its attach intent,
/// so a heartbeat-aware daemon can arm its own reaping of this worker.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_advertises_heartbeat_after_the_attach_intent() {
    let session_id = super::unique_session_id("itest-3140-caps");
    let endpoint = transport::session_endpoint(&session_id);
    let mut listener = transport::DaemonListener::bind(&endpoint)
        .await
        .expect("bind mock daemon");

    let server = tokio::spawn(async move {
        let (mut reader, mut writer) = listener.accept().await.expect("accept");
        let intent = protocol::read_frame_async(&mut reader)
            .await
            .unwrap()
            .expect("intent");
        assert_eq!(intent.msg_type, MSG_ATTACH_INTENT);
        let caps = protocol::read_frame_async(&mut reader)
            .await
            .unwrap()
            .expect("worker capabilities");
        assert_eq!(caps.msg_type, MSG_AGENT_CAPABILITIES);
        assert_ne!(caps.payload[0] & CAP_HEARTBEAT, 0);
        protocol::write_frame_async(&mut writer, MSG_READY, &[])
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        listener.cleanup();
    });

    let client = DaemonClient::connect(session_id, endpoint, super::make_notification_tx())
        .await
        .expect("connect completes");
    assert!(client.is_alive());
    server.await.expect("mock daemon task");
}
