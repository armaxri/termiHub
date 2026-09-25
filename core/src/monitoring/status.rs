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

use crate::reconnect_backoff::{
    reconnect_reducer, BackoffConfig, ReconnectEvent, ReconnectPhase, ReconnectState,
    INITIAL_RECONNECT_STATE,
};

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
    /// Terminal: the reconnect budget was exhausted, or the transport is up but
    /// the remote never answered with parseable output (#3252). The loop has
    /// ended and awaits a manual retry.
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

/// Multiplier on the stale threshold that bounds consecutive *transport*
/// failures (collect timeout / exec error) before the loop has produced a
/// sample since (re)connecting (#3300).
///
/// Before `Live` — `Connecting`, or `Reconnecting` after a re-dial that
/// succeeded — a run of `stale_threshold * PRE_LIVE_FAILURE_LIMIT_FACTOR`
/// consecutive failures resolves to the terminal [`MonitorStatus::Offline`]
/// instead of hanging forever. The bound is deliberately more generous than the
/// parse bound (`stale_threshold`, #3252): an unparseable answer is proof the
/// remote cannot be monitored, whereas a timeout can be a slow first collect
/// (cold SSH exec, a loaded host) that a monitor must survive. With the defaults
/// that is 6 collects, i.e. at least `6 × (interval + collect timeout)` of
/// wall-clock time before giving up.
///
/// A multiple of the stale threshold (rather than the reconnect attempt budget,
/// [`DEFAULT_MAX_RECONNECT_ATTEMPTS`]) because it counts *collect ticks*, the
/// same unit as `stale_threshold`, and so scales with a caller's threshold;
/// the reconnect budget counts backoff re-dials, whose wall-clock span is set by
/// the backoff schedule rather than the collect cadence.
pub const PRE_LIVE_FAILURE_LIMIT_FACTOR: u32 = 3;

// The transport bound must stay strictly more generous than the parse bound.
const _: () = assert!(PRE_LIVE_FAILURE_LIMIT_FACTOR > 1);

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
/// A thin wrapper over the canonical reconnect engine
/// ([`crate::reconnect_backoff`], SM-020 slice 1): it drives
/// [`reconnect_reducer`] with a jitterless [`BackoffConfig`] and reads the armed
/// backoff delay off each `Waiting` phase, so monitoring shares one reconnect
/// model with the rest of the workspace instead of hand-rolling the math.
///
/// Yields delays `base, base*2, base*4, …` clamped to `cap`, for at most
/// `max_attempts` attempts. Once the attempt budget is exhausted (the reducer
/// reaches [`ReconnectPhase::Gaveup`]), [`next_delay`](BackoffSchedule::next_delay)
/// returns `None` so the caller stops retrying and transitions to
/// [`MonitorStatus::Offline`].
///
/// Monitoring keeps `jitter_ratio: 0`, so the sequence is deterministic and
/// byte-identical to the hand-rolled capped-exponential this replaced; the
/// golden-vector tests pin that equivalence.
#[derive(Debug, Clone)]
pub struct BackoffSchedule {
    config: BackoffConfig,
    state: ReconnectState,
    /// Whether the first backoff window has been armed. The first `next_delay`
    /// arms it via a `Drop`; each later call simulates a failed attempt to arm
    /// the next window.
    started: bool,
}

impl BackoffSchedule {
    /// Create a schedule from an explicit base delay, cap, and attempt budget.
    ///
    /// `max_attempts` is clamped to `>= 1` so at least one reconnect is tried —
    /// the canonical engine reads `0` as its retry-forever sentinel, which the
    /// monitoring loop never wants.
    pub fn new(base: Duration, cap: Duration, max_attempts: u32) -> Self {
        let config = BackoffConfig {
            base_delay_ms: base.as_millis() as f64,
            factor: 2.0,
            max_delay_ms: cap.as_millis() as f64,
            max_attempts: i64::from(max_attempts.max(1)),
            jitter_ratio: 0.0,
        };
        Self {
            config,
            state: INITIAL_RECONNECT_STATE,
            started: false,
        }
    }

