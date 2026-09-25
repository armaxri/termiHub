//! Event-driven shutdown signal shared between an embedded server's manager and
//! its listener thread.
//!
//! Wraps an [`AtomicBool`] (so synchronous pollers can still cheaply check the
//! flag) with a [`tokio::sync::Notify`] so an async listener can *await* shutdown
//! and wake the instant it is triggered — no busy-poll, no fixed latency
//! (WA-RS-001 / CORE-001). All three servers await [`ShutdownSignal::wait`]: HTTP
//! inside its `with_graceful_shutdown` closure, FTP in its `select!` against the
//! listener, and TFTP in every `select!` around a socket receive (accept loop and
//! each in-flight transfer) — none of them sleeps in a fixed-interval loop.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

/// A cloneable shutdown signal.
///
/// Every clone shares the same underlying flag and notifier, so triggering any
/// clone stops every holder. Async consumers call [`wait`](Self::wait) to be
/// woken the instant the signal fires; synchronous pollers read
/// [`is_triggered`](Self::is_triggered).
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

    /// Fire the signal: mark it triggered and wake every awaiting consumer.
    ///
    /// Idempotent — calling it more than once is harmless.
    pub fn trigger(&self) {
        self.flag.store(true, Ordering::SeqCst);
        // `notify_waiters` wakes *every* registered consumer — the FTP/TFTP
        // servers park several at once (accept loop + each in-flight transfer),
        // and `notify_one` would wake only one of them. It stores no permit, so
        // [`wait`](Self::wait) registers its `Notified` *before* re-checking the
        // flag: a trigger landing between the check and the await still finds
        // the consumer registered, so no wake-up is lost.
        self.notify.notify_waiters();
    }

    /// Whether the signal has been triggered. Cheap and lock-free — for pollers.
    pub fn is_triggered(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Await until the signal is triggered, returning immediately if it already
    /// has been. Event-driven: the task parks with zero wake-ups until
    /// [`trigger`](Self::trigger) fires, then wakes at once. Any number of
    /// clones may wait concurrently; one trigger wakes them all.
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Register interest before checking the flag, so a trigger racing
            // this check is delivered to the registered future (see `trigger`).
            notified.as_mut().enable();
            if self.is_triggered() {
                return;
            }
            notified.await;
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
        // observed (the flag re-check after registering guarantees this).
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

    #[tokio::test]
    async fn trigger_wakes_every_concurrent_waiter() {
        // The FTP/TFTP servers park several consumers on one signal at once (the
        // accept loop plus every in-flight transfer). A single trigger must wake
        // *all* of them, not just one.
        let sig = ShutdownSignal::new();
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let waiter = sig.clone();
                tokio::spawn(async move { waiter.wait().await })
            })
            .collect();

        // Let every waiter park before firing.
        tokio::time::sleep(Duration::from_millis(10)).await;
        sig.trigger();

        for handle in handles {
            timeout(Duration::from_millis(500), handle)
                .await
                .expect("every waiter must wake on a single trigger")
                .expect("waiter task panicked");
        }
    }
}
