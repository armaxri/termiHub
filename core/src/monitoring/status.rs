//! Monitoring status: the observable lifecycle state of a collector loop.
//!
//! A collector loop reports **stats** on one channel and its **status** on a
//! second channel (see [`MonitorStatusReceiver`]). The status makes a
//! mid-stream transport drop observable: instead of rendering frozen stats as
//! if live, the UI can show an explicit [`MonitorStatus::Stale`] arm (#1229,
//! audit gap G1).
//!
//! [`CollectLoopState`] owns the consecutive-failure counting and the
//! `Live`/`Stale` transitions so the loop stays a thin driver and the
//! transition logic is unit-testable without a real transport.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Observable lifecycle state of a monitoring collector loop.
///
/// Serialised in `camelCase` (e.g. `"live"`, `"stale"`) to match the
/// frontend's event payload convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MonitorStatus {
    /// Establishing the transport before the first collect.
    Connecting,
    /// Collecting successfully; stats are fresh.
    Live,
    /// The transport dropped mid-stream; the last stats are frozen and must
    /// not be shown as live (audit gap G1).
    Stale,
    /// Re-establishing the transport after it died (reserved for the reconnect
    /// stage; not yet driven by the collector loop).
    Reconnecting,
    /// Reconnect budget exhausted; the loop is idle awaiting a retry (reserved
    /// for the reconnect stage).
    Offline,
    /// Collection is paused by the user while the transport stays open
    /// (reserved for the pause/resume stage).
    Paused,
}

/// Async sender for [`MonitorStatus`] updates (used by collector loops).
pub type MonitorStatusSender = tokio::sync::mpsc::Sender<MonitorStatus>;

/// Async receiver for [`MonitorStatus`] updates.
pub type MonitorStatusReceiver = tokio::sync::mpsc::Receiver<MonitorStatus>;

/// Default number of consecutive collect failures before a `Live` loop is
/// declared [`MonitorStatus::Stale`].
///
/// One failure can be a transient hiccup; requiring a small run avoids
/// flapping the indicator on a single dropped sample.
pub const DEFAULT_STALE_THRESHOLD: u32 = 2;

/// Default first backoff delay before a reconnect attempt.
///
/// The schedule doubles this each attempt up to [`BACKOFF_CAP`].
pub const DEFAULT_BACKOFF_BASE: Duration = Duration::from_secs(1);

/// Upper bound on any single backoff delay.
///
/// Capping the exponential growth keeps a long-lived reconnect loop probing at
/// a sensible ceiling instead of drifting into multi-minute gaps.
pub const BACKOFF_CAP: Duration = Duration::from_secs(30);

/// Default number of reconnect attempts before the loop declares `Offline`.
///
/// With the default base/cap this spans roughly 1+2+4+8+16+30+30+30 s of
/// probing before giving up — long enough to ride out a transient drop, short
/// enough to resolve to `Offline` in bounded time (audit gap G2).
pub const DEFAULT_MAX_RECONNECT_ATTEMPTS: u32 = 8;

/// Capped exponential-backoff schedule for reconnect attempts.
///
/// Yields delays `base, base*2, base*4, …` clamped to `cap`, for at most
/// `max_attempts` attempts. Once the attempt budget is exhausted,
/// [`next_delay`](BackoffSchedule::next_delay) returns `None` so the caller
/// stops retrying and transitions to [`MonitorStatus::Offline`].
///
/// No maintained backoff crate is currently in the dependency tree; this is a
/// small, self-contained helper kept unit-testable in isolation.
#[derive(Debug, Clone)]
pub struct BackoffSchedule {
    base: Duration,
    cap: Duration,
    max_attempts: u32,
    attempt: u32,
}

impl BackoffSchedule {
    /// Create a schedule from an explicit base delay, cap, and attempt budget.
    ///
    /// `max_attempts` is clamped to `>= 1` so at least one reconnect is tried.
    pub fn new(base: Duration, cap: Duration, max_attempts: u32) -> Self {
        Self {
            base,
            cap,
            max_attempts: max_attempts.max(1),
            attempt: 0,
        }
    }