    /// The next backoff delay, or `None` once the attempt budget is exhausted.
    ///
    /// The first call returns `base`, then `base*2`, `base*4`, … each clamped
    /// to `cap`. After `max_attempts` calls it returns `None`.
    pub fn next_delay(&mut self) -> Option<Duration> {
        let mut no_jitter = || 0.0;
        if !self.started {
            // The first drop arms the first backoff window.
            self.state = reconnect_reducer(
                &self.state,
                ReconnectEvent::Drop,
                &self.config,
                &mut no_jitter,
            );
            self.started = true;
        } else {
            // Each subsequent delay follows a failed attempt: the timer fires
            // (`Attempt`), then the attempt fails (`Failure`), which either arms
            // the next backoff window or gives up once the budget is spent.
            self.state = reconnect_reducer(
                &self.state,
                ReconnectEvent::Attempt,
                &self.config,
                &mut no_jitter,
            );
            self.state = reconnect_reducer(
                &self.state,
                ReconnectEvent::Failure,
                &self.config,
                &mut no_jitter,
            );
        }
        match self.state.phase {
            ReconnectPhase::Waiting => {
                Some(Duration::from_millis(self.state.delay_ms.max(0) as u64))
            }
            _ => None,
        }
    }

    /// Reset the schedule so the next attempt starts again from `base`.
    ///
    /// Called after a successful reconnect so a later drop gets a fresh budget.
    pub fn reset(&mut self) {
        self.state = INITIAL_RECONNECT_STATE;
        self.started = false;
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
/// - `Connecting`/`Reconnecting → Offline` once `stale_threshold` consecutive
///   *parse* failures accumulate before a sample was produced
///   ([`on_parse_failure`](CollectLoopState::on_parse_failure), #3252).
/// - `Connecting`/`Reconnecting → Offline` once
///   [`pre_live_failure_limit`](CollectLoopState::pre_live_failure_limit)
///   consecutive failures of any kind accumulate before a sample was produced
///   ([`on_failure`](CollectLoopState::on_failure), #3300), so no loop can
///   stay `Connecting`/`Reconnecting` indefinitely.
/// - `* → Paused` on [`pause`](CollectLoopState::pause); `Paused → Live` on
///   [`resume`](CollectLoopState::resume). Pausing keeps the transport open and
///   only stops collection, so a paused monitor shows a neutral badge rather
///   than stale/live numbers (#1233).
///
/// Once `Stale`, the loop enters a bounded reconnect phase driven by
/// [`begin_reconnect`](CollectLoopState::begin_reconnect) (→ `Reconnecting`),
/// [`on_success`](CollectLoopState::on_success) (→ `Live` on recovery), and
/// [`exhaust_reconnect`](CollectLoopState::exhaust_reconnect) (→ `Offline` when
/// the backoff budget runs out) (audit gap G2).
#[derive(Debug)]
pub struct CollectLoopState {
    status: MonitorStatus,
    /// Consecutive failed collects of any kind (transport or parse).
    consecutive_failures: u32,
    /// Consecutive *parse* failures; a transport failure breaks the run.
    consecutive_parse_failures: u32,
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
            consecutive_parse_failures: 0,
            stale_threshold: stale_threshold.max(1),
        }
    }

    /// Consecutive failures (of any kind) tolerated before the loop has
    /// produced a sample since (re)connecting; reaching it resolves `Offline`.
    ///
    /// `stale_threshold * PRE_LIVE_FAILURE_LIMIT_FACTOR` — see
    /// [`PRE_LIVE_FAILURE_LIMIT_FACTOR`] for why it is more generous than the
    /// parse bound (#3300).
    pub fn pre_live_failure_limit(&self) -> u32 {
        self.stale_threshold
            .saturating_mul(PRE_LIVE_FAILURE_LIMIT_FACTOR)
    }

    /// Reset both failure runs (a success, pause, resume, or fresh re-dial).
    fn reset_failures(&mut self) {
        self.consecutive_failures = 0;
        self.consecutive_parse_failures = 0;
    }

    /// Resolve to the terminal [`MonitorStatus::Offline`] and return it.
    fn resolve_offline(&mut self) -> Option<MonitorStatus> {
        self.status = MonitorStatus::Offline;
        self.reset_failures();
        Some(MonitorStatus::Offline)
    }

