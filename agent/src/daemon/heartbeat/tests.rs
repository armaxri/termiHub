//! Heartbeat behaviour, driven deterministically in paused tokio time (#3140).
//!
//! Every test runs with `start_paused = true`, so the probe interval, the reap
//! bound and the peers' delays elapse in virtual time: the tests are instant and
//! their timing assertions are exact rather than racy.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::*;
use crate::daemon::protocol::{
    write_frame_async, CAP_FILES, CAP_HEARTBEAT, CAP_MONITORING, CAP_PROCESSES, MSG_BUFFER_REPLAY,
    MSG_PONG,
};

/// A simulated day — far longer than any probe interval or reap bound.
const LONG_IDLE: Duration = Duration::from_secs(24 * 60 * 60);

/// The largest legitimate session frame (a full ring-buffer replay).
const MAX_FRAME: usize = 16 * 1024 * 1024;

/// A peer that answers every probe with a pong after `delay` — a healthy peer on
/// a machine whose scheduler is slow by `delay`. Each probe gets its own reply,
/// so replies pipeline exactly as they would from a real, merely-slow daemon.
fn spawn_responder(peer: DuplexStream, delay: Duration) -> mpsc::UnboundedSender<()> {
    let (ping_tx, mut ping_rx) = mpsc::unbounded_channel::<()>();
    let (pong_tx, mut pong_rx) = mpsc::unbounded_channel::<()>();
    tokio::spawn(async move {
        while ping_rx.recv().await.is_some() {
            let pong_tx = pong_tx.clone();
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                let _ = pong_tx.send(());
            });
        }
    });
    tokio::spawn(async move {
        let mut peer = peer;
        while pong_rx.recv().await.is_some() {
            if write_frame_async(&mut peer, MSG_PONG, &[]).await.is_err() {
                return;
            }
        }
    });
    ping_tx
}

/// Read frames with the heartbeat armed until the read fails or `limit`
/// elapses. Returns the failure (if any) and how many pongs were received.
async fn read_until_failure_or(
    local: &mut DuplexStream,
    ping_tx: &mpsc::UnboundedSender<()>,
    limit: Duration,
) -> (Option<io::Error>, usize) {
    let mut heartbeat = Heartbeat::new();
    let pongs = AtomicUsize::new(0);
    let run = async {
        loop {
            match read_frame_with_heartbeat(local, Some(&mut heartbeat), || {
                let _ = ping_tx.send(());
            })
            .await
            {
                Ok(Some(frame)) => {
                    assert_eq!(frame.msg_type, MSG_PONG, "only pongs are sent");
                    pongs.fetch_add(1, Ordering::SeqCst);
                }
                Ok(None) => panic!("the peer never closes the connection"),
                Err(e) => return e,
            }
        }
    };
    let failure = tokio::time::timeout(limit, run).await.ok();
    (failure, pongs.load(Ordering::SeqCst))
}

/// Support is negotiated only when the peer advertised [`CAP_HEARTBEAT`]: every
/// other flag combination — including a pre-heartbeat daemon that serves all of
/// the older optional features — leaves reaping unarmed.
#[test]
fn heartbeat_is_negotiated_only_when_the_peer_advertises_it() {
    assert!(negotiated(CAP_HEARTBEAT));
    assert!(negotiated(CAP_HEARTBEAT | CAP_PROCESSES | CAP_FILES));
    assert!(!negotiated(0));
    assert!(!negotiated(CAP_PROCESSES | CAP_MONITORING | CAP_FILES));
}

/// The reap bound is exactly `interval * (max_missed + 1)`, and it leaves a
/// generous pong tolerance of at least a minute after the first probe.
#[test]
fn the_reap_bound_matches_the_interval_and_miss_count() {
    assert_eq!(
        HEARTBEAT_REAP_BOUND,
        HEARTBEAT_INTERVAL * (HEARTBEAT_MAX_MISSED + 1)
    );
    assert!(HEARTBEAT_REAP_BOUND - HEARTBEAT_INTERVAL >= Duration::from_secs(60));
}

