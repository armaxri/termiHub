//! The agent I/O task's single stop signal (#4366, WA-RS2-004).
//!
//! An agent connection used to carry an `alive: AtomicBool` that a user
//! Disconnect, app shutdown or exhausted reconnect cleared, plus a separate
//! [`CancellationToken`] for the cancellable SSH connect — bridged by a task
//! that polled the flag every 100 ms, while the reconnect backoff slept in
//! 100 ms slices re-checking it. [`AgentAlive`] makes the token the one signal:
//! "alive" simply means "not yet stopped", and everything that waits on a stop
//! awaits [`CancellationToken::cancelled`] directly.

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

/// Liveness of one agent connection's I/O task, backed by a single
/// [`CancellationToken`].
///
/// Shared as an `Arc` between the agent map entry and the I/O task; the `Arc`
/// identity is what [`reap_agent`](super::reap_agent) compares, so a late reap
/// from a replaced task never removes its successor's entry.
#[derive(Debug, Default)]
pub(super) struct AgentAlive {
    stop: CancellationToken,
}

impl AgentAlive {
    /// A fresh, live signal.
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// An already-stopped signal (tests: a dead entry / a stale task).
    #[cfg(test)]
    pub(super) fn stopped() -> Arc<Self> {
        let alive = Self::new();
        alive.stop();
        alive
    }

    /// Whether the connection is still live (not yet stopped).
    pub(super) fn is_alive(&self) -> bool {
        !self.stop.is_cancelled()
    }

    /// Stop the connection: every observer sees it dead from now on, and every
    /// waiter on the token (a reconnect backoff, a cancellable connect or
    /// handshake) wakes at once. Idempotent.
    pub(super) fn stop(&self) {
        self.stop.cancel();
    }

    /// The underlying token, for a select / a cancellable connect.
    pub(super) fn token(&self) -> &CancellationToken {
        &self.stop
    }

    /// Sleep `delay`, returning early the moment the connection is stopped.
    ///
    /// Returns `true` if the full delay elapsed, `false` if stopped (including
    /// already stopped on entry).
    pub(super) async fn sleep(&self, delay: Duration) -> bool {
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => false,
            _ = tokio::time::sleep(delay) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;

    #[test]
    fn new_is_alive_and_stop_is_sticky() {
        let alive = AgentAlive::new();
        assert!(alive.is_alive());
        alive.stop();
        assert!(!alive.is_alive());
        alive.stop();
        assert!(!alive.is_alive());
        assert!(alive.token().is_cancelled());
        assert!(!AgentAlive::stopped().is_alive());
    }

    #[tokio::test(start_paused = true)]
    async fn sleep_runs_the_full_delay_while_alive() {
        let alive = AgentAlive::new();
        let start = Instant::now();
        assert!(alive.sleep(Duration::from_secs(30)).await);
        assert!(start.elapsed() >= Duration::from_secs(30));
    }

    /// Regression (#4366): a stop wakes a backoff sleep at the stop instant,
    /// not on the next 100 ms poll slice.
    #[tokio::test(start_paused = true)]
    async fn sleep_wakes_at_the_stop_instant() {
        let alive = AgentAlive::new();
        let stopper = alive.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1_234)).await;
            stopper.stop();
        });
        let start = Instant::now();
        assert!(!alive.sleep(Duration::from_secs(30)).await);
        assert_eq!(start.elapsed(), Duration::from_millis(1_234));
    }
}
