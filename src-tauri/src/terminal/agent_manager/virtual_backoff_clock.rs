//! A virtual [`BackoffClock`] for the reconnect backoff and park tests (#5339).
//!
//! Time on this clock moves only when the test calls
//! [`advance`](VirtualBackoffClock::advance). A backoff wait the reconnect loop
//! starts is recorded with the virtual instant it was requested at, and
//! resolves once the clock has been advanced to its deadline, never earlier
//! and never later. Work between two waits (a connect attempt) takes no
//! virtual time, so attempt `n` starts at exactly the sum of the first `n`
//! backoff delays, and a test asserts that sum instead of watching a
//! wall-clock window.
//!
//! The test thread and the reconnect loop run concurrently, so the test waits
//! for the loop's next request with [`wait_for_requests`]
//! (bounded, condvar-driven) before it advances.
//!
//! [`wait_for_requests`]: VirtualBackoffClock::wait_for_requests

use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

use super::backoff_clock::{BackoffClock, BackoffSleep};

/// One backoff wait the loop asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SleepRequest {
    /// Virtual time when the wait started.
    pub(super) at: Duration,
    /// How long it waits.
    pub(super) delay: Duration,
}

/// A wait that has not resolved yet.
struct Pending {
    deadline: Duration,
    wake: oneshot::Sender<()>,
}

#[derive(Default)]
struct State {
    now: Duration,
    requests: Vec<SleepRequest>,
    pending: Vec<Pending>,
}

/// A clock that only moves when the test advances it.
#[derive(Default)]
pub(super) struct VirtualBackoffClock {
    state: Mutex<State>,
    requested: Condvar,
}

impl VirtualBackoffClock {
    /// A fresh clock at virtual time zero, leaked so it can sit in a
    /// [`ReconnectTuning`](super::reconnect::ReconnectTuning) (which holds a
    /// `&'static` clock). One small allocation per test.
    pub(super) fn leaked() -> &'static Self {
        Box::leak(Box::default())
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Virtual time elapsed so far.
    pub(super) fn now(&self) -> Duration {
        self.state().now
    }

    /// Every wait requested so far, in order.
    pub(super) fn requests(&self) -> Vec<SleepRequest> {
        self.state().requests.clone()
    }

    /// Waits that are still pending: requested, not yet due, and still awaited
    /// (a wait the loop dropped, e.g. on a stop, no longer counts).
    pub(super) fn pending(&self) -> usize {
        self.state()
            .pending
            .iter()
            .filter(|p| !p.wake.is_closed())
            .count()
    }

    /// Block until at least `n` waits have been requested, or `within` (real
    /// time) runs out. Returns every request so far, or `None` on timeout.
    pub(super) fn wait_for_requests(&self, n: usize, within: Duration) -> Option<Vec<SleepRequest>> {
        let deadline = Instant::now() + within;
        let mut state = self.state();
        loop {
            if state.requests.len() >= n {
                return Some(state.requests.clone());
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            state = self
                .requested
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// Move virtual time forward by `by`, resolving every wait now due.
    pub(super) fn advance(&self, by: Duration) {
        let mut state = self.state();
        state.now += by;
        let now = state.now;
        let (due, pending): (Vec<_>, Vec<_>) = std::mem::take(&mut state.pending)
            .into_iter()
            .partition(|p| p.deadline <= now);
        state.pending = pending;
        drop(state);
        for p in due {
            let _ = p.wake.send(());
        }
    }
}

impl BackoffClock for VirtualBackoffClock {
    fn sleep(&self, delay: Duration) -> BackoffSleep {
        let (wake, woken) = oneshot::channel();
        let mut state = self.state();
        let at = state.now;
        state.requests.push(SleepRequest { at, delay });
        if delay.is_zero() {
            let _ = wake.send(());
        } else {
            state.pending.push(Pending {
                deadline: at + delay,
                wake,
            });
        }
        drop(state);
        self.requested.notify_all();
        Box::pin(async move {
            let _ = woken.await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    /// Poll `wait` once: whether it has resolved.
    async fn is_ready(wait: &mut BackoffSleep) -> bool {
        std::future::poll_fn(|cx| std::task::Poll::Ready(wait.as_mut().poll(cx).is_ready())).await
    }

    #[tokio::test]
    async fn a_wait_resolves_exactly_at_its_deadline() {
        let clock = VirtualBackoffClock::default();
        let mut wait = clock.sleep(Duration::from_secs(2));
        assert_eq!(clock.pending(), 1);

        clock.advance(Duration::from_secs(2) - MS);
        assert!(
            !is_ready(&mut wait).await,
            "a wait must not resolve before its deadline"
        );
        assert_eq!(clock.pending(), 1);

        clock.advance(MS);
        assert!(is_ready(&mut wait).await);
        assert_eq!(clock.pending(), 0);
        assert_eq!(
            clock.requests(),
            vec![SleepRequest {
                at: Duration::ZERO,
                delay: Duration::from_secs(2)
            }]
        );
        assert_eq!(clock.now(), Duration::from_secs(2));
    }

    #[tokio::test]
    async fn a_zero_wait_resolves_at_once_and_a_dropped_wait_stops_pending() {
        let clock = VirtualBackoffClock::default();
        clock.sleep(Duration::ZERO).await;
        let wait = clock.sleep(Duration::from_secs(1));
        assert_eq!(clock.pending(), 1);
        drop(wait);
        assert_eq!(clock.pending(), 0);
    }

    #[test]
    fn wait_for_requests_times_out_without_a_request() {
        let clock = VirtualBackoffClock::default();
        assert_eq!(clock.wait_for_requests(1, 10 * MS), None);
        let _wait = clock.sleep(MS);
        assert_eq!(clock.wait_for_requests(1, 10 * MS).map(|r| r.len()), Some(1));
    }
}