    /// Current status.
    pub fn status(&self) -> MonitorStatus {
        self.status
    }

    /// Record a successful collect.
    ///
    /// Resets the failure run and, if the loop was not already `Live`,
    /// transitions to [`MonitorStatus::Live`] and returns it. Returns `None`
    /// when already `Live` (no change to emit). A `Paused` loop ignores this —
    /// resuming is driven explicitly via [`resume`](CollectLoopState::resume).
    pub fn on_success(&mut self) -> Option<MonitorStatus> {
        if self.status == MonitorStatus::Paused {
            return None;
        }
        self.reset_failures();
        if self.status != MonitorStatus::Live {
            self.status = MonitorStatus::Live;
            Some(MonitorStatus::Live)
        } else {
            None
        }
    }

    /// Pause collection while keeping the transport open (#1233).
    ///
    /// Transitions to [`MonitorStatus::Paused`] and returns it, unless already
    /// `Paused` (returns `None`). The failure run is reset so resuming starts
    /// from a clean slate.
    pub fn pause(&mut self) -> Option<MonitorStatus> {
        if self.status != MonitorStatus::Paused {
            self.status = MonitorStatus::Paused;
            self.reset_failures();
            Some(MonitorStatus::Paused)
        } else {
            None
        }
    }

    /// Resume collection after a pause (#1233).
    ///
    /// Transitions back to [`MonitorStatus::Live`] and returns it, but only when
    /// currently `Paused` (returns `None` otherwise). The next successful
    /// collect then keeps the loop `Live`.
    pub fn resume(&mut self) -> Option<MonitorStatus> {
        if self.status == MonitorStatus::Paused {
            self.status = MonitorStatus::Live;
            self.reset_failures();
            Some(MonitorStatus::Live)
        } else {
            None
        }
    }

    /// Whether the loop is currently paused (transport open, collection halted).
    pub fn is_paused(&self) -> bool {
        self.status == MonitorStatus::Paused
    }

    /// Record a failed collect (a transport-level failure: timeout, exec error,
    /// or — for an inferred loop — a missed sample).
    ///
    /// Increments the failure run and breaks any consecutive parse-failure run.
    ///
    /// - `Live`: once `stale_threshold` consecutive failures are reached,
    ///   transitions to [`MonitorStatus::Stale`] and returns it.
    /// - `Connecting`, or `Reconnecting` after a re-dial that succeeded (no
    ///   sample yet on this transport): once
    ///   [`pre_live_failure_limit`](CollectLoopState::pre_live_failure_limit)
    ///   consecutive failures are reached, resolves to the terminal
    ///   [`MonitorStatus::Offline`] and returns it (#3300). The caller ends the
    ///   loop, as for an exhausted reconnect budget.
    /// - `Paused` / `Offline` / `Stale`: no transition (`Paused` does not count
    ///   the failure at all).
    pub fn on_failure(&mut self) -> Option<MonitorStatus> {
        match self.status {
            MonitorStatus::Paused | MonitorStatus::Offline => None,
            MonitorStatus::Connecting | MonitorStatus::Reconnecting => {
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                self.consecutive_parse_failures = 0;
                if self.consecutive_failures >= self.pre_live_failure_limit() {
                    self.resolve_offline()
                } else {
                    None
                }
            }
            MonitorStatus::Live | MonitorStatus::Stale => {
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                self.consecutive_parse_failures = 0;
                if self.status == MonitorStatus::Live
                    && self.consecutive_failures >= self.stale_threshold
                {
                    self.status = MonitorStatus::Stale;
                    Some(MonitorStatus::Stale)
                } else {
                    None
                }
            }
        }
    }

