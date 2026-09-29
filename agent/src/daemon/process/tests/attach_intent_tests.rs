//! The newcomer's attach intent is read off the daemon loop (#3928).
//!
//! A worker that connects while another worker holds the session declares
//! whether it is recovering (refuse it, AGT-015) or taking over (evict the
//! holder). These drive the real `daemon_loop` in paused tokio time over
//! in-memory connections, so a newcomer that is slow to declare its intent is
//! exactly and deterministically slow: the loop must keep serving the holder
//! meanwhile, and a late recovery intent must never be misread as a takeover.

use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::time::Instant;

use super::super::ATTACH_INTENT_TIMEOUT;
use super::write_bound_tests::{spawn_daemon, Attach, Worker, PROMPT};
use crate::daemon::protocol::{
    self, Frame, INTENT_RECOVERY, INTENT_TAKEOVER, MSG_DETACH, MSG_EVICTED, MSG_OUTPUT,
};

/// Longer than the historical inline bound (2 s) that misread a descheduled
/// recovery worker as a takeover — the kind of stall seen on loaded CI.
const DESCHEDULED: Duration = Duration::from_secs(3);

/// Let the loop take everything already queued for it (the accept of a
/// connection just handed over, output just sent).
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// The holder's next frame within `within`, or `None` if nothing arrived.
async fn next_frame(worker: &mut Worker, within: Duration) -> Option<Frame> {
    tokio::time::timeout(within, protocol::read_frame_async(&mut worker.reader))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
}

/// A holder attached with a takeover connect, as the first worker is.
async fn attach_holder(daemon: &super::write_bound_tests::Daemon) -> Worker {
    let mut holder = Worker::connect(daemon, INTENT_TAKEOVER).await;
    assert_eq!(holder.handshake().await, Some(Attach::Ready(Vec::new())));
    holder
}

/// The holder still owns the session: output reaches it at once.
async fn assert_holder_live(daemon: &super::write_bound_tests::Daemon, holder: &mut Worker) {
    daemon.output.send(b"still-mine".to_vec()).await.unwrap();
    let frame = next_frame(holder, Duration::from_millis(100))
        .await
        .expect("the holder keeps receiving output");
    assert_eq!(frame.msg_type, MSG_OUTPUT, "the holder was not evicted");
    assert_eq!(frame.payload, b"still-mine");
}

/// A recovery worker descheduled between connecting and writing its intent is
/// refused when the intent finally arrives: the live holder is never evicted.
#[tokio::test(start_paused = true)]
async fn a_slow_recovery_intent_is_not_misread_as_a_takeover() {
    assert!(
        DESCHEDULED < ATTACH_INTENT_TIMEOUT,
        "the intent bound must tolerate a descheduled recovery worker"
    );
    let daemon = spawn_daemon();
    let mut holder = attach_holder(&daemon).await;

    let mut slow = Worker::connect_silent(&daemon);
    settle().await;
    tokio::time::sleep(DESCHEDULED).await;
    assert!(
        next_frame(&mut holder, Duration::ZERO).await.is_none(),
        "nothing — least of all an eviction — reaches the holder while the newcomer is silent"
    );
    slow.send_intent(INTENT_RECOVERY).await;

    assert_eq!(slow.handshake().await, Some(Attach::Refused));
    assert_holder_live(&daemon, &mut holder).await;
    daemon.task.abort();
}

/// Right up to the bound, a late recovery intent is still honoured.
#[tokio::test(start_paused = true)]
async fn a_recovery_intent_just_inside_the_bound_is_refused() {
    let daemon = spawn_daemon();
    let mut holder = attach_holder(&daemon).await;

    let mut slow = Worker::connect_silent(&daemon);
    settle().await;
    tokio::time::sleep(ATTACH_INTENT_TIMEOUT - Duration::from_millis(50)).await;
    slow.send_intent(INTENT_RECOVERY).await;

    assert_eq!(slow.handshake().await, Some(Attach::Refused));
    assert_holder_live(&daemon, &mut holder).await;
    daemon.task.abort();
}

