//! Decoded-event queue bounded by bytes as well as by count (termiHub fork,
//! #3511).
//!
//! Upstream queued up to `CHANNEL_SIZE` (4096) decoded events between the
//! decoder task and the consumer, bounded only by count. A single
//! [`VncEvent::RawImage`] can carry up to `MAX_RECT_PIXELS * 4` bytes
//! (256 MiB), and Tight fill / ZRLE / TRLE rectangles decode from a few wire
//! bytes, so a hostile server could make the client hold far more decoded
//! memory than it ever sent.
//!
//! Every queued event now also holds a share of a byte budget
//! ([`MAX_QUEUED_EVENT_BYTES`]) for as long as it sits in the queue. When the
//! budget is spent the decoder *waits* for the consumer to take events — it
//! never drops them, because incremental updates depend on every earlier
//! rectangle. While the decoder waits it stops reading the network bridge, the
//! connection task stops reading the socket, and TCP flow control pushes back
//! on the server.
//!
//! The count bound stays: it keeps many tiny events (bells, 64x64 ZRLE tiles)
//! bounded, and it is large enough that the core driver, which drains the
//! queue on a 30 ms tick, is not throttled to a handful of tiles per tick.

use std::sync::Arc;

use tokio::sync::{
    mpsc::{self, error::TryRecvError},
    OwnedSemaphorePermit, Semaphore,
};

use crate::{VncError, VncEvent};

/// Total decoded bytes the event queue may hold at once (termiHub fork, #3511):
/// one maximum-size (8192 x 8192 x 4) image. An event larger than the whole
/// budget is charged the whole budget, so it is still delivered — alone.
pub(crate) const MAX_QUEUED_EVENT_BYTES: usize = 256 * 1024 * 1024;

/// Heap bytes an event pins while it is queued: its image or text payload.
/// Payload-free events (bell, copy, resolution, errors) cost nothing and are
/// bounded by the queue's count limit only.
pub(crate) fn event_cost(event: &VncEvent) -> usize {
    match event {
        VncEvent::RawImage(_, data)
        | VncEvent::JpegImage(_, data)
        | VncEvent::SetCursor(_, data) => data.len(),
        VncEvent::Text(text) => text.len(),
        _ => 0,
    }
}

/// One queued event plus the budget share it releases when it is taken.
struct Queued {
    event: VncEvent,
    _budget: Option<OwnedSemaphorePermit>,
}

/// Create a queue holding at most `count` events and `budget` bytes.
pub(crate) fn event_queue(count: usize, budget: usize) -> (EventSender, EventReceiver) {
    // A semaphore holds at most `u32::MAX` permits per acquire; keep the budget
    // representable and non-zero so every event can always be charged.
    let budget = budget.clamp(1, u32::MAX as usize);
    let semaphore = Arc::new(Semaphore::new(budget));
    let (tx, rx) = mpsc::channel(count);
    (
        EventSender {
            tx,
            budget: semaphore.clone(),
            limit: budget,
        },
        EventReceiver {
            rx,
            budget: semaphore,
            limit: budget,
        },
    )
}

/// Producer side (decoder / setup). Cheap to clone.
#[derive(Clone)]
pub(crate) struct EventSender {
    tx: mpsc::Sender<Queued>,
    budget: Arc<Semaphore>,
    limit: usize,
}

impl EventSender {
    /// Queue `event`, first waiting until its bytes fit the budget, then until
    /// the queue has a free slot. This wait is the decoder's backpressure.
    ///
    /// Errors when the receiver is gone or the queue was closed, so a decoder
    /// parked here is released by [`EventReceiver::close`].
    pub(crate) async fn send(&self, event: VncEvent) -> Result<(), VncError> {
        let cost = event_cost(&event).min(self.limit);
        let permit = if cost == 0 {
            None
        } else {
            let permits = u32::try_from(cost).unwrap_or(u32::MAX);
            Some(
                self.budget
                    .clone()
                    .acquire_many_owned(permits)
                    .await
                    .map_err(|_| VncError::ClientNotRunning)?,
            )
        };
        self.tx
            .send(Queued {
                event,
                _budget: permit,
            })
            .await?;
        Ok(())
    }
}

/// Consumer side. Taking an event releases its share of the budget.
pub(crate) struct EventReceiver {
    rx: mpsc::Receiver<Queued>,
    budget: Arc<Semaphore>,
    #[cfg_attr(not(test), allow(dead_code))]
    limit: usize,
}