    /// Record a collect whose transport answered but whose output could not be
    /// parsed (#3252).
    ///
    /// Once the loop is `Live` this is an ordinary failure (see
    /// [`on_failure`](CollectLoopState::on_failure)): a sustained run goes
    /// `Stale` and begins the bounded reconnect.
    ///
    /// Before the loop has produced a sample since (re)connecting — i.e. while
    /// `Connecting`, or `Reconnecting` after a re-dial that succeeded — a
    /// reconnect cannot help: the transport is up and the remote keeps
    /// answering with unusable data. Without this transition such a loop would
    /// hang in `Connecting` forever with no error surfaced. So once
    /// `stale_threshold` consecutive parse failures accumulate pre-`Live`, the
    /// loop resolves to [`MonitorStatus::Offline`] (terminal; the caller ends
    /// the loop) and returns it. A successful parse at any point resets the run
    /// via [`on_success`](CollectLoopState::on_success). A `Paused` loop ignores
    /// this, like every other collect result.
    ///
    /// The parse bound counts *consecutive parse* failures; a transport failure
    /// in between restarts it. Every parse failure still counts toward the
    /// generous pre-`Live` bound shared with
    /// [`on_failure`](CollectLoopState::on_failure) (#3300), so an alternating
    /// timeout/garbage run also resolves.
    pub fn on_parse_failure(&mut self) -> Option<MonitorStatus> {
        match self.status {
            MonitorStatus::Connecting | MonitorStatus::Reconnecting => {
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                self.consecutive_parse_failures = self.consecutive_parse_failures.saturating_add(1);
                if self.consecutive_parse_failures >= self.stale_threshold
                    || self.consecutive_failures >= self.pre_live_failure_limit()
                {
                    self.resolve_offline()
                } else {
                    None
                }
            }
            MonitorStatus::Paused | MonitorStatus::Offline => None,
            MonitorStatus::Live | MonitorStatus::Stale => self.on_failure(),
        }
    }

