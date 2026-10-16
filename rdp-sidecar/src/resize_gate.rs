//! Display Control resize coordination (#4845).
//!
//! The host asks for a new desktop size (a Match Window tab resize, or the size
//! re-sent right after an automatic reconnect) at any time. Two server-facing
//! hazards make "encode it and write it now" wrong:
//!
//! * **The channel may not be open yet.** The Display Control dynamic channel
//!   opens a moment after activation. A request that arrives before it opens
//!   used to be dropped, so a tab that resized (or reconnected) early never got
//!   the size it asked for. The gate keeps the latest request and sends it as
//!   soon as the channel opens.
//! * **xrdp crashes on a frame acknowledgement during a resize.** xrdp (every
//!   release up to 0.10.4) deletes its encoder when a resize starts and
//!   dereferences it in `xrdp_mm_frame_ack` without a null check, so a Frame
//!   Acknowledge PDU for a frame that was still in flight when the resize began
//!   kills the server's session process (SIGSEGV). Right after logon the server
//!   streams frames, so an early resize hit this almost every time. The gate
//!   withholds frame acknowledgements from sending a layout until the server's
//!   Deactivation-Reactivation Sequence completes. The reactivation resets the
//!   server's frame accounting, so the withheld acks are dropped then; if no
//!   reactivation comes (the server ignored the request), they are flushed after
//!   [`RESIZE_ACK_HOLD`].
//! * **xrdp ignores a request during its logon.** A layout that arrives while
//!   xrdp still connects the session ("Not allowing resize. Login in progress.")
//!   is never applied, and nothing tells the client. An unanswered layout is
//!   therefore re-sent after the hold, up to [`MAX_LAYOUT_ATTEMPTS`] times.
//!
//! While one layout is in flight a newer request waits (latest wins) and goes
//! out after the reactivation, so a burst of tab resizes costs one round trip
//! each instead of queueing reactivations behind each other on the server.

use std::time::Duration;

use termihub_core::connection::MonitorRect;
use tokio::time::Instant;

/// How long frame acknowledgements are withheld after a layout is sent when
/// the server never answers with a Deactivation-Reactivation Sequence (it
/// ignored the request, e.g. the size it already has). xrdp completes a resize
/// in tens of milliseconds, so this only bounds the stall when nothing comes.
pub const RESIZE_ACK_HOLD: Duration = Duration::from_secs(2);

/// How often one layout is sent when the server never answers it.
pub const MAX_LAYOUT_ATTEMPTS: u32 = 3;

/// A layout the host asked for.
#[derive(Debug, Clone, PartialEq)]
pub enum LayoutRequest {
    /// One monitor of this size (already clamped to the MS-RDPEDISP range).
    Size {
        /// Width in pixels.
        width: u32,
        /// Height in pixels.
        height: u32,
    },
    /// A multi-monitor layout (#3696).
    Monitors(Vec<MonitorRect>),
}

/// Holds the latest unsent layout and the in-flight state of a sent one.
#[derive(Debug, Default)]
pub struct ResizeGate {
    pending: Option<LayoutRequest>,
    in_flight_until: Option<Instant>,
    withheld_acks: Vec<Vec<u8>>,
    /// The last layout sent and how many times in a row it went unanswered.
    last_sent: Option<LayoutRequest>,
    attempts: u32,
}

impl ResizeGate {
    /// Record a host request; it replaces any older unsent one.
    pub fn request(&mut self, layout: LayoutRequest) {
        self.pending = Some(layout);
    }

    /// The layout to send now, if one is waiting and none is in flight.
    pub fn take_sendable(&mut self) -> Option<LayoutRequest> {
        if self.in_flight() {
            return None;
        }
        self.pending.take()
    }

    /// Put back a layout that could not be sent (the channel is not open yet),
    /// unless the host asked for a newer one meanwhile.
    pub fn defer(&mut self, layout: LayoutRequest) {
        if self.pending.is_none() {
            self.pending = Some(layout);
        }
    }

    /// `layout` was written to the server at `now`.
    pub fn sent(&mut self, layout: LayoutRequest, now: Instant) {
        self.in_flight_until = Some(now + RESIZE_ACK_HOLD);
        if self.last_sent.as_ref() == Some(&layout) {
            self.attempts += 1;
        } else {
            self.last_sent = Some(layout);
            self.attempts = 1;
        }
    }

    /// Whether a sent layout still awaits the server's reactivation.
    pub fn in_flight(&self) -> bool {
        self.in_flight_until.is_some()
    }

    /// When an unanswered in-flight layout stops withholding acks.
    pub fn deadline(&self) -> Option<Instant> {
        self.in_flight_until
    }

    /// Keep a frame acknowledgement back while a layout is in flight.
    pub fn withhold(&mut self, frame: Vec<u8>) {
        self.withheld_acks.push(frame);
    }

    /// The server completed a Deactivation-Reactivation Sequence: its frame
    /// accounting restarted, so the withheld acks are obsolete.
    pub fn reactivated(&mut self) {
        self.in_flight_until = None;
        self.withheld_acks.clear();
        self.last_sent = None;
        self.attempts = 0;
    }

    /// The hold ran out without a reactivation: stop withholding and return the
    /// acks to send now, oldest first. The unanswered layout is queued again
    /// unless the host asked for a newer one or it has had all its attempts.
    pub fn expire(&mut self) -> Vec<Vec<u8>> {
        self.in_flight_until = None;
        if self.pending.is_none() && self.attempts < MAX_LAYOUT_ATTEMPTS {
            self.pending = self.last_sent.clone();
        }
        std::mem::take(&mut self.withheld_acks)
    }
}

#[cfg(test)]
#[path = "resize_gate_tests.rs"]
mod tests;
