//! Keep a backend's output from before the first subscriber (#4719).
//!
//! A backend starts its reader in `connect`, but the consumer only calls
//! [`subscribe_output`](crate::connection::ConnectionType::subscribe_output)
//! after `connect` returns. Whatever the reader forwards in that gap — a
//! telnet server's greeting written the instant it accepts, a shell's first
//! prompt — must reach that first subscriber, not a channel nobody listens on.
//!
//! [`EarlyOutput`] holds the receiver of the channel `connect` opens until the
//! first subscriber takes it, so those bytes wait in the channel instead of
//! being dropped. Later subscribers get a fresh channel that replaces the
//! previous one, as before.

use std::sync::Mutex;

use super::OUTPUT_CHANNEL_CAPACITY;
use crate::connection::{OutputReceiver, OutputSender};

/// The receiver of a connect-time output channel, held until the first
/// subscriber takes it.
///
/// While it is held the channel is bounded like any other, so a reader that
/// fills it before anyone subscribes waits (backpressure) instead of dropping
/// output. [`clear`](Self::clear) drops it, which ends such a wait: call it on
/// disconnect.
#[derive(Debug, Default)]
pub struct EarlyOutput {
    receiver: Mutex<Option<OutputReceiver>>,
}

impl EarlyOutput {
    /// A holder with no channel yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Open the connect-time output channel: store its sender in `output_tx`
    /// (where the reader looks it up) and hold its receiver for the first
    /// subscriber. Replaces any channel a previous connection left behind.
    pub fn open(&self, output_tx: &Mutex<Option<OutputSender>>) {
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        *lock(&self.receiver) = Some(rx);
        *lock(output_tx) = Some(tx);
    }

    /// Subscribe to the output. The first call after [`open`](Self::open)
    /// returns the connect-time receiver, with everything sent so far still in
    /// it. Any other call opens a fresh channel whose sender replaces the one
    /// in `output_tx`, so the previous subscriber stops receiving.
    pub fn subscribe(&self, output_tx: &Mutex<Option<OutputSender>>) -> OutputReceiver {
        if let Some(rx) = lock(&self.receiver).take() {
            return rx;
        }
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        *lock(output_tx) = Some(tx);
        rx
    }

    /// Drop a receiver nobody took. A reader parked on the full channel then
    /// gets a send error and can stop.
    pub fn clear(&self) {
        lock(&self.receiver).take();
    }
}

/// Lock, recovering from poisoning: the guarded value is a plain channel
/// handle, so a panic elsewhere cannot leave it half-updated.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn first_subscriber_gets_output_sent_before_it_subscribed() {
        let output_tx = Mutex::new(None);
        let early = EarlyOutput::new();
        early.open(&output_tx);
        let sender = output_tx.lock().unwrap().clone().expect("sender installed");
        sender.send(b"early".to_vec()).await.expect("send early");

        let mut rx = early.subscribe(&output_tx);
        assert_eq!(rx.recv().await.as_deref(), Some(&b"early"[..]));
    }

    #[tokio::test]
    async fn a_later_subscriber_replaces_the_first() {
        let output_tx = Mutex::new(None);
        let early = EarlyOutput::new();
        early.open(&output_tx);
        let mut first = early.subscribe(&output_tx);
        let mut second = early.subscribe(&output_tx);

        let sender = output_tx.lock().unwrap().clone().expect("sender installed");
        sender.send(b"later".to_vec()).await.expect("send later");
        assert_eq!(second.recv().await.as_deref(), Some(&b"later"[..]));
        // The first channel lost its only sender when it was replaced.
        drop(sender);
        assert!(first.recv().await.is_none());
    }

    #[tokio::test]
    async fn the_first_subscriber_sees_the_end_when_the_reader_already_stopped() {
        let output_tx = Mutex::new(None);
        let early = EarlyOutput::new();
        early.open(&output_tx);
        let sender = output_tx.lock().unwrap().take().expect("sender installed");
        sender.send(b"last".to_vec()).await.expect("send last");
        drop(sender); // the reader ended and cleared its sender

        let mut rx = early.subscribe(&output_tx);
        assert_eq!(rx.recv().await.as_deref(), Some(&b"last"[..]));
        assert!(rx.recv().await.is_none(), "the stream must end, not hang");
        assert!(output_tx.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn clear_unblocks_a_sender_waiting_on_a_full_channel() {
        let output_tx = Mutex::new(None);
        let early = EarlyOutput::new();
        early.open(&output_tx);
        let sender = output_tx.lock().unwrap().clone().expect("sender installed");
        for _ in 0..OUTPUT_CHANNEL_CAPACITY {
            sender.send(vec![0]).await.expect("fill");
        }
        let blocked = tokio::spawn(async move { sender.send(vec![1]).await });
        tokio::task::yield_now().await;
        early.clear();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), blocked)
            .await
            .expect("the send must return once the receiver is gone")
            .expect("join");
        assert!(result.is_err(), "the send must fail with no receiver left");
    }

    #[test]
    fn subscribe_without_open_opens_a_fresh_channel() {
        let output_tx = Mutex::new(None);
        let early = EarlyOutput::new();
        let _rx = early.subscribe(&output_tx);
        assert!(output_tx.lock().unwrap().is_some());
    }
}
