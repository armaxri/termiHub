//! Credit-window flow control for agent port-forward streams (#4284).
//!
//! A desktop port forward (`agent.forward.connect`, #3241) carries a VNC/RDP
//! TCP stream over the desktop↔agent JSON-RPC link. Without flow control a
//! fast target on the agent's LAN could queue an unbounded backlog of
//! `agent.forward.data` notifications on the agent whenever the desktop link
//! or the desktop's graphical backend is slower.
//!
//! The fix mirrors SSH channel windows: each direction of a stream may have at
//! most a **window** of bytes in flight — sent but not yet acknowledged by the
//! receiver with `agent.forward.ack`. The receiver acknowledges only once it
//! has handed the bytes to their consumer (written them to the socket), so a
//! slow consumer stops the acknowledgements, the sender's credit runs out, and
//! it stops reading its source — the backpressure reaches the remote program
//! through TCP instead of piling up in memory.
//!
//! Both ends share this module so the window size and the credit bookkeeping
//! cannot drift apart: the agent and the desktop each hold one
//! [`ForwardWindow`] per stream for the direction they send in.

use std::sync::Mutex;

use tokio::sync::Notify;

/// Bytes one direction of a port-forward stream may have in flight (sent, not
/// yet acknowledged) — the window the desktop requests in
/// `agent.forward.connect` and the most an agent grants.
///
/// 512 KiB keeps a remote-desktop stream at link speed over a typical WAN
/// round trip (≈10 MiB/s at 50 ms) while bounding what one stream can queue
/// ahead of every other message on the agent link.
pub const AGENT_FORWARD_WINDOW: usize = 512 * 1024;

/// Acknowledge once this many consumed bytes have accumulated. A quarter of the
/// window keeps the sender's credit topped up without an ack per chunk; it is
/// never zero, so every window makes progress.
pub fn ack_threshold(window: usize) -> usize {
    (window / 4).max(1)
}

/// The window an agent grants for a requested one: never more than
/// [`AGENT_FORWARD_WINDOW`], never zero (a zero window could never send).
pub fn grant_window(requested: u64) -> usize {
    usize::try_from(requested)
        .unwrap_or(usize::MAX)
        .clamp(1, AGENT_FORWARD_WINDOW)
}

#[derive(Debug)]
struct State {
    available: usize,
    closed: bool,
}

/// The sender's credit for one direction of a stream: how many more bytes it
/// may send before the receiver acknowledges some.
///
/// The sender awaits [`wait_credit`](Self::wait_credit) before reading its
/// source, reads at most that many bytes, and [`consume`](Self::consume)s what
/// it sent; the receiver's acks [`release`](Self::release) credit again.
/// [`close`](Self::close) wakes a waiting sender for teardown.
#[derive(Debug)]
pub struct ForwardWindow {
    capacity: usize,
    state: Mutex<State>,
    changed: Notify,
}

impl ForwardWindow {
    /// A window with `capacity` bytes of credit, all available.
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            state: Mutex::new(State {
                available: capacity,
                closed: false,
            }),
            changed: Notify::new(),
        }
    }

    /// The window size.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Credit currently available.
    pub fn available(&self) -> usize {
        self.lock().available
    }

    /// Bytes sent and not yet acknowledged.
    pub fn in_flight(&self) -> usize {
        self.capacity - self.available()
    }

    /// Wait until some credit is available and return how much, or `None` once
    /// the window is closed.
    pub async fn wait_credit(&self) -> Option<usize> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            // Register before checking, so a release between the check and the
            // await is not missed.
            changed.as_mut().enable();
            {
                let state = self.lock();
                if state.closed {
                    return None;
                }
                if state.available > 0 {
                    return Some(state.available);
                }
            }
            changed.await;
        }
    }

    /// Spend `n` bytes of credit on data just sent. Saturates at zero: a
    /// sender never sends more than [`wait_credit`](Self::wait_credit) granted.
    pub fn consume(&self, n: usize) {
        let mut state = self.lock();
        state.available = state.available.saturating_sub(n);
    }

    /// Return `n` bytes of credit (the receiver acknowledged them). Never grows
    /// past the window, so a stray or duplicated ack cannot widen it.
    pub fn release(&self, n: usize) {
        {
            let mut state = self.lock();
            state.available = state.available.saturating_add(n).min(self.capacity);
        }
        self.changed.notify_waiters();
    }

    /// Close the window: a waiting sender wakes and sees `None`.
    pub fn close(&self) {
        self.lock().closed = true;
        self.changed.notify_waiters();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn grant_clamps_into_one_to_the_window() {
        assert_eq!(grant_window(0), 1);
        assert_eq!(grant_window(4096), 4096);
        assert_eq!(
            grant_window(u64::from(u32::MAX) * 4),
            AGENT_FORWARD_WINDOW
        );
    }

    #[test]
    fn ack_threshold_is_a_quarter_and_never_zero() {
        assert_eq!(ack_threshold(AGENT_FORWARD_WINDOW), AGENT_FORWARD_WINDOW / 4);
        assert_eq!(ack_threshold(3), 1);
        assert_eq!(ack_threshold(1), 1);
    }

    #[tokio::test]
    async fn credit_is_spent_and_released_within_the_window() {
        let w = ForwardWindow::new(100);
        assert_eq!(w.wait_credit().await, Some(100));
        w.consume(60);
        assert_eq!(w.in_flight(), 60);
        assert_eq!(w.wait_credit().await, Some(40));
        w.release(500);
        assert_eq!(w.available(), 100, "an over-ack never widens the window");
    }

    #[tokio::test]
    async fn an_exhausted_window_waits_for_an_ack() {
        let w = Arc::new(ForwardWindow::new(10));
        w.consume(10);
        let waiter = {
            let w = w.clone();
            tokio::spawn(async move { w.wait_credit().await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiter.is_finished(), "no credit, so the sender must wait");
        w.release(4);
        let got = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("woken by the ack")
            .unwrap();
        assert_eq!(got, Some(4));
    }

    #[tokio::test]
    async fn close_wakes_a_waiting_sender() {
        let w = Arc::new(ForwardWindow::new(1));
        w.consume(1);
        let waiter = {
            let w = w.clone();
            tokio::spawn(async move { w.wait_credit().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        w.close();
        let got = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("woken by close")
            .unwrap();
        assert_eq!(got, None);
    }
}
