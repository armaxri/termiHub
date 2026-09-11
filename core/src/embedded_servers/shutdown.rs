//! Event-driven shutdown signal shared between an embedded server's manager and
//! its listener thread.
//!
//! Wraps an [`AtomicBool`] (so synchronous pollers can still cheaply check the
//! flag) with a [`tokio::sync::Notify`] so an async listener can *await* shutdown
//! and wake the instant it is triggered — no busy-poll, no fixed latency
//! (WA-RS-001 / CORE-001). The HTTP server awaits [`ShutdownSignal::wait`] inside
//! its `with_graceful_shutdown` closure instead of sleeping in a 100 ms loop.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

/// A cloneable shutdown signal.
///
/// Every clone shares the same underlying flag and notifier, so triggering any
/// clone stops every holder. Async consumers call [`wait`](Self::wait) to be
/// woken the instant the signal fires; synchronous pollers read
/// [`is_triggered`](Self::is_triggered) or hold the raw [`flag`](Self::flag).
#[derive(Clone)]
pub struct ShutdownSignal {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl ShutdownSignal {
    /// Create a fresh, un-triggered signal.
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Fire the signal: mark it triggered and wake any awaiting consumer.
    ///
    /// Idempotent — calling it more than once is harmless.
    pub fn trigger(&self) {
        self.flag.store(true, Ordering::SeqCst);
        // `notify_one` stores a permit even when no consumer is parked yet, so a
        // trigger that races a consumer *about to* await is not lost — the next
        // `notified().await` consumes the stored permit. `notify_waiters` would
        // only wake already-parked consumers and drop that wake-up on the floor.
        self.notify.notify_one();
    }

    /// Whether the signal has been triggered. Cheap and lock-free — for pollers.
    pub fn is_triggered(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// The raw shared flag, for synchronous pollers that predate the event-driven
    /// path (the FTP/TFTP loops still read this directly).
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }

    /// Await until the signal is triggered, returning immediately if it already
    /// has been. Event-driven: the task parks with zero wake-ups until
    /// [`trigger`](Self::trigger) fires, then wakes at once.
    pub async fn wait(&self) {
        while !self.is_triggered() {
            self.notify.notified().await;
        }
    }
}

impl Default for ShutdownSignal {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::{timeout, Instant};

    #[tokio::test]
    async fn wait_returns_immediately_when_pre_triggered() {
        let sig = ShutdownSignal::new();
        assert!(!sig.is_triggered());
        sig.trigger();
        assert!(sig.is_triggered());
        // Must not block at all when the signal already fired.
        timeout(Duration::from_millis(100), sig.wait())
            .await
            .expect("wait must return at once when already triggered");
    }

    #[tokio::test]
    async fn wait_wakes_promptly_when_triggered_while_parked() {
        let sig = ShutdownSignal::new();
        let waiter = sig.clone();
        let start = Instant::now();
        let handle = tokio::spawn(async move { waiter.wait().await });

        // Give the waiter a moment to park, then fire.
        tokio::time::sleep(Duration::from_millis(10)).await;
        sig.trigger();

        timeout(Duration::from_millis(200), handle)
            .await
            .expect("waiter must wake promptly")
            .expect("waiter task panicked");

        // Event-driven wake is sub-millisecond; the old poll loop could take up
        // to a full 100 ms. A generous 90 ms bound proves we no longer poll
        // while staying resilient to CI scheduling jitter.
        assert!(
            start.elapsed() < Duration::from_millis(90),
            "wake was too slow ({:?}); it should be event-driven, not polled",
            start.elapsed()
        );
    }

    #[tokio::test]
    async fn trigger_before_await_is_not_lost() {
        // A trigger that lands before the consumer ever awaits must still be
        // observed (the `notify_one` permit + flag re-check guarantee this).
        let sig = ShutdownSignal::new();
        sig.trigger();
        let waiter = sig.clone();
        timeout(
            Duration::from_millis(100),
            async move { waiter.wait().await },
        )
        .await
        .expect("a pre-await trigger must not be lost");
    }

    #[test]
    fn flag_bridges_to_pollers() {
        let sig = ShutdownSignal::new();
        let flag = sig.flag();
        assert!(!flag.load(Ordering::SeqCst));
        sig.trigger();
        assert!(flag.load(Ordering::SeqCst), "flag must reflect the trigger");
    }
}