    /// The next backoff delay, or `None` once the attempt budget is exhausted.
    ///
    /// The first call returns `base`, then `base*2`, `base*4`, … each clamped
    /// to `cap`. After `max_attempts` calls it returns `None`.
    pub fn next_delay(&mut self) -> Option<Duration> {
        if self.attempt >= self.max_attempts {
            return None;
        }
        // Double `base` `attempt` times, saturating so a large shift cannot
        // overflow; clamp the result to `cap`.
        let factor = 1u64.checked_shl(self.attempt).unwrap_or(u64::MAX);
        let delay = self
            .base
            .checked_mul(factor.min(u32::MAX as u64) as u32)
            .unwrap_or(self.cap)
            .min(self.cap);
        self.attempt = self.attempt.saturating_add(1);
        Some(delay)
    }

    /// Reset the schedule so the next attempt starts again from `base`.
    ///
    /// Called after a successful reconnect so a later drop gets a fresh budget.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

impl Default for BackoffSchedule {
    fn default() -> Self {
        Self::new(
            DEFAULT_BACKOFF_BASE,
            BACKOFF_CAP,
            DEFAULT_MAX_RECONNECT_ATTEMPTS,
        )
    }
}

/// Tracks a collector loop's status across collect successes and failures.
///
/// The loop calls [`on_success`](CollectLoopState::on_success) after a good
/// collect and [`on_failure`](CollectLoopState::on_failure) after a failed
/// one. Each returns `Some(status)` **only when the status changed**, so the
/// loop emits an event exactly on transitions (not every tick).
///
/// Transitions owned here:
/// - `* → Live` on the first success after any non-live state.
/// - `Live → Stale` once `stale_threshold` consecutive failures accumulate.
///
/// Once `Stale`, the loop enters a bounded reconnect phase driven by
/// [`begin_reconnect`](CollectLoopState::begin_reconnect) (→ `Reconnecting`),
/// [`on_success`](CollectLoopState::on_success) (→ `Live` on recovery), and
/// [`exhaust_reconnect`](CollectLoopState::exhaust_reconnect) (→ `Offline` when
/// the backoff budget runs out) (audit gap G2).
#[derive(Debug)]
pub struct CollectLoopState {
    status: MonitorStatus,
    consecutive_failures: u32,
    stale_threshold: u32,
}

impl CollectLoopState {
    /// Create a loop-state starting in [`MonitorStatus::Connecting`] with the
    /// default stale threshold.
    pub fn new() -> Self {
        Self::with_threshold(DEFAULT_STALE_THRESHOLD)
    }

    /// Create a loop-state with an explicit stale threshold (clamped to >= 1).
    pub fn with_threshold(stale_threshold: u32) -> Self {
        Self {
            status: MonitorStatus::Connecting,
            consecutive_failures: 0,
            stale_threshold: stale_threshold.max(1),
        }
    }

    /// Current status.
    pub fn status(&self) -> MonitorStatus {
        self.status
    }

    /// Record a successful collect.
    ///
    /// Resets the failure run and, if the loop was not already `Live`,
    /// transitions to [`MonitorStatus::Live`] and returns it. Returns `None`
    /// when already `Live` (no change to emit).
    pub fn on_success(&mut self) -> Option<MonitorStatus> {
        self.consecutive_failures = 0;
        if self.status != MonitorStatus::Live {
            self.status = MonitorStatus::Live;
            Some(MonitorStatus::Live)
        } else {
            None
        }
    }

    /// Record a failed collect.
    ///
    /// Increments the failure run. Once `stale_threshold` consecutive failures
    /// are reached and the loop is currently `Live`, transitions to
    /// [`MonitorStatus::Stale`] and returns it. Returns `None` otherwise.
    pub fn on_failure(&mut self) -> Option<MonitorStatus> {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.status == MonitorStatus::Live && self.consecutive_failures >= self.stale_threshold {
            self.status = MonitorStatus::Stale;
            Some(MonitorStatus::Stale)
        } else {
            None
        }
    }

    /// Whether the loop should now begin a bounded reconnect.
    ///
    /// True once the collect run has reached `Stale` — i.e. the transport has
    /// stayed down for `stale_threshold` consecutive collects and the loop must
    /// re-dial rather than keep retrying the dead session (audit gap G2).
    pub fn should_begin_reconnect(&self) -> bool {
        self.status == MonitorStatus::Stale
    }

    /// Enter the reconnect phase.
    ///
    /// Transitions to [`MonitorStatus::Reconnecting`] and returns it, unless
    /// already `Reconnecting` (returns `None` — nothing new to emit). Called by
    /// the loop before its first re-dial attempt after going `Stale`.
    pub fn begin_reconnect(&mut self) -> Option<MonitorStatus> {
        if self.status != MonitorStatus::Reconnecting {
            self.status = MonitorStatus::Reconnecting;
            Some(MonitorStatus::Reconnecting)
        } else {
            None
        }
    }

