//! Per-session byte budget for output queued on the transport (#4439).
//!
//! A session's output pump writes each chunk into the transport's notification
//! channel, which the transport drains only as fast as stdout (the SSH channel)
//! accepts data. Without a bound, a fast producer (`yes`) fills that channel at
//! PTY speed for as long as it takes the desktop's `connection.output_flow`
//! pause to arrive, so the overshoot grows with *latency × PTY rate*.
//!
//! [`OutputBudget`] counts the bytes of one session's `connection.output`
//! notifications that are queued but not yet written. Every queued chunk holds
//! an [`OutputCredit`] (attached to its notification as a release guard) that
//! returns its bytes when the transport has written — or discarded — the
//! notification. Once [`OUTPUT_BUDGET_BYTES`] are queued the session pauses
//! itself, exactly as on a desktop pause: the in-process pump stops reading
//! the backend's bounded channel, a daemon-backed session is sent
//! `MSG_OUTPUT_FLOW`, and the PTY backpressures the program. It resumes once
//! the queue drained to [`OUTPUT_RESUME_BYTES`] (unless the desktop still holds
//! its own pause).
//!
//! The budget is per session and only ever holds back that session's producer:
//! other sessions' output, RPC responses and control notifications share the
//! channel uncharged, and never wait behind more than each session's budget.

use std::sync::{Arc, Mutex, MutexGuard};

use termihub_core::session::pump::OutputFlowGate;
use tokio::sync::watch;

/// Queued-but-unwritten output bytes at which a session pauses itself.
pub const OUTPUT_BUDGET_BYTES: usize = 512 * 1024;

/// Queued bytes at or below which a self-paused session resumes.
pub const OUTPUT_RESUME_BYTES: usize = 256 * 1024;

/// One session's output flow state: the desktop's pause plus the transport
/// byte budget, combined into one paused/flowing signal. Clones share state.
#[derive(Debug, Clone)]
pub struct OutputBudget {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    limit: usize,
    resume_at: usize,
    state: Mutex<State>,
    /// Combined paused state, for the daemon flow forwarder.
    paused: watch::Sender<bool>,
    /// Combined paused state, for the in-process output pump.
    gate: OutputFlowGate,
}

#[derive(Debug, Default)]
struct State {
    /// Bytes charged and not yet released.
    queued: usize,
    /// The desktop's `connection.output_flow` pause (#4416).
    desktop_paused: bool,
    /// The budget is exhausted (with hysteresis down to `resume_at`).
    over_budget: bool,
}

impl Default for OutputBudget {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputBudget {
    /// A flowing budget with the default limits.
    #[must_use]
    pub fn new() -> Self {
        Self::with_limits(OUTPUT_BUDGET_BYTES, OUTPUT_RESUME_BYTES)
    }

    /// A flowing budget that pauses at `limit` queued bytes and resumes at
    /// `resume_at` (clamped below `limit`).
    #[must_use]
    pub fn with_limits(limit: usize, resume_at: usize) -> Self {
        let limit = limit.max(1);
        Self {
            inner: Arc::new(Inner {
                limit,
                resume_at: resume_at.min(limit - 1),
                state: Mutex::new(State::default()),
                paused: watch::Sender::new(false),
                gate: OutputFlowGate::new(),
            }),
        }
    }

    /// Apply the desktop's pause (`true`) or resume (`false`).
    pub fn set_paused(&self, paused: bool) {
        self.inner.update(|s| s.desktop_paused = paused);
    }

    /// Drop the desktop's pause (the desktop detached or a new one attached).
    /// A pause held by the budget stays until the queue drains.
    pub fn resume(&self) {
        self.set_paused(false);
    }

    /// Whether output is currently paused, by the desktop or the budget.
    #[must_use]
    pub fn is_paused(&self) -> bool {
        *self.inner.paused.borrow()
    }

    /// Bytes currently charged and not yet released.
    #[must_use]
    pub fn queued(&self) -> usize {
        self.inner.lock().queued
    }

    /// The gate the in-process output pump waits on.
    #[must_use]
    pub fn gate(&self) -> OutputFlowGate {
        self.inner.gate.clone()
    }

    /// Watch the combined paused state. The watch closes once every clone of
    /// this budget and every outstanding credit is gone.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.inner.paused.subscribe()
    }

    /// Charge `bytes` of output about to be queued. The bytes count against the
    /// budget until the returned credit is dropped.
    #[must_use]
    pub fn charge(&self, bytes: usize) -> OutputCredit {
        self.inner.update(|s| s.queued = s.queued.saturating_add(bytes));
        OutputCredit {
            inner: self.inner.clone(),
            bytes,
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        // The state is a few counters updated atomically under the lock; a
        // panic elsewhere cannot leave it half-written.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Mutate the state and publish the resulting paused state.
    fn update(&self, f: impl FnOnce(&mut State)) {
        let mut state = self.lock();
        f(&mut state);
        if state.queued >= self.limit {
            state.over_budget = true;
        } else if state.queued <= self.resume_at {
            state.over_budget = false;
        }
        let paused = state.desktop_paused || state.over_budget;
        // Published under the lock so concurrent updates publish in order.
        self.paused.send_if_modified(|current| {
            let changed = *current != paused;
            *current = paused;
            changed
        });
        self.gate.set_paused(paused);
    }
}

/// Bytes of one queued output chunk; released back to the budget on drop.
#[derive(Debug)]
pub struct OutputCredit {
    inner: Arc<Inner>,
    bytes: usize,
}

impl Drop for OutputCredit {
    fn drop(&mut self) {
        let bytes = self.bytes;
        self.inner
            .update(|s| s.queued = s.queued.saturating_sub(bytes));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pauses_at_the_limit_and_resumes_at_the_low_watermark() {
        let budget = OutputBudget::with_limits(100, 40);
        let a = budget.charge(60);
        assert!(!budget.is_paused());
        let b = budget.charge(40);
        assert!(budget.is_paused(), "100 queued bytes reach the limit");
        assert!(budget.gate().is_paused(), "the pump gate mirrors the pause");
        drop(b);
        assert!(budget.is_paused(), "60 bytes are above the resume mark");
        let c = budget.charge(0);
        drop(a);
        assert_eq!(budget.queued(), 0);
        assert!(!budget.is_paused());
        assert!(!budget.gate().is_paused());
        drop(c);
    }

    #[test]
    fn desktop_and_budget_pauses_combine() {
        let budget = OutputBudget::with_limits(10, 5);
        budget.set_paused(true);
        assert!(budget.is_paused());
        let credit = budget.charge(10);
        budget.resume();
        assert!(budget.is_paused(), "the budget still holds the pause");
        budget.set_paused(true);
        drop(credit);
        assert!(budget.is_paused(), "the desktop still holds the pause");
        budget.resume();
        assert!(!budget.is_paused());
    }

    #[test]
    fn subscribers_see_transitions() {
        let budget = OutputBudget::with_limits(10, 5);
        let mut rx = budget.subscribe();
        let credit = budget.charge(10);
        assert!(rx.has_changed().unwrap());
        assert!(*rx.borrow_and_update());
        drop(credit);
        assert!(rx.has_changed().unwrap());
        assert!(!*rx.borrow_and_update());
    }
}