/// A peer that is connected but fully silent — sends no bytes at all and never
/// answers a probe — is reaped at exactly [`HEARTBEAT_REAP_BOUND`], after
/// exactly [`HEARTBEAT_MAX_MISSED`] probes.
#[tokio::test(start_paused = true)]
async fn a_fully_silent_wedged_peer_is_reaped_within_the_bound() {
    let (peer, mut local) = tokio::io::duplex(64 * 1024);
    let mut heartbeat = Heartbeat::new();
    let mut probes = 0u32;

    let start = Instant::now();
    let err = read_frame_with_heartbeat(&mut local, Some(&mut heartbeat), || probes += 1)
        .await
        .expect_err("a fully silent peer must be reaped");
    let elapsed = start.elapsed();

    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        elapsed, HEARTBEAT_REAP_BOUND,
        "the wedge is detected exactly at the stated bound"
    );
    assert_eq!(
        probes, HEARTBEAT_MAX_MISSED,
        "one probe per silent interval"
    );
    drop(peer); // the peer stayed connected throughout
}

/// An idle-but-healthy peer — no traffic of its own, but it answers every
/// probe — is never reaped over a simulated day.
#[tokio::test(start_paused = true)]
async fn an_idle_peer_that_answers_probes_is_never_reaped() {
    let (peer, mut local) = tokio::io::duplex(64 * 1024);
    let ping_tx = spawn_responder(peer, Duration::ZERO);

    let (failure, pongs) = read_until_failure_or(&mut local, &ping_tx, LONG_IDLE).await;

    assert!(
        failure.is_none(),
        "an idle peer that answers must never be reaped, got: {failure:?}"
    );
    // One probe per quiet interval, answered each time.
    let expected = (LONG_IDLE.as_secs() / HEARTBEAT_INTERVAL.as_secs()) as usize;
    assert!(
        pongs + 1 >= expected,
        "the idle peer was probed every interval ({pongs} pongs, expected ~{expected})"
    );
}

/// A peer that does not understand the heartbeat (support not negotiated) is
/// never probed and never reaped, however long it stays silent — exactly the
/// pre-#3140 idle behaviour.
#[tokio::test(start_paused = true)]
async fn a_peer_without_heartbeat_support_is_never_probed_or_reaped() {
    let (peer, mut local) = tokio::io::duplex(64 * 1024);
    let mut probes = 0u32;

    let read = read_frame_with_heartbeat(&mut local, None, || probes += 1);
    let outcome = tokio::time::timeout(LONG_IDLE, read).await;

    assert!(
        outcome.is_err(),
        "a silent pre-heartbeat peer must stay parked, got: {outcome:?}"
    );
    assert_eq!(
        probes, 0,
        "a peer that never agreed to heartbeats is not probed"
    );
    drop(peer);
}

/// A 16 MiB frame whose bytes are still trickling in when the reap bound would
/// otherwise pass counts as liveness: the peer went quiet for most of the bound
/// (busy building the frame), then streamed it for longer than the remaining
/// window. The frame must arrive intact and nothing may be reaped.
#[tokio::test(start_paused = true)]
async fn a_large_frame_in_transit_is_liveness() {
    const CHUNK: usize = 64 * 1024;
    // Silent for 60 s (four probes, none answered), then 25 s of streaming: the
    // frame completes 85 s after the last byte before it — past the 75 s bound
    // measured from silence alone, yet within the 30 s mid-frame window.
    let quiet = Duration::from_secs(60);
    let transit = Duration::from_secs(25);
    assert!(quiet < HEARTBEAT_REAP_BOUND && quiet + transit > HEARTBEAT_REAP_BOUND);

    let (mut peer, mut local) = tokio::io::duplex(CHUNK);
    let payload: Arc<Vec<u8>> = Arc::new((0..MAX_FRAME).map(|i| (i % 251) as u8).collect());
    let sent = payload.clone();
    let writer = tokio::spawn(async move {
        tokio::time::sleep(quiet).await;
        let mut header = [0u8; 5];
        header[0] = MSG_BUFFER_REPLAY;
        header[1..5].copy_from_slice(&(MAX_FRAME as u32).to_be_bytes());
        peer.write_all(&header).await.unwrap();
        let chunks = MAX_FRAME / CHUNK;
        let gap = transit / chunks as u32;
        for chunk in sent.chunks(CHUNK) {
            peer.write_all(chunk).await.unwrap();
            tokio::time::sleep(gap).await;
        }
        peer
    });

    let mut heartbeat = Heartbeat::new();
    let start = Instant::now();
    let frame = read_frame_with_heartbeat(&mut local, Some(&mut heartbeat), || {})
        .await
        .expect("a frame in transit must not be reaped")
        .expect("the frame arrives");

    assert!(start.elapsed() > HEARTBEAT_REAP_BOUND);
    assert_eq!(frame.msg_type, MSG_BUFFER_REPLAY);
    assert_eq!(frame.payload.len(), MAX_FRAME);
    assert!(frame.payload == *payload, "the 16 MiB frame arrives intact");
    let _peer = writer.await.unwrap();
}

