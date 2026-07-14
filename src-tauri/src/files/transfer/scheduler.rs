//! Pure per-session concurrency scheduler (issue #1336).
//!
//! Models the "at most `max_concurrent` transfers run at once per session; the
//! rest queue in FIFO order and are promoted as slots free" rule *without any
//! async or I/O*, so the slot accounting is unit-testable on its own. The async
//! executor drives a real [`SessionScheduler`] behind a `Mutex` and turns its
//! [`Admission`] / promotion decisions into task wake-ups.
//!
//! Default `max_concurrent` is 2 (concept default); it is configurable.

use std::collections::VecDeque;

/// Default number of simultaneously-active transfers per session.
pub const DEFAULT_MAX_CONCURRENT: usize = 2;

/// Outcome of requesting a slot for a transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// A slot was free — the transfer may start immediately (now Active).
    Run,
    /// No free slot — the transfer is enqueued and stays Queued until promoted.
    Queue,
}

/// FIFO slot accounting for one session's transfers.
///
/// Tracks how many transfers are currently Active and which ids are waiting.
/// It does not know about pause/fail/retry beyond slot occupancy: releasing a
/// slot (for *any* reason — completion, pause, cancel, failure) may promote the
/// next queued id.
#[derive(Debug)]
pub struct SessionScheduler {
    max_concurrent: usize,
    active: usize,
    waiting: VecDeque<String>,
}

impl SessionScheduler {
    /// Create a scheduler with the given concurrency cap (min 1).
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            max_concurrent: max_concurrent.max(1),
            active: 0,
            waiting: VecDeque::new(),
        }
    }

    /// Number of transfers currently holding a slot.
    pub fn active(&self) -> usize {
        self.active
    }

    /// Number of transfers waiting for a slot.
    pub fn waiting(&self) -> usize {
        self.waiting.len()
    }

    /// The configured concurrency cap.
    pub fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }

    /// Whether this session has no active or waiting transfers (safe to drop).
    pub fn is_idle(&self) -> bool {
        self.active == 0 && self.waiting.is_empty()
    }

    /// Request a slot for `id`. Grants it ([`Admission::Run`]) if under the cap,
    /// otherwise enqueues `id` at the back and returns [`Admission::Queue`].
    pub fn request(&mut self, id: &str) -> Admission {
        if self.active < self.max_concurrent {
            self.active += 1;
            Admission::Run
        } else {
            self.waiting.push_back(id.to_string());
            Admission::Queue
        }
    }

    /// Release the slot held by an *active* transfer and, if anyone is waiting,
    /// promote the front of the queue (keeping `active` constant in that case).
    ///
    /// Returns the id of the promoted transfer, if any — the caller wakes that
    /// transfer's task so it can begin moving bytes.
    pub fn release(&mut self) -> Option<String> {
        // Guard against double-release underflow (poison-adjacent safety).
        self.active = self.active.saturating_sub(1);
        if let Some(next) = self.waiting.pop_front() {
            self.active += 1;
            Some(next)
        } else {
            None
        }
    }

    /// Remove a *waiting* (not yet promoted) id — used when a queued transfer is
    /// cancelled before it ever ran. Returns `true` if it was waiting. Does not
    /// touch `active` (a queued transfer holds no slot).
    pub fn remove_waiting(&mut self, id: &str) -> bool {
        if let Some(pos) = self.waiting.iter().position(|x| x == id) {
            self.waiting.remove(pos);
            true
        } else {
            false
        }
    }

    /// Re-queue an id at the back (used by auto/manual retry of a failed
    /// transfer). If a slot is free it is granted immediately.
    pub fn requeue(&mut self, id: &str) -> Admission {
        self.request(id)
    }
}

impl Default for SessionScheduler {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_CONCURRENT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_run_immediately_third_queues() {
        let mut s = SessionScheduler::new(2);
        assert_eq!(s.request("a"), Admission::Run);
        assert_eq!(s.request("b"), Admission::Run);
        assert_eq!(s.request("c"), Admission::Queue, "3rd exceeds cap → queued");
        assert_eq!(s.active(), 2);
        assert_eq!(s.waiting(), 1);
    }

    #[test]
    fn completing_one_promotes_the_queued() {
        let mut s = SessionScheduler::new(2);
        s.request("a");
        s.request("b");
        s.request("c"); // queued

        // 'a' completes → 'c' is promoted, active stays at 2.
        assert_eq!(s.release(), Some("c".to_string()));
        assert_eq!(s.active(), 2);
        assert_eq!(s.waiting(), 0);
    }

    #[test]
    fn promotion_is_fifo() {
        let mut s = SessionScheduler::new(1);
        s.request("a"); // Run
        s.request("b"); // Queue
        s.request("c"); // Queue
        assert_eq!(s.release(), Some("b".to_string()), "oldest waiter first");
        assert_eq!(s.release(), Some("c".to_string()));
        assert_eq!(s.release(), None, "queue drained");
    }

    #[test]
    fn release_with_empty_queue_frees_a_slot() {
        let mut s = SessionScheduler::new(2);
        s.request("a");
        assert_eq!(s.release(), None);
        assert_eq!(s.active(), 0);
        // A slot is now free again.
        assert_eq!(s.request("b"), Admission::Run);
    }

    #[test]
    fn cancel_a_queued_transfer_removes_it_without_touching_slots() {
        let mut s = SessionScheduler::new(1);
        s.request("a"); // Run
        s.request("b"); // Queue
        s.request("c"); // Queue
        assert!(s.remove_waiting("b"));
        assert_eq!(s.active(), 1);
        // Releasing 'a' now promotes 'c' (b was removed), preserving FIFO.
        assert_eq!(s.release(), Some("c".to_string()));
    }

    #[test]
    fn remove_waiting_unknown_is_false() {
        let mut s = SessionScheduler::new(1);
        s.request("a");
        assert!(!s.remove_waiting("nope"));
    }

    #[test]
    fn zero_cap_is_clamped_to_one() {
        let mut s = SessionScheduler::new(0);
        assert_eq!(s.max_concurrent(), 1);
        assert_eq!(s.request("a"), Admission::Run);
        assert_eq!(s.request("b"), Admission::Queue);
    }

    #[test]
    fn release_never_underflows() {
        let mut s = SessionScheduler::new(2);
        // Release without any active transfer must not panic / underflow.
        assert_eq!(s.release(), None);
        assert_eq!(s.active(), 0);
    }

    #[test]
    fn requeue_of_failed_grants_slot_when_free() {
        let mut s = SessionScheduler::new(2);
        s.request("a");
        // 'a' failed and released its slot.
        s.release();
        // Auto-retry re-queues it; a slot is free so it runs.
        assert_eq!(s.requeue("a"), Admission::Run);
        assert_eq!(s.active(), 1);
    }

    #[test]
    fn is_idle_reflects_active_and_waiting() {
        let mut s = SessionScheduler::new(1);
        assert!(s.is_idle());
        s.request("a");
        assert!(!s.is_idle());
        s.request("b"); // queued
        assert!(!s.is_idle());
        s.remove_waiting("b");
        s.release();
        assert!(s.is_idle());
    }
}