impl EventReceiver {
    /// Wait for the next event; `None` once every sender is gone.
    pub(crate) async fn recv(&mut self) -> Option<VncEvent> {
        self.rx.recv().await.map(|q| q.event)
    }

    /// Take the next event without waiting.
    pub(crate) fn try_recv(&mut self) -> Result<VncEvent, TryRecvError> {
        self.rx.try_recv().map(|q| q.event)
    }

    /// Wake any sender parked on the byte budget with an error, so stopping
    /// the client never waits on a consumer that stopped draining.
    pub(crate) fn close(&self) {
        self.budget.close();
    }

    /// Decoded bytes currently held by queued events (plus any a sender is
    /// in the middle of charging).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn queued_bytes(&self) -> usize {
        self.limit.saturating_sub(self.budget.available_permits())
    }
}

impl Drop for EventReceiver {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::Rect;

    fn image(bytes: usize) -> VncEvent {
        let rect = Rect {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        };
        VncEvent::RawImage(rect, vec![0; bytes])
    }

    #[test]
    fn cost_counts_payload_bytes_only() {
        assert_eq!(event_cost(&image(1234)), 1234);
        assert_eq!(event_cost(&VncEvent::Text("héllo".into())), 6);
        assert_eq!(event_cost(&VncEvent::Bell), 0);
        let r = Rect {
            x: 0,
            y: 0,
            width: 8,
            height: 8,
        };
        assert_eq!(event_cost(&VncEvent::Copy(r, r)), 0);
        assert_eq!(event_cost(&VncEvent::JpegImage(r, vec![0; 7])), 7);
        assert_eq!(event_cost(&VncEvent::SetCursor(r, vec![0; 9])), 9);
    }

    #[tokio::test]
    async fn taking_an_event_releases_its_bytes() {
        let (tx, mut rx) = event_queue(16, 1000);
        tx.send(image(300)).await.unwrap();
        tx.send(image(200)).await.unwrap();
        tx.send(VncEvent::Bell).await.unwrap();
        assert_eq!(rx.queued_bytes(), 500);
        assert!(matches!(rx.try_recv(), Ok(VncEvent::RawImage(..))));
        assert_eq!(rx.queued_bytes(), 200);
        assert!(matches!(rx.recv().await, Some(VncEvent::RawImage(..))));
        assert_eq!(rx.queued_bytes(), 0);
        assert!(matches!(rx.try_recv(), Ok(VncEvent::Bell)));
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[tokio::test]
    async fn sender_waits_while_over_budget_and_resumes_when_drained() {
        let (tx, mut rx) = event_queue(16, 1000);
        tx.send(image(600)).await.unwrap();
        let blocked = tokio::spawn({
            let tx = tx.clone();
            async move { tx.send(image(600)).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!blocked.is_finished(), "second image must wait for budget");
        // The parked sender already reserved the 400 free bytes (the semaphore
        // hands permits to waiters in order), so the whole budget is spoken for.
        assert_eq!(rx.queued_bytes(), 1000);
        assert!(rx.try_recv().is_ok());
        tokio::time::timeout(Duration::from_secs(5), blocked)
            .await
            .expect("draining must release the sender")
            .unwrap()
            .unwrap();
        assert_eq!(rx.queued_bytes(), 600);
    }

    #[tokio::test]
    async fn an_event_larger_than_the_budget_is_still_delivered_alone() {
        let (tx, mut rx) = event_queue(16, 100);
        tx.send(image(5000)).await.unwrap();
        assert_eq!(rx.queued_bytes(), 100);
        let blocked = tokio::spawn({
            let tx = tx.clone();
            async move { tx.send(image(1)).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!blocked.is_finished());
        match rx.try_recv() {
            Ok(VncEvent::RawImage(_, data)) => assert_eq!(data.len(), 5000),
            other => panic!("expected the oversize image, got {other:?}"),
        }
        tokio::time::timeout(Duration::from_secs(5), blocked)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn close_releases_a_sender_parked_on_the_budget() {
        let (tx, rx) = event_queue(16, 100);
        tx.send(image(100)).await.unwrap();
        let blocked = tokio::spawn(async move { tx.send(image(100)).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!blocked.is_finished());
        rx.close();
        let result = tokio::time::timeout(Duration::from_secs(5), blocked)
            .await
            .expect("close must release the parked sender")
            .unwrap();
        assert!(
            matches!(result, Err(VncError::ClientNotRunning)),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn dropping_the_receiver_fails_payload_free_sends() {
        let (tx, rx) = event_queue(16, 100);
        drop(rx);
        assert!(tx.send(VncEvent::Bell).await.is_err());
    }
}
