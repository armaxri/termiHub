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
}
