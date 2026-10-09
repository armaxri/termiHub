//! Shared, event-driven stop / pause / interval plumbing for the periodic
//! monitoring collect loops (#4366, WA-RS2-004).
//!
//! The local, exec and SSH monitoring providers all run the same shape of
//! loop: collect, wait the (live-updatable) interval, repeat — idling while
//! paused and stopping when the subscription is torn down. Previously each
//! provider carried its own copy of an `interruptible_sleep` that slept in
//! 100 ms ticks re-checking an `AtomicBool alive` flag, and a paused loop
//! polled its pause flag every 200 ms. This module replaces both polls with
//! awaited events:
//!
//! - the loop's `CancellationToken` is the **single** stop signal, awaited
//!   via [`cancellable_sleep`];
//! - pause / resume is signalled through a [`tokio::sync::watch`] channel in
//!   [`LoopControls`], awaited via [`LoopControls::wait_until_resumed`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// Sleep for `delay`, returning early the moment `cancel` fires.
///
/// Returns `true` if the full delay elapsed, `false` if the sleep was
/// interrupted by cancellation (including a token that was already cancelled
/// on entry). No polling: the wake-up is the token's own notification.
pub(crate) async fn cancellable_sleep(delay: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep(delay) => true,
    }
}

/// Shared, live-updatable controls for a running collect loop (#1233).
///
/// The provider's `set_interval` / `set_paused` methods steer a running
/// subscription through these without tearing it down. The interval is an
/// atomic read afresh before each wait; the pause flag lives in a `watch`
/// channel so a paused loop can *await* resume instead of polling for it.
pub(crate) struct LoopControls {
    /// Poll interval in milliseconds, read afresh before each wait.
    interval_ms: AtomicU64,
    /// When `true`, the loop skips collection but keeps its transport open.
    paused: watch::Sender<bool>,
}

impl LoopControls {
    /// Controls starting unpaused at `interval`.
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            interval_ms: AtomicU64::new(interval.as_millis() as u64),
            paused: watch::Sender::new(false),
        }
    }

    /// The current poll interval (never zero).
    pub(crate) fn interval(&self) -> Duration {
        Duration::from_millis(self.interval_ms.load(Ordering::SeqCst).max(1))
    }

    /// Change the poll interval; takes effect on the loop's next wait.
    pub(crate) fn set_interval(&self, interval: Duration) {
        self.interval_ms
            .store(interval.as_millis().max(1) as u64, Ordering::SeqCst);
    }

    /// Whether the loop is currently paused.
    pub(crate) fn is_paused(&self) -> bool {
        *self.paused.borrow()
    }

    /// Pause or resume the loop, waking a loop parked in
    /// [`wait_until_resumed`](Self::wait_until_resumed).
    pub(crate) fn set_paused(&self, paused: bool) {
        self.paused.send_replace(paused);
    }

    /// Wait until the loop is unpaused or `cancel` fires.
    ///
    /// Returns `true` once resumed (immediately if not paused), `false` if
    /// cancelled first. Event-driven: no periodic re-check of the flag.
    pub(crate) async fn wait_until_resumed(&self, cancel: &CancellationToken) -> bool {
        let mut rx = self.paused.subscribe();
        tokio::select! {
            biased;
            _ = cancel.cancelled() => false,
            // The sender lives in `self`, so the channel cannot close while we
            // borrow it; treat a (theoretical) close as "resumed".
            _ = rx.wait_for(|paused| !*paused) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::time::Instant;

    /// The old poll tick: a prompt wake-up must beat this by construction.
    const OLD_POLL_TICK: Duration = Duration::from_millis(100);

    #[tokio::test(start_paused = true)]
    async fn cancellable_sleep_runs_full_delay_when_not_cancelled() {
        let cancel = CancellationToken::new();
        let start = Instant::now();
        assert!(cancellable_sleep(Duration::from_secs(30), &cancel).await);
        assert!(start.elapsed() >= Duration::from_secs(30));
    }

    #[tokio::test(start_paused = true)]
    async fn cancellable_sleep_returns_immediately_when_already_cancelled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let start = Instant::now();
        assert!(!cancellable_sleep(Duration::from_secs(30), &cancel).await);
        assert_eq!(start.elapsed(), Duration::ZERO, "no virtual time may pass");
    }

    /// Regression (#4366): cancelling mid-sleep wakes the sleeper at the
    /// cancel instant, not on the next 100 ms poll tick.
    #[tokio::test(start_paused = true)]
    async fn cancellable_sleep_wakes_at_the_cancel_instant() {
        let cancel = CancellationToken::new();
        let canceller = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1_234)).await;
            canceller.cancel();
        });
        let start = Instant::now();
        assert!(!cancellable_sleep(Duration::from_secs(60), &cancel).await);
        let elapsed = start.elapsed();
        assert_eq!(
            elapsed,
            Duration::from_millis(1_234),
            "the sleep must end exactly when the token fires (no poll-tick lag)"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn wait_until_resumed_returns_immediately_when_not_paused() {
        let controls = LoopControls::new(Duration::from_secs(1));
        let cancel = CancellationToken::new();
        let start = Instant::now();
        assert!(controls.wait_until_resumed(&cancel).await);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    /// Regression (#4366): resume wakes a paused loop at the resume instant,
    /// not on the next 200 ms pause-poll tick.
    #[tokio::test(start_paused = true)]
    async fn wait_until_resumed_wakes_at_the_resume_instant() {
        let controls = Arc::new(LoopControls::new(Duration::from_secs(1)));
        controls.set_paused(true);
        assert!(controls.is_paused());
        let cancel = CancellationToken::new();

        let resumer = controls.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(777)).await;
            resumer.set_paused(false);
        });
        let start = Instant::now();
        assert!(controls.wait_until_resumed(&cancel).await);
        assert_eq!(start.elapsed(), Duration::from_millis(777));
        assert!(!controls.is_paused());
    }

    /// A paused loop that is torn down stops waiting at the cancel instant.
    #[tokio::test(start_paused = true)]
    async fn wait_until_resumed_stops_on_cancel() {
        let controls = LoopControls::new(Duration::from_secs(1));
        controls.set_paused(true);
        let cancel = CancellationToken::new();
        let canceller = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            canceller.cancel();
        });
        let start = Instant::now();
        assert!(!controls.wait_until_resumed(&cancel).await);
        assert!(start.elapsed() < OLD_POLL_TICK);
    }

    #[test]
    fn interval_is_live_updatable_and_never_zero() {
        let controls = LoopControls::new(Duration::from_millis(500));
        assert_eq!(controls.interval(), Duration::from_millis(500));
        controls.set_interval(Duration::from_secs(3));
        assert_eq!(controls.interval(), Duration::from_secs(3));
        controls.set_interval(Duration::ZERO);
        assert_eq!(controls.interval(), Duration::from_millis(1));
    }
}
