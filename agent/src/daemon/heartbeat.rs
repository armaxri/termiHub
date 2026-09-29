//! Application-level heartbeat for the session-daemon frame protocol (#3140).
//!
//! The session transport is a Unix domain socket / Windows named pipe, so there
//! is no TCP keepalive, and the steady-state reads deliberately wait unbounded
//! for a frame's first byte (#3015) so a shell parked at a prompt for hours is
//! never torn down. That leaves one class of wedge undetectable: a peer that is
//! still connected but has gone **fully silent** (process hung, sends nothing).
//!
//! This module closes that gap without touching the idle guarantee:
//!
//! - After [`HEARTBEAT_INTERVAL`] of receive silence the reader asks its caller
//!   to send a probe (the agent sends [`MSG_PING`], the daemon sends
//!   [`MSG_DAEMON_PING`]); the peer answers with a pong that carries no output.
//! - **Any** received byte counts as liveness — a pong, output, or a slice of a
//!   16 MiB buffer replay still in transit — so a busy peer is never probed into
//!   a reap, and an idle-but-healthy peer keeps itself alive by answering.
//! - A further probe goes out every [`HEARTBEAT_INTERVAL`] while the silence
//!   lasts. After [`HEARTBEAT_MAX_MISSED`] unanswered probes, and one more
//!   interval for the last of them, the peer is declared wedged: the read fails
//!   with [`io::ErrorKind::TimedOut`] and the caller tears the connection down
//!   exactly as it does for any other read error.
//!
//! Reaping is only ever armed when **both** sides advertised [`CAP_HEARTBEAT`]
//! (see [`negotiated`]). A pre-heartbeat daemon or worker — the normal case for
//! a moment after an agent binary swap — never answers probes, so it must never
//! be probed into a reap; with no negotiated support the reader behaves exactly
//! as before this module existed.
//!
//! [`MSG_PING`]: super::protocol::MSG_PING
//! [`MSG_DAEMON_PING`]: super::protocol::MSG_DAEMON_PING

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, ReadBuf};
use tokio::time::Instant;

use super::protocol::{self, Frame, CAP_HEARTBEAT};

/// Receive silence after which a probe is sent, and the spacing between probes
/// while the silence lasts.
///
/// Both peers sit on the same host behind a local socket, where a round trip is
/// well under a millisecond. 15 s keeps an idle session's cost negligible (one
/// 5-byte frame each way per 15 s, and none at all while any traffic flows)
/// while giving a wedge a detection bound of about a minute.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// Unanswered probes tolerated before the peer is declared wedged.
///
/// With [`HEARTBEAT_INTERVAL`] this lets a pong arrive up to 60 s after the
/// first probe — four full probe rounds — which absorbs a heavily loaded or
/// swapping machine (scheduler stalls there are seconds, not a minute) and a
/// daemon event loop briefly busy writing a large frame elsewhere.
pub const HEARTBEAT_MAX_MISSED: u32 = 4;

/// The detection bound: a peer that has sent nothing for this long, despite
/// [`HEARTBEAT_MAX_MISSED`] probes, is reaped. Equal to
/// `HEARTBEAT_INTERVAL * (HEARTBEAT_MAX_MISSED + 1)` = 75 s after the last byte
/// received.
pub const HEARTBEAT_REAP_BOUND: Duration =
    Duration::from_secs(HEARTBEAT_INTERVAL.as_secs() * (HEARTBEAT_MAX_MISSED as u64 + 1));

/// Whether heartbeat-based reaping may be armed, given the capability flags the
/// **peer** advertised. This side always answers probes, so support is
/// negotiated exactly when the peer advertised [`CAP_HEARTBEAT`] too.
pub fn negotiated(peer_flags: u8) -> bool {
    peer_flags & CAP_HEARTBEAT != 0
}

/// Per-connection heartbeat state: when a byte last arrived, and how many probes
/// have gone unanswered since.
#[derive(Debug)]
pub struct Heartbeat {
    /// Reference point for [`last_rx`](Self::last_rx).
    base: Instant,
    /// When a byte last arrived, as nanoseconds after `base`. Atomic so the
    /// reader wrapper can stamp it while the watchdog holds `&mut self` fields.
    last_rx: AtomicU64,
    /// The silence the watchdog is currently counting probes against.
    watch: Watch,
}

