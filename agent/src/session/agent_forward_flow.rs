//! Per-stream flow control for desktop port forwards (#4284).
//!
//! A stream the desktop opened with a window (`agent.forward.connect` with
//! `window`, protocol 0.28.0) is bounded in both directions, like an SSH
//! channel:
//!
//! - **agent → desktop**: the target reader waits for credit in
//!   [`StreamFlow::outbound`] before each read and reads at most that much; the
//!   desktop's `agent.forward.ack` requests (sent once it has written the bytes
//!   to its graphical backend) return the credit. A slow canvas therefore stops
//!   the acks, the reader stops reading, and TCP backpressures the remote
//!   desktop server instead of `agent.forward.data` notifications piling up in
//!   the transport queue.
//! - **desktop → agent**: the desktop keeps at most the window unacknowledged;
//!   the agent counts what it holds for the target ([`StreamFlow::admit`]) and
//!   acks each chunk once written ([`StreamFlow::written`]). A desktop that
//!   overruns the window breaks the protocol and has its stream closed rather
//!   than buffered without bound.
//!
//! A stream opened without a window (an older desktop) has no [`StreamFlow`]
//! and is relayed exactly as before.

use std::sync::atomic::{AtomicUsize, Ordering};

use termihub_core::session::forward_window::{grant_window, ForwardWindow};

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::{AgentForwardAckParams, AGENT_FORWARD_ACK};
use crate::transport::to_params;

/// Flow-control state of one windowed stream.
#[derive(Debug)]
pub struct StreamFlow {
    /// Credit for target → desktop bytes.
    outbound: ForwardWindow,
    /// Desktop → target bytes received and not yet written to the target.
    inbound_queued: AtomicUsize,
}

impl StreamFlow {
    /// Flow state for a stream whose desktop requested `requested` bytes; the
    /// window actually granted is [`window`](Self::window).
    pub fn granted(requested: u64) -> Self {
        Self {
            outbound: ForwardWindow::new(grant_window(requested)),
            inbound_queued: AtomicUsize::new(0),
        }
    }

    /// The window granted to both directions.
    pub fn window(&self) -> usize {
        self.outbound.capacity()
    }

    /// The target → desktop credit.
    pub fn outbound(&self) -> &ForwardWindow {
        &self.outbound
    }

    /// The desktop acknowledged `bytes` of target data.
    pub fn ack(&self, bytes: u64) {
        self.outbound
            .release(usize::try_from(bytes).unwrap_or(usize::MAX));
    }

    /// Account `len` desktop bytes about to be queued for the target. `false`
    /// when that would exceed the window — the desktop overran it.
    pub fn admit(&self, len: usize) -> bool {
        let window = self.window();
        self.inbound_queued
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |queued| {
                queued.checked_add(len).filter(|total| *total <= window)
            })
            .is_ok()
    }

    /// `len` queued desktop bytes reached the target: stop counting them and
    /// tell the desktop it may send that much more.
    pub fn written(&self, len: usize, stream_id: &str, notifications: &NotificationSender) {
        self.inbound_queued
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |queued| {
                Some(queued.saturating_sub(len))
            })
            .ok();
        let _ = notifications.send(JsonRpcNotification::new(
            AGENT_FORWARD_ACK,
            to_params(&AgentForwardAckParams {
                stream_id: stream_id.to_string(),
                bytes: len as u64,
            }),
        ));
    }

    /// Teardown: wake a reader parked on an exhausted window.
    pub fn close(&self) {
        self.outbound.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admit_bounds_queued_inbound_bytes_by_the_window() {
        let flow = StreamFlow::granted(100);
        assert!(flow.admit(60));
        assert!(flow.admit(40));
        assert!(!flow.admit(1), "a full window refuses more");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        flow.written(50, "s#1", &tx);
        assert!(flow.admit(50));
        let ack = rx.try_recv().unwrap();
        assert_eq!(ack.method, AGENT_FORWARD_ACK);
        assert_eq!(ack.params["bytes"], 50);
    }

    #[test]
    fn the_granted_window_is_capped() {
        use termihub_core::session::forward_window::AGENT_FORWARD_WINDOW;
        assert_eq!(StreamFlow::granted(u64::MAX).window(), AGENT_FORWARD_WINDOW);
        assert_eq!(StreamFlow::granted(10).window(), 10);
    }
}
