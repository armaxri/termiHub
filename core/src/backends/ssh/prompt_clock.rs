//! A connect deadline that stops ticking while the user is answering a prompt
//! (#3371).
//!
//! Every SSH connect is bounded by [`SshConfig::connect_timeout`](crate::config::SshConfig::connect_timeout)
//! (45 s by default) so an unreachable host fails fast. Keyboard-interactive
//! authentication, however, waits on a **human**: fetching a one-time code from
//! a phone can easily take longer than the whole connect budget. Charging that
//! think-time against the network timeout would make 2FA bastions unreachable
//! for anyone who is not quick.
//!
//! [`timeout_excluding_prompts`] is a drop-in for `tokio::time::timeout` on the
//! connect paths. It installs a task-local [`PausableDeadline`]; code that
//! blocks on the user wraps that wait in [`excluded_from_connect_timeout`],
//! which pauses every enclosing deadline for its duration and pushes each one
//! out by exactly the time spent paused. The prompt keeps its own, separate
//! timeout, so a never-answered prompt still fails the connect.
//!
//! Deadlines nest (the jump-host probe bounds a hop step around a connect that
//! is itself bounded): a pause propagates to every ancestor, so no enclosing
//! timeout fires while a prompt is open.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::Instant;

tokio::task_local! {
    /// The innermost connect deadline for the current task, if any.
    static CURRENT: Arc<PausableDeadline>;
}

/// The connect deadline elapsed (while not paused for a prompt).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Elapsed;

#[derive(Debug)]
struct State {
    deadline: Instant,
    /// When the current pause started; `None` while running.
    paused_since: Option<Instant>,
    /// Number of active pauses (prompts can overlap on one task only through
    /// nesting, but counting keeps pause/resume balanced regardless).
    depth: u32,
}

/// A deadline that can be paused; pausing extends it by the paused duration.
#[derive(Debug)]
pub(crate) struct PausableDeadline {
    state: Mutex<State>,
    parent: Option<Arc<PausableDeadline>>,
    notify: Notify,
}

impl PausableDeadline {
    fn new(deadline: Instant, parent: Option<Arc<PausableDeadline>>) -> Self {
        Self {
            state: Mutex::new(State {
                deadline,
                paused_since: None,
                depth: 0,
            }),
            parent,
            notify: Notify::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Current `(deadline, paused)` snapshot.
    fn snapshot(&self) -> (Instant, bool) {
        let s = self.lock();
        (s.deadline, s.paused_since.is_some())
    }

    fn pause(&self) {
        {
            let mut s = self.lock();
            s.depth += 1;
            if s.depth == 1 {
                s.paused_since = Some(Instant::now());
            }
        }
        self.notify.notify_one();
        if let Some(parent) = &self.parent {
            parent.pause();
        }
    }

    fn resume(&self) {
        {
            let mut s = self.lock();
            s.depth = s.depth.saturating_sub(1);
            if s.depth == 0 {
                if let Some(since) = s.paused_since.take() {
                    s.deadline += Instant::now().saturating_duration_since(since);
                }
            }
        }
        self.notify.notify_one();
        if let Some(parent) = &self.parent {
            parent.resume();
        }
    }
}

/// Like `tokio::time::timeout`, but time spent inside
/// [`excluded_from_connect_timeout`] (anywhere within `fut`, on the same task)
/// does not count against `duration`.
pub(crate) async fn timeout_excluding_prompts<F>(
    duration: Duration,
    fut: F,
) -> Result<F::Output, Elapsed>
where
    F: Future,
{
    let parent = CURRENT.try_with(Arc::clone).ok();
    let clock = Arc::new(PausableDeadline::new(Instant::now() + duration, parent));
    let fut = CURRENT.scope(clock.clone(), fut);
    tokio::pin!(fut);

    loop {
        let (deadline, paused) = clock.snapshot();
        if paused {
            tokio::select! {
                biased;
                out = &mut fut => return Ok(out),
                _ = clock.notify.notified() => continue,
            }
        }
        tokio::select! {
            biased;
            out = &mut fut => return Ok(out),
            _ = clock.notify.notified() => continue,
            _ = tokio::time::sleep_until(deadline) => {
                // Re-check: a pause/resume may have moved the deadline while the
                // sleep was being armed.
                let (deadline, paused) = clock.snapshot();
                if !paused && Instant::now() >= deadline {
                    return Err(Elapsed);
                }
            }
        }
    }
}

/// Resumes the paused deadline chain when dropped — also when the prompt future
/// is cancelled mid-await.
struct PauseGuard(Option<Arc<PausableDeadline>>);

impl Drop for PauseGuard {
    fn drop(&mut self) {
        if let Some(clock) = self.0.take() {
            clock.resume();
        }
    }
}

/// Run `fut` (a wait on the user) with every enclosing connect deadline paused.
///
/// Outside any [`timeout_excluding_prompts`] scope this is a plain `.await`.
pub(crate) async fn excluded_from_connect_timeout<F>(fut: F) -> F::Output
where
    F: Future,
{
    let clock = CURRENT.try_with(Arc::clone).ok();
    if let Some(c) = &clock {
        c.pause();
    }
    let _guard = PauseGuard(clock);
    fut.await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn times_out_without_a_prompt() {
        let res = timeout_excluding_prompts(Duration::from_secs(5), async {
            tokio::time::sleep(Duration::from_secs(10)).await;
        })
        .await;
        assert_eq!(res, Err(Elapsed));
    }

    #[tokio::test(start_paused = true)]
    async fn completes_within_budget() {
        let res = timeout_excluding_prompts(Duration::from_secs(5), async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            7
        })
        .await;
        assert_eq!(res, Ok(7));
    }

    /// 4 s of network + 60 s of prompt + 4 s of network fits a 5 s budget
    /// because the prompt time is excluded.
    #[tokio::test(start_paused = true)]
    async fn prompt_time_is_not_charged() {
        let res = timeout_excluding_prompts(Duration::from_secs(5), async {
            tokio::time::sleep(Duration::from_secs(4)).await;
            excluded_from_connect_timeout(tokio::time::sleep(Duration::from_secs(60))).await;
            tokio::time::sleep(Duration::from_millis(900)).await;
            "done"
        })
        .await;
        assert_eq!(res, Ok("done"));
    }

    /// Network time after the prompt still counts: the budget is extended by the
    /// prompt time only, not reset.
    #[tokio::test(start_paused = true)]
    async fn budget_is_extended_not_reset() {
        let res = timeout_excluding_prompts(Duration::from_secs(5), async {
            tokio::time::sleep(Duration::from_secs(4)).await;
            excluded_from_connect_timeout(tokio::time::sleep(Duration::from_secs(60))).await;
            tokio::time::sleep(Duration::from_secs(2)).await;
        })
        .await;
        assert_eq!(res, Err(Elapsed));
    }

    /// A pause propagates to an enclosing (outer) deadline too.
    #[tokio::test(start_paused = true)]
    async fn nested_deadlines_are_all_paused() {
        let res = timeout_excluding_prompts(Duration::from_secs(5), async {
            timeout_excluding_prompts(Duration::from_secs(5), async {
                excluded_from_connect_timeout(tokio::time::sleep(Duration::from_secs(30))).await;
                1
            })
            .await
        })
        .await;
        assert_eq!(res, Ok(Ok(1)));
    }

    /// Outside any scope the helper is a plain await.
    #[tokio::test(start_paused = true)]
    async fn excluded_outside_scope_is_plain_await() {
        let v = excluded_from_connect_timeout(async { 3 }).await;
        assert_eq!(v, 3);
    }
}