    /// Give up reconnecting after the backoff budget is exhausted.
    ///
    /// Transitions to [`MonitorStatus::Offline`] and returns it, unless already
    /// `Offline` (returns `None`). The loop calls this when the
    /// [`BackoffSchedule`] yields no further delay (audit gap G2).
    pub fn exhaust_reconnect(&mut self) -> Option<MonitorStatus> {
        if self.status != MonitorStatus::Offline {
            self.status = MonitorStatus::Offline;
            self.consecutive_failures = 0;
            Some(MonitorStatus::Offline)
        } else {
            None
        }
    }
}

impl Default for CollectLoopState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_status_serialises_camel_case() {
        assert_eq!(
            serde_json::to_string(&MonitorStatus::Live).expect("serialise"),
            "\"live\""
        );
        assert_eq!(
            serde_json::to_string(&MonitorStatus::Stale).expect("serialise"),
            "\"stale\""
        );
        assert_eq!(
            serde_json::to_string(&MonitorStatus::Reconnecting).expect("serialise"),
            "\"reconnecting\""
        );
    }

    #[test]
    fn starts_in_connecting() {
        let state = CollectLoopState::new();
        assert_eq!(state.status(), MonitorStatus::Connecting);
    }

    #[test]
    fn first_success_transitions_to_live_and_emits() {
        let mut state = CollectLoopState::new();
        assert_eq!(state.on_success(), Some(MonitorStatus::Live));
        assert_eq!(state.status(), MonitorStatus::Live);
    }

    #[test]
    fn repeated_success_while_live_emits_nothing() {
        let mut state = CollectLoopState::new();
        state.on_success();
        assert_eq!(state.on_success(), None);
        assert_eq!(state.on_success(), None);
        assert_eq!(state.status(), MonitorStatus::Live);
    }

    #[test]
    fn consecutive_failures_flip_live_to_stale_at_threshold() {
        // Default threshold is 2: one failure is not yet stale.
        let mut state = CollectLoopState::new();
        state.on_success();

        assert_eq!(
            state.on_failure(),
            None,
            "one failure is a transient hiccup"
        );
        assert_eq!(state.status(), MonitorStatus::Live);

        assert_eq!(
            state.on_failure(),
            Some(MonitorStatus::Stale),
            "second consecutive failure flips to Stale"
        );
        assert_eq!(state.status(), MonitorStatus::Stale);
    }

    #[test]
    fn threshold_of_one_flips_on_first_failure() {
        let mut state = CollectLoopState::with_threshold(1);
        state.on_success();
        assert_eq!(state.on_failure(), Some(MonitorStatus::Stale));
    }

    #[test]
    fn recovery_from_stale_transitions_back_to_live() {
        let mut state = CollectLoopState::with_threshold(1);
        state.on_success();
        assert_eq!(state.on_failure(), Some(MonitorStatus::Stale));

        assert_eq!(
            state.on_success(),
            Some(MonitorStatus::Live),
            "a successful collect after Stale recovers to Live"
        );
        assert_eq!(state.status(), MonitorStatus::Live);
    }

    #[test]
    fn stays_stale_without_re_emitting_on_further_failures() {
        let mut state = CollectLoopState::with_threshold(1);
        state.on_success();
        assert_eq!(state.on_failure(), Some(MonitorStatus::Stale));
        // Already Stale: further failures must not re-emit Stale.
        assert_eq!(state.on_failure(), None);
        assert_eq!(state.on_failure(), None);
        assert_eq!(state.status(), MonitorStatus::Stale);
    }

    #[test]
    fn a_single_success_resets_the_failure_run() {
        // With threshold 2, a success between failures prevents Stale.
        let mut state = CollectLoopState::new();
        state.on_success();
        assert_eq!(state.on_failure(), None); // 1 failure
        assert_eq!(state.on_success(), None); // reset run, already Live
        assert_eq!(state.on_failure(), None); // 1 failure again, not stale
        assert_eq!(state.status(), MonitorStatus::Live);
    }

    // ── Reconnect transitions (audit gap G2) ───────────────────────────