/// While a newcomer has yet to declare its intent, the loop keeps forwarding
/// the holder's output and keeps serving other connections.
#[tokio::test(start_paused = true)]
async fn the_loop_keeps_serving_while_a_newcomer_is_pending() {
    let daemon = spawn_daemon();
    let mut holder = attach_holder(&daemon).await;

    let mut pending = Worker::connect_silent(&daemon);
    settle().await;

    // Output flows to the holder promptly, many times over, while pending.
    for i in 0..10u8 {
        daemon.output.send(vec![i; 16]).await.unwrap();
        let frame = next_frame(&mut holder, Duration::from_millis(100))
            .await
            .expect("output is forwarded while a newcomer is pending");
        assert_eq!(frame.msg_type, MSG_OUTPUT);
        assert_eq!(frame.payload, vec![i; 16]);
    }

    // Another connect is answered promptly, too.
    let start = Instant::now();
    let mut other = Worker::connect(&daemon, INTENT_RECOVERY).await;
    assert_eq!(other.handshake().await, Some(Attach::Refused));
    assert!(start.elapsed() < Duration::from_millis(100));

    // The pending newcomer is still decided on its own intent.
    pending.send_intent(INTENT_RECOVERY).await;
    assert_eq!(pending.handshake().await, Some(Attach::Refused));
    assert_holder_live(&daemon, &mut holder).await;
    daemon.task.abort();
}

/// A pre-AGT-015 worker never declares an intent: after the bound it still
/// takes the session over, as before, and the holder is told it was evicted.
#[tokio::test(start_paused = true)]
async fn a_legacy_worker_that_sends_no_intent_takes_over_after_the_bound() {
    let daemon = spawn_daemon();
    let mut holder = attach_holder(&daemon).await;

    let mut legacy = Worker::connect_silent(&daemon);
    let start = Instant::now();
    settle().await;
    tokio::time::sleep(ATTACH_INTENT_TIMEOUT - Duration::from_millis(50)).await;
    assert_holder_live(&daemon, &mut holder).await;

    let attached = legacy.handshake().await;
    assert!(
        matches!(attached, Some(Attach::Ready(_))),
        "a legacy worker takes over: {attached:?}"
    );
    let elapsed = start.elapsed();
    assert!(
        elapsed >= ATTACH_INTENT_TIMEOUT,
        "not before the bound: {elapsed:?}"
    );
    assert!(
        elapsed <= ATTACH_INTENT_TIMEOUT + Duration::from_millis(100),
        "promptly at the bound: {elapsed:?}"
    );

    let evicted = next_frame(&mut holder, PROMPT)
        .await
        .expect("the holder hears it was evicted");
    assert_eq!(evicted.msg_type, MSG_EVICTED);
    let mut rest = Vec::new();
    tokio::time::timeout(PROMPT, holder.reader.read_to_end(&mut rest))
        .await
        .expect("the evicted holder's connection is closed")
        .unwrap();
    daemon.task.abort();
}

/// A late takeover intent evicts only once it arrives — not at some earlier
/// timeout — and the newcomer attaches.
#[tokio::test(start_paused = true)]
async fn a_slow_takeover_intent_evicts_when_it_arrives() {
    let daemon = spawn_daemon();
    let mut holder = attach_holder(&daemon).await;

    let mut slow = Worker::connect_silent(&daemon);
    settle().await;
    tokio::time::sleep(DESCHEDULED).await;
    assert_holder_live(&daemon, &mut holder).await;
    slow.send_intent(INTENT_TAKEOVER).await;

    assert!(matches!(slow.handshake().await, Some(Attach::Ready(_))));
    let evicted = next_frame(&mut holder, PROMPT)
        .await
        .expect("the holder hears it was evicted");
    assert_eq!(evicted.msg_type, MSG_EVICTED);
    daemon.task.abort();
}

/// The decision is taken against the session as it is when the intent
/// arrives: if the holder left meanwhile, a recovery connect simply attaches.
#[tokio::test(start_paused = true)]
async fn a_pending_recovery_attaches_if_the_holder_left_meanwhile() {
    let daemon = spawn_daemon();
    let mut holder = attach_holder(&daemon).await;

    let mut pending = Worker::connect_silent(&daemon);
    settle().await;
    protocol::write_frame_async(&mut holder.writer, MSG_DETACH, &[])
        .await
        .unwrap();
    let mut rest = Vec::new();
    tokio::time::timeout(
        Duration::from_millis(100),
        holder.reader.read_to_end(&mut rest),
    )
    .await
    .expect("the loop serves the detach at once while a newcomer is pending")
    .unwrap();

    pending.send_intent(INTENT_RECOVERY).await;
    assert!(
        matches!(pending.handshake().await, Some(Attach::Ready(_))),
        "an orphaned session is recovered"
    );
    daemon.task.abort();
}
