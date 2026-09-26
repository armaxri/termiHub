//! Byte budget for the VNC driver's outgoing frame / cursor channels (#3511).
//!
//! The shared [`FrameReceiver`](crate::connection::FrameReceiver) is a plain
//! count-bounded channel (`CHANNEL_DEPTH` updates). One update can carry a
//! 256 MiB dirty rect (8192 x 8192 x 4), and the driver can produce one from a
//! handful of server bytes — a full-screen CopyRect, or a Tight fill — so
//! sixteen queued updates could pin gigabytes while the graphical manager's
//! frame pump is busy emitting.
//!
//! [`ByteBudgetSender`] wraps the driver's sender and waits, before sending,
//! until the bytes still queued plus the new update fit the budget. It never
//! drops an update: the frontend canvas is built from incremental rects, so a
//! dropped one would leave stale pixels. While the driver waits it stops
//! draining the vnc-rs event queue, whose own byte budget then parks the
//! decoder and pushes back on the server over TCP.
//!
//! The channel type is shared with the other graphical backends, so the
//! wrapper infers what the pump has taken from the channel's free capacity
//! (the driver is the only sender) instead of changing the receiver type.

use std::collections::VecDeque;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::connection::{CursorUpdate, FrameUpdate};

/// Decoded frame bytes that may sit in the frame channel at once: one
/// maximum-size (8192 x 8192 x 4) framebuffer update.
pub(super) const MAX_QUEUED_FRAME_BYTES: usize = 256 * 1024 * 1024;

/// Cursor-shape bytes that may sit in the cursor channel at once. Real cursors
/// are a few KiB; a larger one is still delivered, alone.
pub(super) const MAX_QUEUED_CURSOR_BYTES: usize = 16 * 1024 * 1024;

/// How often a sender over budget re-checks whether the consumer has drained.
const DRAIN_POLL: Duration = Duration::from_millis(1);

/// Heap bytes an update pins while it is queued.
pub(super) trait QueuedBytes {
    fn queued_bytes(&self) -> usize;
}

impl QueuedBytes for FrameUpdate {
    fn queued_bytes(&self) -> usize {
        self.rects.iter().map(|r| r.data.len()).sum()
    }
}

impl QueuedBytes for CursorUpdate {
    fn queued_bytes(&self) -> usize {
        self.shape.as_ref().map_or(0, |s| s.data.len())
    }
}

/// A channel sender that bounds the bytes queued in its channel, not only the
/// number of items. Must be the channel's only sender.
pub(super) struct ByteBudgetSender<T> {
    tx: mpsc::Sender<T>,
    budget: usize,
    /// Costs of sent items the consumer may not have taken yet, oldest first.
    in_flight: VecDeque<usize>,
    queued: usize,
}

impl<T: QueuedBytes> ByteBudgetSender<T> {
    pub(super) fn new(tx: mpsc::Sender<T>, budget: usize) -> Self {
        Self {
            tx,
            budget,
            in_flight: VecDeque::new(),
            queued: 0,
        }
    }

    /// Forget the items the consumer has taken since the last call. The
    /// channel is FIFO, so they are the oldest ones.
    fn reconcile(&mut self) {
        let still_queued = self.tx.max_capacity() - self.tx.capacity();
        while self.in_flight.len() > still_queued {
            if let Some(cost) = self.in_flight.pop_front() {
                self.queued -= cost;
            }
        }
    }

    /// Bytes currently queued in the channel.
    #[cfg(test)]
    fn queued_bytes(&mut self) -> usize {
        self.reconcile();
        self.queued
    }

    /// Send `item`, first waiting until it fits the byte budget. An item larger
    /// than the whole budget is sent once the channel is empty. Returns `false`
    /// when the receiver is gone (the session should end).
    pub(super) async fn send(&mut self, item: T) -> bool {
        let cost = item.queued_bytes().min(self.budget);
        loop {
            self.reconcile();
            if self.in_flight.is_empty() || self.queued + cost <= self.budget {
                break;
            }
            if self.tx.is_closed() {
                return false;
            }
            tokio::time::sleep(DRAIN_POLL).await;
        }
        if self.tx.send(item).await.is_err() {
            return false;
        }
        self.in_flight.push_back(cost);
        self.queued += cost;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::DirtyRect;

    fn frame(bytes: usize) -> FrameUpdate {
        FrameUpdate {
            width: 64,
            height: 64,
            rects: vec![DirtyRect {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                data: vec![0; bytes],
            }],
        }
    }

    #[test]
    fn cost_counts_rect_and_cursor_payloads() {
        let mut two = frame(10);
        two.rects.extend(frame(5).rects);
        assert_eq!(two.queued_bytes(), 15);
        let hidden = CursorUpdate {
            x: 0,
            y: 0,
            visible: false,
            shape: None,
        };
        assert_eq!(hidden.queued_bytes(), 0);
    }

    #[tokio::test]
    async fn taken_items_release_their_bytes() {
        let (tx, mut rx) = mpsc::channel(16);
        let mut sender = ByteBudgetSender::new(tx, 1000);
        assert!(sender.send(frame(300)).await);
        assert!(sender.send(frame(200)).await);
        assert_eq!(sender.queued_bytes(), 500);
        rx.recv().await.unwrap();
        assert_eq!(sender.queued_bytes(), 200);
        rx.recv().await.unwrap();
        assert_eq!(sender.queued_bytes(), 0);
    }

    #[tokio::test]
    async fn a_flood_waits_for_the_consumer_and_stays_under_budget() {
        let (tx, mut rx) = mpsc::channel(16);
        let producer = tokio::spawn(async move {
            let mut sender = ByteBudgetSender::new(tx, 1000);
            let mut peak = 0;
            for _ in 0..40 {
                assert!(sender.send(frame(300)).await);
                peak = peak.max(sender.queued_bytes());
            }
            peak
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!producer.is_finished(), "the flood must wait for the pump");
        let mut taken = 0;
        while taken < 40 {
            // Slow consumer: the channel may never exceed the byte budget, even
            // though it has room for 16 items.
            assert!(rx.len() * 300 <= 1000, "{} items queued", rx.len());
            if rx.recv().await.is_some() {
                taken += 1;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        let peak = producer.await.unwrap();
        assert!(peak <= 1000, "peak {peak}");
    }

    #[tokio::test]
    async fn an_update_larger_than_the_budget_goes_alone() {
        let (tx, mut rx) = mpsc::channel(16);
        let mut sender = ByteBudgetSender::new(tx, 100);
        assert!(sender.send(frame(5000)).await);
        assert_eq!(sender.queued_bytes(), 100);
        let blocked = tokio::spawn(async move { sender.send(frame(1)).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!blocked.is_finished());
        assert_eq!(rx.recv().await.unwrap().rects[0].data.len(), 5000);
        assert!(tokio::time::timeout(Duration::from_secs(5), blocked)
            .await
            .unwrap()
            .unwrap());
    }

    #[tokio::test]
    async fn a_closed_pump_releases_a_waiting_sender() {
        let (tx, rx) = mpsc::channel(16);
        let mut sender = ByteBudgetSender::new(tx, 100);
        assert!(sender.send(frame(100)).await);
        let blocked = tokio::spawn(async move { sender.send(frame(100)).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!blocked.is_finished());
        drop(rx);
        let sent = tokio::time::timeout(Duration::from_secs(5), blocked)
            .await
            .expect("a closed pump must not leave the driver parked")
            .unwrap();
        assert!(!sent);
    }
}