/// Load / jitter: every pong arrives 50 s late — a heavily loaded machine — but
/// inside the 60 s tolerance after the first probe. Over a simulated day the
/// peer is never reaped.
#[tokio::test(start_paused = true)]
async fn a_pong_delayed_inside_the_tolerance_is_not_reaped() {
    let tolerance = HEARTBEAT_REAP_BOUND - HEARTBEAT_INTERVAL;
    let delay = Duration::from_secs(50);
    assert!(delay < tolerance);

    let (peer, mut local) = tokio::io::duplex(64 * 1024);
    let ping_tx = spawn_responder(peer, delay);

    let (failure, pongs) = read_until_failure_or(&mut local, &ping_tx, LONG_IDLE).await;

    assert!(
        failure.is_none(),
        "a late-but-inside-tolerance pong must not reap the peer, got: {failure:?}"
    );
    assert!(pongs > 0, "the slow peer's pongs were received");
}

/// The other side of the tolerance: a pong that would arrive 65 s after the
/// first probe — later than the bound allows — is too late, and the peer is
/// reaped at the bound.
#[tokio::test(start_paused = true)]
async fn a_pong_delayed_past_the_tolerance_is_reaped_at_the_bound() {
    let tolerance = HEARTBEAT_REAP_BOUND - HEARTBEAT_INTERVAL;
    let delay = tolerance + Duration::from_secs(5);

    let (peer, mut local) = tokio::io::duplex(64 * 1024);
    let ping_tx = spawn_responder(peer, delay);

    let start = Instant::now();
    let (failure, pongs) = read_until_failure_or(&mut local, &ping_tx, LONG_IDLE).await;

    let err = failure.expect("a peer that answers too late is reaped");
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(start.elapsed(), HEARTBEAT_REAP_BOUND);
    assert_eq!(pongs, 0);
}

/// Traffic resets the count: a peer that sends one frame just before the bound
/// is not reaped at the original deadline, but a full bound after that frame.
#[tokio::test(start_paused = true)]
async fn any_frame_restarts_the_silence_clock() {
    let (mut peer, mut local) = tokio::io::duplex(64 * 1024);
    let late = HEARTBEAT_REAP_BOUND - Duration::from_secs(1);
    let writer = tokio::spawn(async move {
        tokio::time::sleep(late).await;
        write_frame_async(&mut peer, MSG_PONG, &[]).await.unwrap();
        peer
    });

    let mut heartbeat = Heartbeat::new();
    let start = Instant::now();
    let first = read_frame_with_heartbeat(&mut local, Some(&mut heartbeat), || {})
        .await
        .expect("the frame arrives before the bound")
        .expect("a frame");
    assert_eq!(first.msg_type, MSG_PONG);
    assert_eq!(start.elapsed(), late);

    let err = read_frame_with_heartbeat(&mut local, Some(&mut heartbeat), || {})
        .await
        .expect_err("silence after the frame is reaped");
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(start.elapsed(), late + HEARTBEAT_REAP_BOUND);

    let mut peer = writer.await.unwrap();
    // Nothing else was ever written by us into the duplex (probes go through
    // the caller's closure), so the peer side has nothing to read.
    let mut buf = [0u8; 1];
    let nothing = tokio::time::timeout(Duration::from_millis(1), peer.read(&mut buf)).await;
    assert!(nothing.is_err());
}