impl Heartbeat {
    /// Fresh state for a newly-negotiated connection: the peer counts as having
    /// just been heard from.
    pub fn new() -> Self {
        let base = Instant::now();
        Self {
            base,
            last_rx: AtomicU64::new(0),
            watch: Watch {
                since: base,
                missed: 0,
            },
        }
    }
}

impl Default for Heartbeat {
    fn default() -> Self {
        Self::new()
    }
}

/// What the watchdog decided at a deadline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// Something arrived since the silence began: start counting afresh.
    Alive,
    /// Another interval of silence: send a probe.
    Probe,
    /// Every probe went unanswered: the peer is wedged.
    Dead,
}

/// Counts probes against one stretch of silence.
#[derive(Debug)]
struct Watch {
    /// When the silence being counted began (the last byte received).
    since: Instant,
    /// Probes sent since `since` without anything arriving.
    missed: u32,
}

impl Watch {
    /// When the next probe (or the reap) is due.
    fn deadline(&self) -> Instant {
        self.since + HEARTBEAT_INTERVAL * (self.missed + 1)
    }

    /// Decide at the deadline, given when a byte last arrived.
    fn on_deadline(&mut self, last_rx: Instant) -> Verdict {
        if last_rx > self.since {
            self.since = last_rx;
            self.missed = 0;
            return Verdict::Alive;
        }
        self.missed += 1;
        if self.missed > HEARTBEAT_MAX_MISSED {
            Verdict::Dead
        } else {
            Verdict::Probe
        }
    }
}

/// An [`AsyncRead`] that stamps every received byte as liveness.
///
/// Byte-level rather than frame-level so a large frame still in transit — a
/// 16 MiB buffer replay arriving over tens of seconds — keeps its peer alive.
struct ActivityReader<'a, R: ?Sized> {
    inner: &'a mut R,
    base: Instant,
    last_rx: &'a AtomicU64,
}

impl<R: AsyncRead + Unpin + ?Sized> AsyncRead for ActivityReader<'_, R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let poll = Pin::new(&mut *self.inner).poll_read(cx, buf);
        if matches!(poll, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            let nanos = u64::try_from(self.base.elapsed().as_nanos()).unwrap_or(u64::MAX);
            self.last_rx.store(nanos, Ordering::Relaxed);
        }
        poll
    }
}

/// Read the next session frame, driving the heartbeat while waiting for it.
///
/// With `heartbeat` = `None` (support not negotiated) this is exactly
/// [`protocol::read_session_frame_timeout`]: no probes, no reaping. Otherwise
/// `send_ping` is called whenever a probe is due — it must not block (callers
/// hand the write to another task) — and the read fails with
/// [`io::ErrorKind::TimedOut`] once the peer has been silent for
/// [`HEARTBEAT_REAP_BOUND`].
///
/// The frame read in progress is never cancelled by a probe, so a frame that
/// is mid-transit when a probe fires completes intact.
pub async fn read_frame_with_heartbeat<R, F>(
    reader: &mut R,
    heartbeat: Option<&mut Heartbeat>,
    mut send_ping: F,
) -> io::Result<Option<Frame>>
where
    R: AsyncRead + Unpin + ?Sized,
    F: FnMut(),
{
    let Some(Heartbeat {
        base,
        last_rx,
        watch,
    }) = heartbeat
    else {
        return protocol::read_session_frame_timeout(reader).await;
    };
    let base = *base;
    let last_rx: &AtomicU64 = last_rx;
    let mut tracked = ActivityReader {
        inner: reader,
        base,
        last_rx,
    };
    let read = protocol::read_session_frame_timeout(&mut tracked);
    tokio::pin!(read);
    loop {
        tokio::select! {
            // A frame (or its bytes) wins a tie with the deadline.
            biased;
            result = &mut read => return result,
            () = tokio::time::sleep_until(watch.deadline()) => {
                let last = base + Duration::from_nanos(last_rx.load(Ordering::Relaxed));
                match watch.on_deadline(last) {
                    Verdict::Alive => {}
                    Verdict::Probe => send_ping(),
                    Verdict::Dead => {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!(
                                "peer missed {HEARTBEAT_MAX_MISSED} heartbeats \
                                 ({HEARTBEAT_REAP_BOUND:?} of silence)"
                            ),
                        ));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