    /// Whether the loop has resolved to the terminal
    /// [`MonitorStatus::Offline`] state and should stop collecting.
    pub fn is_offline(&self) -> bool {
        self.status == MonitorStatus::Offline
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
            // A fresh run: failures counted on the way to `Stale` must not
            // also count against the re-dialled transport (#3252).
            self.reset_failures();
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
            self.resolve_offline()
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

    // ── Pre-Live unparseable output (#3252) ────────────────────────────

    #[test]
    fn pre_live_parse_failures_below_threshold_stay_connecting() {
        let mut state = CollectLoopState::with_threshold(3);
        assert_eq!(state.on_parse_failure(), None);
        assert_eq!(state.on_parse_failure(), None);
        assert_eq!(
            state.status(),
            MonitorStatus::Connecting,
            "fewer than `threshold` parse failures keep the loop Connecting"
        );
        assert!(!state.is_offline());
    }

    #[test]
    fn pre_live_parse_failures_at_threshold_resolve_offline() {
        let mut state = CollectLoopState::with_threshold(3);
        state.on_parse_failure();
        state.on_parse_failure();
        assert_eq!(
            state.on_parse_failure(),
            Some(MonitorStatus::Offline),
            "a connected-but-never-parseable remote must not hang in Connecting"
        );
        assert_eq!(state.status(), MonitorStatus::Offline);
        assert!(state.is_offline());
        // Terminal: further parse failures do not re-emit.
        assert_eq!(state.on_parse_failure(), None);
        assert!(
            !state.should_begin_reconnect(),
            "a pre-Live parse failure must not start a reconnect campaign"
        );
    }

    #[test]
    fn pre_live_parse_failures_use_default_stale_threshold() {
        let mut state = CollectLoopState::new();
        for _ in 1..DEFAULT_STALE_THRESHOLD {
            assert_eq!(state.on_parse_failure(), None);
        }
        assert_eq!(state.on_parse_failure(), Some(MonitorStatus::Offline));
    }

    #[test]
    fn a_successful_parse_resets_the_pre_live_failure_run() {
        let mut state = CollectLoopState::with_threshold(2);
        assert_eq!(state.on_parse_failure(), None); // 1 failure
        assert_eq!(state.on_success(), Some(MonitorStatus::Live)); // reset
                                                                   // Back to a clean slate: Live parse failures follow the Stale path.
        assert_eq!(state.on_parse_failure(), None);
        assert_eq!(
            state.on_parse_failure(),
            Some(MonitorStatus::Stale),
            "once Live, sustained parse failures go Stale (and reconnect) as before"
        );
    }

    // ── Pre-Live / post-re-dial transport failures (#3300) ─────────────

    #[test]
    fn pre_live_failure_limit_is_a_multiple_of_the_stale_threshold() {
        assert_eq!(
            CollectLoopState::with_threshold(2).pre_live_failure_limit(),
            2 * PRE_LIVE_FAILURE_LIMIT_FACTOR
        );
        assert_eq!(
            CollectLoopState::new().pre_live_failure_limit(),
            DEFAULT_STALE_THRESHOLD * PRE_LIVE_FAILURE_LIMIT_FACTOR
        );
    }

    #[test]
    fn pre_live_transport_failures_below_the_generous_bound_stay_connecting() {
        // A slow first collect must not kill a monitor: well past the parse
        // bound (`stale_threshold`), plain collect failures keep Connecting.
        let mut state = CollectLoopState::with_threshold(2);
        for _ in 1..state.pre_live_failure_limit() {
            assert_eq!(state.on_failure(), None);
        }
        assert_eq!(state.status(), MonitorStatus::Connecting);
        assert!(!state.is_offline());
    }

    #[test]
    fn pre_live_transport_failures_at_the_generous_bound_resolve_offline() {
        let mut state = CollectLoopState::with_threshold(2);
        for _ in 1..state.pre_live_failure_limit() {
            state.on_failure();
        }
        assert_eq!(
            state.on_failure(),
            Some(MonitorStatus::Offline),
            "a transport that never yields a first sample must not hang in Connecting"
        );
        assert!(state.is_offline());
        assert!(
            !state.should_begin_reconnect(),
            "a pre-Live Offline is terminal, not a reconnect campaign"
        );
        // Terminal: further failures do not re-emit.
        assert_eq!(state.on_failure(), None);
    }

    #[test]
    fn pre_live_transport_failures_use_the_default_bound() {
        let mut state = CollectLoopState::new();
        let limit = DEFAULT_STALE_THRESHOLD * PRE_LIVE_FAILURE_LIMIT_FACTOR;
        for _ in 1..limit {
            assert_eq!(state.on_failure(), None);
        }
        assert_eq!(state.on_failure(), Some(MonitorStatus::Offline));
    }

    #[test]
    fn a_success_resets_the_pre_live_transport_failure_run() {
        let mut state = CollectLoopState::with_threshold(1);
        let limit = state.pre_live_failure_limit();
        for _ in 1..limit {
            state.on_failure();
        }
        assert_eq!(state.on_success(), Some(MonitorStatus::Live));
        // Once Live the Stale path applies (threshold 1 → Stale on first).
        assert_eq!(state.on_failure(), Some(MonitorStatus::Stale));
        assert_eq!(state.begin_reconnect(), Some(MonitorStatus::Reconnecting));
        // The earlier pre-Live run does not count against the re-dialled one.
        for _ in 1..limit {
            assert_eq!(state.on_failure(), None);
        }
        assert_eq!(state.status(), MonitorStatus::Reconnecting);
    }

    #[test]
    fn transport_failures_after_a_successful_re_dial_resolve_offline() {
        // Live → Stale → Reconnecting; the re-dial succeeded, but every collect
        // on the fresh transport still fails: bounded, not Reconnecting forever.
        let mut state = CollectLoopState::with_threshold(2);
        state.on_success();
        state.on_failure();
        assert_eq!(state.on_failure(), Some(MonitorStatus::Stale));
        assert_eq!(state.begin_reconnect(), Some(MonitorStatus::Reconnecting));
        for _ in 1..state.pre_live_failure_limit() {
            assert_eq!(state.on_failure(), None);
        }
        assert_eq!(state.on_failure(), Some(MonitorStatus::Offline));
        assert!(state.is_offline());
    }

    #[test]
    fn transport_failures_while_paused_are_ignored() {
        let mut state = CollectLoopState::with_threshold(1);
        state.pause();
        for _ in 0..(state.pre_live_failure_limit() * 2) {
            assert_eq!(state.on_failure(), None);
        }
        assert_eq!(state.status(), MonitorStatus::Paused);
        // Resuming starts from a clean slate: one failure does not go Offline.
        assert_eq!(state.resume(), Some(MonitorStatus::Live));
        assert_eq!(state.status(), MonitorStatus::Live);
    }

    #[test]
    fn a_transport_failure_breaks_a_consecutive_parse_failure_run() {
        // The strict parse bound counts *consecutive* parse failures: a timeout
        // in between restarts it (the generous transport bound still applies).
        let mut state = CollectLoopState::with_threshold(2);
        assert_eq!(state.on_parse_failure(), None);
        assert_eq!(state.on_failure(), None);
        assert_eq!(
            state.on_parse_failure(),
            None,
            "timeout between parse failures restarts the parse run"
        );
        assert_eq!(state.status(), MonitorStatus::Connecting);
        assert_eq!(state.on_parse_failure(), Some(MonitorStatus::Offline));
    }

    #[test]
    fn mixed_pre_live_failures_resolve_offline_at_the_generous_bound() {
        // Alternating timeout / garbage never reaches the parse bound but must
        // still resolve: every failure counts toward the transport bound.
        let mut state = CollectLoopState::with_threshold(2);
        let limit = state.pre_live_failure_limit();
        let mut last = None;
        for i in 0..limit {
            last = if i % 2 == 0 {
                state.on_failure()
            } else {
                state.on_parse_failure()
            };
        }
        assert_eq!(last, Some(MonitorStatus::Offline));
    }

    #[test]
    fn parse_failures_after_a_reconnect_resolve_offline() {
        // Live → Stale → Reconnecting; the re-dial succeeded but the remote
        // still only answers garbage: that must also resolve in bounded time.
        let mut state = CollectLoopState::with_threshold(2);
        state.on_success();
        state.on_parse_failure();
        assert_eq!(state.on_parse_failure(), Some(MonitorStatus::Stale));
        assert_eq!(state.begin_reconnect(), Some(MonitorStatus::Reconnecting));
        // begin_reconnect starts a fresh run: one failure is not yet terminal.
        assert_eq!(state.on_parse_failure(), None);
        assert_eq!(state.status(), MonitorStatus::Reconnecting);
        assert_eq!(state.on_parse_failure(), Some(MonitorStatus::Offline));
    }

    #[test]
    fn parse_failures_while_paused_do_not_change_status() {
        let mut state = CollectLoopState::with_threshold(1);
        state.pause();
        assert_eq!(state.on_parse_failure(), None);
        assert_eq!(state.status(), MonitorStatus::Paused);
    }

    #[test]
    fn offline_from_parse_failure_recovers_on_a_later_success() {
        let mut state = CollectLoopState::with_threshold(1);
        assert_eq!(state.on_parse_failure(), Some(MonitorStatus::Offline));
        assert_eq!(state.on_success(), Some(MonitorStatus::Live));
    }

    // ── Pause / Resume (#1233) ─────────────────────────────────────────

    #[test]
    fn pause_from_live_emits_paused_once() {
        let mut state = CollectLoopState::new();
        state.on_success(); // → Live
        assert_eq!(state.pause(), Some(MonitorStatus::Paused));
        assert_eq!(state.status(), MonitorStatus::Paused);
        assert!(state.is_paused());
        // Already paused: no repeat emit.
        assert_eq!(state.pause(), None);
    }

    #[test]
    fn resume_from_paused_emits_live_once() {
        let mut state = CollectLoopState::new();
        state.on_success(); // → Live
        state.pause(); // → Paused
        assert_eq!(state.resume(), Some(MonitorStatus::Live));
        assert_eq!(state.status(), MonitorStatus::Live);
        assert!(!state.is_paused());
        // Already live: resume is a no-op.
        assert_eq!(state.resume(), None);
    }

    #[test]
    fn while_paused_collect_results_do_not_change_status() {
        let mut state = CollectLoopState::new();
        state.on_success(); // → Live
        state.pause(); // → Paused
                       // A stray success or failure while paused must not flip the status:
                       // pausing means "stop collecting", not "collect and ignore".
        assert_eq!(state.on_success(), None);
        assert_eq!(state.status(), MonitorStatus::Paused);
        assert_eq!(state.on_failure(), None);
        assert_eq!(state.status(), MonitorStatus::Paused);
    }

    #[test]
    fn resume_does_nothing_when_not_paused() {
        let mut state = CollectLoopState::new();
        state.on_success(); // → Live
        assert_eq!(state.resume(), None, "resume only acts on a paused loop");
        assert_eq!(state.status(), MonitorStatus::Live);
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

    // ── Golden vector: canonical-engine migration (SM-020 slice 1) ──────
    //
    // These pin the EXACT delay sequence the monitoring backoff produces, so
    // migrating `BackoffSchedule` onto the canonical `reconnect_backoff` engine
    // is proven behavior-preserving: with jitter disabled the schedule must stay
    // byte-identical to the hand-rolled capped-exponential it replaced.

    /// The monitoring reconnect budget's delays, in whole seconds, for its
    /// production configuration (base 1s, factor 2, cap 30s, 8 attempts).
    const MONITORING_GOLDEN_DELAYS_SECS: [u64; 8] = [1, 2, 4, 8, 16, 30, 30, 30];

    #[test]
    fn golden_vector_monitoring_backoff_sequence_then_give_up() {
        let mut schedule = BackoffSchedule::default();
        let mut got = Vec::new();
        while let Some(delay) = schedule.next_delay() {
            got.push(delay);
        }
        let expected: Vec<Duration> = MONITORING_GOLDEN_DELAYS_SECS
            .iter()
            .map(|s| Duration::from_secs(*s))
            .collect();
        assert_eq!(
            got, expected,
            "monitoring backoff must yield exactly 1,2,4,8,16,30,30,30 s then give up"
        );
    }

    #[test]
    fn golden_vector_canonical_reducer_matches_monitoring_sequence() {
        use crate::reconnect_backoff::{
            reconnect_reducer, BackoffConfig, ReconnectEvent, ReconnectPhase,
            INITIAL_RECONNECT_STATE,
        };
        // Exactly monitoring's numbers, jitter disabled → deterministic.
        let config = BackoffConfig {
            base_delay_ms: 1_000.0,
            factor: 2.0,
            max_delay_ms: 30_000.0,
            max_attempts: DEFAULT_MAX_RECONNECT_ATTEMPTS as i64,
            jitter_ratio: 0.0,
        };
        let mut no_jitter = || 0.0;
        let mut state = INITIAL_RECONNECT_STATE;
        let mut delays = Vec::new();

        // The first drop arms the first backoff window; each subsequent window is
        // armed by a failed attempt (the timer fires, the attempt fails).
        state = reconnect_reducer(&state, ReconnectEvent::Drop, &config, &mut no_jitter);
        while state.phase == ReconnectPhase::Waiting {
            delays.push(state.delay_ms);
            state = reconnect_reducer(&state, ReconnectEvent::Attempt, &config, &mut no_jitter);
            state = reconnect_reducer(&state, ReconnectEvent::Failure, &config, &mut no_jitter);
        }

        assert_eq!(
            state.phase,
            ReconnectPhase::Gaveup,
            "the reducer must give up once the 8-attempt budget is spent"
        );
        let expected: Vec<i64> = MONITORING_GOLDEN_DELAYS_SECS
            .iter()
            .map(|s| (*s as i64) * 1_000)
            .collect();
        assert_eq!(
            delays, expected,
            "the canonical reducer must reproduce monitoring's delay sequence (jitter:0)"
        );
    }

    #[test]
    fn golden_vector_offline_fires_after_budget_exhausted() {
        // Drive a loop-state to a reconnect, exhaust the production backoff
        // budget, and confirm the loop still resolves to Offline exactly as
        // before (the stale-threshold / MonitorStatus fork is unchanged).
        let mut state = CollectLoopState::with_threshold(1);
        state.on_success();
        state.on_failure(); // → Stale
        state.begin_reconnect(); // → Reconnecting

        let mut schedule = BackoffSchedule::default();
        while schedule.next_delay().is_some() {}
        assert_eq!(
            schedule.next_delay(),
            None,
            "the reconnect budget must be exhausted"
        );

        assert_eq!(
            state.exhaust_reconnect(),
            Some(MonitorStatus::Offline),
            "an exhausted reconnect budget resolves to Offline"
        );
        assert_eq!(state.status(), MonitorStatus::Offline);
    }
}