    #[test]
    fn should_begin_reconnect_only_when_stale() {
        let mut state = CollectLoopState::with_threshold(1);
        assert!(!state.should_begin_reconnect(), "connecting is not stale");
        state.on_success();
        assert!(!state.should_begin_reconnect(), "live is not stale");
        state.on_failure(); // → Stale
        assert!(
            state.should_begin_reconnect(),
            "a stale loop must begin reconnecting"
        );
    }

    #[test]
    fn begin_reconnect_emits_reconnecting_once() {
        let mut state = CollectLoopState::with_threshold(1);
        state.on_success();
        state.on_failure(); // → Stale
        assert_eq!(state.begin_reconnect(), Some(MonitorStatus::Reconnecting));
        assert_eq!(state.status(), MonitorStatus::Reconnecting);
        // Already reconnecting: no repeat emit.
        assert_eq!(state.begin_reconnect(), None);
    }

    #[test]
    fn reconnect_recovery_transitions_back_to_live() {
        let mut state = CollectLoopState::with_threshold(1);
        state.on_success();
        state.on_failure(); // → Stale
        state.begin_reconnect(); // → Reconnecting
                                 // A successful collect after a re-dial recovers to Live.
        assert_eq!(
            state.on_success(),
            Some(MonitorStatus::Live),
            "a successful collect after reconnect recovers to Live"
        );
        assert_eq!(state.status(), MonitorStatus::Live);
    }

    #[test]
    fn exhausted_reconnect_transitions_to_offline() {
        let mut state = CollectLoopState::with_threshold(1);
        state.on_success();
        state.on_failure(); // → Stale
        state.begin_reconnect(); // → Reconnecting
        assert_eq!(
            state.exhaust_reconnect(),
            Some(MonitorStatus::Offline),
            "an exhausted backoff budget resolves to Offline"
        );
        assert_eq!(state.status(), MonitorStatus::Offline);
        // Already offline: no repeat emit.
        assert_eq!(state.exhaust_reconnect(), None);
    }

    #[test]
    fn offline_recovers_to_live_on_a_later_success() {
        let mut state = CollectLoopState::with_threshold(1);
        state.on_success();
        state.on_failure();
        state.begin_reconnect();
        state.exhaust_reconnect(); // → Offline
        assert_eq!(
            state.on_success(),
            Some(MonitorStatus::Live),
            "a later successful collect recovers from Offline to Live"
        );
    }

    // ── BackoffSchedule ────────────────────────────────────────────────

    #[test]
    fn backoff_doubles_from_base() {
        let mut b = BackoffSchedule::new(Duration::from_secs(1), Duration::from_secs(30), 8);
        assert_eq!(b.next_delay(), Some(Duration::from_secs(1)));
        assert_eq!(b.next_delay(), Some(Duration::from_secs(2)));
        assert_eq!(b.next_delay(), Some(Duration::from_secs(4)));
        assert_eq!(b.next_delay(), Some(Duration::from_secs(8)));
        assert_eq!(b.next_delay(), Some(Duration::from_secs(16)));
    }

    #[test]
    fn backoff_clamps_to_cap() {
        let mut b = BackoffSchedule::new(Duration::from_secs(1), Duration::from_secs(30), 8);
        // 1,2,4,8,16 then clamp at 30.
        for _ in 0..5 {
            b.next_delay();
        }
        assert_eq!(b.next_delay(), Some(Duration::from_secs(30)));
        assert_eq!(b.next_delay(), Some(Duration::from_secs(30)));
    }

    #[test]
    fn backoff_returns_none_when_exhausted() {
        let mut b = BackoffSchedule::new(Duration::from_secs(1), Duration::from_secs(30), 3);
        assert!(b.next_delay().is_some());
        assert!(b.next_delay().is_some());
        assert!(b.next_delay().is_some());
        assert_eq!(
            b.next_delay(),
            None,
            "the fourth attempt exceeds the 3-attempt budget"
        );
    }

    #[test]
    fn backoff_max_attempts_clamped_to_one() {
        let mut b = BackoffSchedule::new(Duration::from_secs(1), Duration::from_secs(30), 0);
        assert!(b.next_delay().is_some(), "at least one attempt is tried");
        assert_eq!(b.next_delay(), None);
    }

    #[test]
    fn backoff_reset_restarts_from_base() {
        let mut b = BackoffSchedule::new(Duration::from_secs(1), Duration::from_secs(30), 3);
        b.next_delay();
        b.next_delay();
        b.reset();
        assert_eq!(
            b.next_delay(),
            Some(Duration::from_secs(1)),
            "reset restarts the schedule at base"
        );
    }
}
