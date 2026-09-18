//! Owned background-task tracking for deterministic shutdown (ARCH-007).
//!
//! The desktop spawns many long-lived background tasks (poll loops, IPC
//! accept loops, watchers). Historically each used the free
//! [`tauri::async_runtime::spawn`] and was never joined, so a task could
//! outlive [`run_app_teardown`](crate::run_app_teardown) — work continuing
//! after shutdown, leaked tasks, and a non-deterministic exit.
//!
//! [`AppTasks`] is the owned-task abstraction: a [`TaskTracker`] plus an
//! app-wide [`CancellationToken`], held in Tauri managed state. App-lifetime
//! spawn sites call [`AppTasks::spawn`] instead of a bare spawn, and long-lived
//! loops observe [`AppTasks::cancellation_token`]. Teardown then calls
//! [`AppTasks::shutdown`], which cancels the token and waits — bounded by a
//! timeout so a wedged task cannot hang exit — for every tracked task to finish.
//! At that point "all owned tasks finished or were cancelled" holds
//! deterministically.
//!
//! ## Why [`tauri::async_runtime::spawn`] and not `tokio::spawn`
//!
//! Spawn sites are reached synchronously from Tauri's setup / event-loop thread,
//! which runs *outside* any Tokio runtime context. The free `tokio::spawn`
//! (which [`TaskTracker::spawn`] uses internally) panics there
//! ("must be called from the context of a Tokio 1.x runtime"). So
//! [`AppTasks::spawn`] tracks the future with [`TaskTracker::track_future`] and
//! dispatches it onto Tauri's managed runtime, which is thread-agnostic — the
//! same load-bearing pattern the reconnect scheduler documents (#2503).

use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

/// Bounded time [`run_app_teardown`](crate::run_app_teardown) waits for tracked
/// tasks to finish after cancellation before giving up and letting the process
/// exit anyway. Generous enough for a cooperating loop to observe cancellation
/// and unwind, short enough that a wedged task cannot stall shutdown.
pub const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Outcome of [`AppTasks::shutdown`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownOutcome {
    /// Every tracked task finished (or observed cancellation and exited) within
    /// the timeout.
    Completed,
    /// The timeout elapsed with one or more tasks still running; the process
    /// proceeds with exit regardless. The stuck task(s) are abandoned.
    TimedOut,
}

/// App-lifetime background-task registry, managed in Tauri state.
///
/// Cheap to [`Clone`]: both the [`TaskTracker`] and the [`CancellationToken`]
/// are shared handles, so a clone spawns onto and cancels the same set.
#[derive(Clone, Default)]
pub struct AppTasks {
    tracker: TaskTracker,
    cancel: CancellationToken,
}

impl AppTasks {
    /// Create an empty registry with a fresh, un-cancelled token.
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn an owned background task onto Tauri's managed runtime and track it
    /// so [`shutdown`](Self::shutdown) will await its completion.
    ///
    /// Use this for **app-lifetime** work that should stop at shutdown — poll
    /// loops, accept loops, watchers. Do **not** use it for short request-scoped
    /// work, nor for anything whose cancellation could truncate in-flight
    /// critical work (e.g. a mid-write to disk); leave those on a bare spawn.
    pub fn spawn<F>(&self, future: F) -> tauri::async_runtime::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        // track_future increments the tracker synchronously (before the future
        // is ever polled), so `wait()` reflects this task immediately.
        tauri::async_runtime::spawn(self.tracker.track_future(future))
    }

    /// A clone of the app-wide cancellation token. Long-lived loops select on
    /// [`CancellationToken::cancelled`] so they break promptly at shutdown.
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    /// Whether shutdown has been requested (the token has been cancelled).
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Request cancellation and wait — bounded by `timeout` — for every tracked
    /// task to finish.
    ///
    /// Cancels the token (so cooperating loops exit), closes the tracker (so
    /// [`TaskTracker::wait`] can resolve once empty), then waits for all tracked
    /// tasks to complete. Returns [`ShutdownOutcome::TimedOut`] rather than
    /// blocking forever if a task ignores cancellation and never finishes, so a
    /// wedged task can never hang exit.
    ///
    /// Deadlock-free: the teardown task that calls this is itself **not**
    /// tracked (it uses a bare spawn), so awaiting the tracker never waits on
    /// the caller, and no tracked task needs teardown to make progress.
    pub async fn shutdown(&self, timeout: Duration) -> ShutdownOutcome {
        self.cancel.cancel();
        self.tracker.close();
        match tokio::time::timeout(timeout, self.tracker.wait()).await {
            Ok(()) => ShutdownOutcome::Completed,
            Err(_) => ShutdownOutcome::TimedOut,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Tasks spawned via the tracker are awaited on `shutdown` (close + wait):
    /// the task yields before finishing, so it is still in-flight when
    /// `shutdown` is called, yet the flag is set by the time `shutdown` returns.
    #[tokio::test]
    async fn shutdown_awaits_tracked_tasks() {
        let tasks = AppTasks::new();
        let done = Arc::new(AtomicBool::new(false));
        let flag = done.clone();
        tasks.spawn(async move {
            // Yield so the task is provably not complete at the shutdown call.
            tokio::task::yield_now().await;
            flag.store(true, Ordering::SeqCst);
        });

        let outcome = tasks.shutdown(Duration::from_secs(5)).await;

        assert_eq!(outcome, ShutdownOutcome::Completed);
        assert!(
            done.load(Ordering::SeqCst),
            "shutdown must wait for the tracked task to finish"
        );
    }

    /// The cancellation token flips on `shutdown` and a cooperating task
    /// (selecting on the token) observes it and exits, so `wait` completes.
    #[tokio::test]
    async fn shutdown_cancels_cooperating_task() {
        let tasks = AppTasks::new();
        let token = tasks.cancellation_token();
        tasks.spawn(async move {
            // Never completes on its own — only cancellation lets it exit.
            token.cancelled().await;
        });

        assert!(!tasks.is_cancelled());
        let outcome = tasks.shutdown(Duration::from_secs(5)).await;

        assert_eq!(outcome, ShutdownOutcome::Completed);
        assert!(tasks.is_cancelled(), "shutdown must cancel the token");
    }

    /// A wedged task that ignores cancellation must not hang shutdown: the
    /// bounded timeout elapses and `shutdown` returns `TimedOut`. Paused time
    /// makes this deterministic — no wall-clock sleep.
    #[tokio::test(start_paused = true)]
    async fn shutdown_times_out_on_wedged_task() {
        let tasks = AppTasks::new();
        tasks.spawn(async {
            // Ignores the cancellation token entirely and never completes.
            std::future::pending::<()>().await;
        });

        let outcome = tasks.shutdown(Duration::from_millis(500)).await;

        assert_eq!(outcome, ShutdownOutcome::TimedOut);
    }

    /// An empty registry shuts down immediately with `Completed`.
    #[tokio::test]
    async fn shutdown_with_no_tasks_completes() {
        let tasks = AppTasks::new();
        let outcome = tasks.shutdown(Duration::from_secs(5)).await;
        assert_eq!(outcome, ShutdownOutcome::Completed);
        assert!(tasks.is_cancelled());
    }
}
