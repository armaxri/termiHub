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
use std::time::Duration;

use tokio::io::AsyncRead;

use super::protocol::{self, Frame};

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
    let _ = peer_flags;
    unimplemented!("#3140")
}

/// Per-connection heartbeat state: when a byte last arrived, and how many probes
/// have gone unanswered since.
#[derive(Debug)]
pub struct Heartbeat {
    _private: (),
}

impl Heartbeat {
    /// Fresh state for a newly-negotiated connection: the peer counts as having
    /// just been heard from.
    pub fn new() -> Self {
        unimplemented!("#3140")
    }
}

impl Default for Heartbeat {
    fn default() -> Self {
        Self::new()
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
    send_ping: F,
) -> io::Result<Option<Frame>>
where
    R: AsyncRead + Unpin + ?Sized,
    F: FnMut(),
{
    let _ = (heartbeat, send_ping);
    protocol::read_session_frame_timeout(reader).await
}

#[cfg(test)]
mod tests;
