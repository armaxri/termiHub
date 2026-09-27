//! Agentless auto-reconnect backoff state machine (#1962).
//!
//! A faithful Rust port of the frontend's `src/utils/reconnectBackoff.ts`: a
//! pure, timer-free model of the "resilient reconnect" loop used for plain SSH
//! connections over flaky links. It answers two questions the store's timer
//! driver needs:
//!
//!   1. How long to wait before the next connection attempt (exponential
//!      backoff, capped, with bounded jitter below the cap).
//!   2. What the next phase is after each event (drop / attempt / success /
//!      failure / cancel), including when to give up.
//!
//! Keeping this logic pure and injectable (`rand`) makes the backoff schedule
//! and the give-up decision unit-testable without fake timers or a live
//! connection. During the stateless-UI migration (#2139) the TypeScript version
//! stays authoritative; this port runs behind it and is proven equivalent via
//! golden-vector fixtures (`core/tests/fixtures/golden/reconnect_backoff/`)
//! extracted from the TS test suite, and gains property tests over the backoff
//! invariants. Phase 4 (session lifecycle) activates it server-side.
//!
//! It is also the home of the one shared retry policy (SM-020, #3730):
//! [`RECONNECT_POLICY`], the per-loop mapping [`policy_for`] with its single
//! documented override, and the give-up window [`RECONNECT_GIVE_UP_WINDOW_MS`].
//!
//! No agent means the remote shell state cannot be recovered — this machine
//! only models re-establishing the *transport*, not restoring server-side
//! session state.

use serde::{Deserialize, Serialize};

/// Tunables for the exponential backoff schedule.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackoffConfig {
    /// Delay before the first retry, in ms.
    pub base_delay_ms: f64,
    /// Multiplier applied per attempt (2 → doubles each time).
    pub factor: f64,
    /// Upper bound on any single delay, in ms (before jitter).
    pub max_delay_ms: f64,
    /// Maximum number of connection attempts before giving up. `0` means retry
    /// forever (the user's Cancel is then the only way to stop).
    pub max_attempts: i64,
    /// Fraction of the computed delay that random jitter may shave off, in
    /// `[0, MAX_JITTER_RATIO]` (larger values are clamped). `0.5` draws each
    /// window from `[d/2, d]` so a fleet of dropped tabs does not stampede the
    /// server in lockstep. `0` disables jitter (deterministic).
    pub jitter_ratio: f64,
}

/// Largest jitter ratio the engine honours (#3730). A configured
/// `jitter_ratio` is clamped to `[0, MAX_JITTER_RATIO]`, so a jittered delay is
/// never shorter than half its nominal value: jitter can spread a fleet of
/// reconnecting clients apart, but it can never collapse a backoff window
/// towards zero and turn a backoff into a reconnect storm.
pub const MAX_JITTER_RATIO: f64 = 0.5;

/// The one shared reconnect policy (SM-020, #3730) every reconnect loop in the
/// workspace follows: terminal tabs (SSH and agent-hosted), the agent transport's
/// in-task loop, SSH tunnels, graphical sessions (VNC/RDP) and monitoring.
///
/// Tuned for a truck-on-cellular field scenario (#1962): a quick first retry so
/// a brief blip recovers almost instantly, doubling up to a 30 s ceiling so a
/// long outage does not hammer the network, and a bounded attempt count so a
/// permanently-dead host eventually surfaces the manual "Reconnect failed" state
/// instead of spinning forever.
///
/// Jitter is "equal jitter" below the nominal delay (see
/// [`next_reconnect_delay`]): each window is drawn from `[d/2, d]`, where `d` is
/// the capped exponential delay. The nominal schedule is therefore also the
/// worst case — `1, 2, 4, 8, 16, 30, 30, 30, 30, 30` s, 181 s in total
/// ([`RECONNECT_GIVE_UP_WINDOW_MS`]) — and a fleet of clients dropped by the
/// same outage spreads over half of every window instead of retrying in
/// lockstep.
///
/// Only the documented overrides in [`policy_for`] may deviate from it.
pub const RECONNECT_POLICY: BackoffConfig = BackoffConfig {
    base_delay_ms: 1_000.0,
    factor: 2.0,
    max_delay_ms: 30_000.0,
    max_attempts: 10,
    jitter_ratio: MAX_JITTER_RATIO,
};

/// The default backoff schedule — an alias of [`RECONNECT_POLICY`], kept so the
/// session-lifecycle store and its TypeScript twin keep their historical name.
pub const DEFAULT_BACKOFF: BackoffConfig = RECONNECT_POLICY;

/// The total give-up window of the shared policy, in ms (#3730): the longest a
/// reconnect loop may spend *waiting* between attempts before it gives up. It is
/// the worst-case total backoff of [`RECONNECT_POLICY`]
/// (`1+2+4+8+16+30+30+30+30+30 s`); jitter only ever shortens a window, so no
/// run of the loop waits longer. Every per-type policy ([`policy_for`]) must fit
/// inside it — a test pins that.
///
/// It bounds the backoff only. The time the attempts themselves take is bounded
/// separately by each transport's connect / dial timeout.
pub const RECONNECT_GIVE_UP_WINDOW_MS: i64 = 181_000;

/// The reconnect loops of the workspace, keyed by what they re-establish
/// (#3730). [`policy_for`] maps each to its retry policy.
///
/// Telnet and serial connections have no automatic reconnect (they do not
/// expose the Auto-Reconnect setting); a dropped telnet/serial tab shows the
/// manual reconnect prompt, so there is no loop to configure for them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ReconnectKind {
    /// A terminal tab's backend-driven reconnect loop (the session-lifecycle
    /// store): direct SSH tabs with Auto-Reconnect on, and agent-hosted tabs.
    Terminal,
    /// The remote agent's in-task transport reconnect loop (re-dials the agent's
    /// SSH transport after a transient break).
    AgentTransport,
    /// An SSH tunnel's reconnect-on-disconnect loop.
    Tunnel,
    /// A graphical (VNC/RDP) session's auto-reconnect loop.
    Graphical,
    /// A monitoring collector's re-dial loop (desktop and agent).
    Monitoring,
    /// The FTP file browser's per-operation retry: reconnect the control
    /// connection and repeat the one operation the user is waiting on.
    FtpOperation,
}

impl ReconnectKind {
    /// Every kind, for exhaustive policy checks.
    pub const ALL: [ReconnectKind; 6] = [
        ReconnectKind::Terminal,
        ReconnectKind::AgentTransport,
        ReconnectKind::Tunnel,
        ReconnectKind::Graphical,
        ReconnectKind::Monitoring,
        ReconnectKind::FtpOperation,
    ];
}

/// The FTP per-operation retry override (#1339, kept by #3730).
///
/// FTP is the one documented deviation from [`RECONNECT_POLICY`]: its retry is
/// not a session reconnect loop but an in-line retry of a single file operation
/// the user is actively waiting on (a listing, a download). It must resolve in
/// well under a second or two rather than minutes, so it retries at most 3 times
/// with 100 ms doubling to a 1.6 s ceiling — 700 ms of worst-case backoff. It
/// still uses the shared engine and jitter.
pub const FTP_OPERATION_RETRY_POLICY: BackoffConfig = BackoffConfig {
    base_delay_ms: 100.0,
    factor: 2.0,
    max_delay_ms: 1_600.0,
    max_attempts: 3,
    jitter_ratio: MAX_JITTER_RATIO,
};

/// The retry policy a reconnect loop of the given kind follows (#3730).
///
/// Every kind uses the shared [`RECONNECT_POLICY`] except
/// [`ReconnectKind::FtpOperation`] ([`FTP_OPERATION_RETRY_POLICY`]).
pub const fn policy_for(kind: ReconnectKind) -> BackoffConfig {
    match kind {
        ReconnectKind::Terminal
        | ReconnectKind::AgentTransport
        | ReconnectKind::Tunnel
        | ReconnectKind::Graphical
        | ReconnectKind::Monitoring => RECONNECT_POLICY,
        ReconnectKind::FtpOperation => FTP_OPERATION_RETRY_POLICY,
    }
}

/// Production jitter source: a uniform draw in `[0, 1)` from the thread RNG.
/// Loops take the RNG as an injectable `FnMut() -> f64` so tests substitute a
/// constant or a [`SeededJitter`].
pub fn system_jitter() -> f64 {
    rand::random::<f64>()
}

/// A small deterministic jitter source (SplitMix64) for tests and goldens
/// (#3730). Seeded, portable and dependency-free, so a pinned jittered
/// schedule stays byte-identical across platforms and `rand` versions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeededJitter {
    state: u64,
}

impl SeededJitter {
    /// A generator seeded with `seed`.
    pub const fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// The next uniform draw in `[0, 1)`.
    pub fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        // The top 53 bits map exactly onto the f64 mantissa.
        (z >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The worst-case total backoff, in whole ms, a loop following `config` waits
/// across its whole attempt budget: the sum of the nominal (un-jittered, rounded)
/// delays for attempts `1..=max_attempts`. Jitter only shortens a window, so no
/// run waits longer. `None` for an unbounded config (`max_attempts <= 0`).
pub fn worst_case_total_backoff_ms(config: &BackoffConfig) -> Option<i64> {
    if config.max_attempts <= 0 {
        return None;
    }
    Some(
        (1..=config.max_attempts)
            .map(|n| backoff_delay(n, config).round() as i64)
            .sum(),
    )
}

/// Phase of the auto-reconnect loop for one tab.
///
/// - `Idle`       — not auto-reconnecting.
/// - `Waiting`    — backoff timer is running before the next attempt.
/// - `Connecting` — an attempt is in flight (the transport is being
///   re-established).
/// - `Connected`  — the transport came back; the loop settled successfully.
/// - `Gaveup`     — attempts exhausted or the user cancelled; hand off to the
///   manual disconnect overlay.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReconnectPhase {
    Idle,
    Waiting,
    Connecting,
    Connected,
    Gaveup,
}

/// Immutable snapshot of the reconnect loop for one tab.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectState {
    pub phase: ReconnectPhase,
    /// Number of connection attempts started so far in this loop.
    pub attempt: i64,
    /// Delay the current `Waiting` phase is counting down, in ms (0 otherwise).
    pub delay_ms: i64,
}

/// Events that drive the machine:
///
/// - `Drop`    — the connection was lost; begin (or, from `Connected`, restart)
///   the backoff loop.
/// - `Attempt` — the backoff timer fired; start a connection attempt.
/// - `Success` — the attempt connected.
/// - `Failure` — the attempt failed; back off further or give up.
/// - `Cancel`  — the user asked to stop retrying.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReconnectEvent {
    Drop,
    Attempt,
    Success,
    Failure,
    Cancel,
}

/// The starting state for a tab that is not auto-reconnecting.
pub const INITIAL_RECONNECT_STATE: ReconnectState = ReconnectState {
    phase: ReconnectPhase::Idle,
    attempt: 0,
    delay_ms: 0,
};

/// The starting state for a tab that is not auto-reconnecting (mirrors the
/// TypeScript `initialReconnectState` export).
pub fn initial_reconnect_state() -> ReconnectState {
    INITIAL_RECONNECT_STATE
}

impl Default for ReconnectState {
    fn default() -> Self {
        INITIAL_RECONNECT_STATE
    }
}

/// Pure exponential delay for a given attempt (1-based), before jitter and
/// before the cap-then-jitter in [`next_reconnect_delay`]. Attempt 1 →
/// `base_delay_ms`, attempt 2 → `base_delay_ms * factor`, and so on, clamped to
/// `max_delay_ms`.
///
/// `attempt < 1` is treated as attempt 1 so a caller never gets a negative or
/// sub-base delay.
///
/// LIBBE-004: left as-is (NOT routed through
/// [`crate::util::backoff::capped_exponential_delay`]). That shared helper is a
/// different numeric domain — integer `Duration`, a fixed factor of 2, no jitter
/// — whereas this schedule is `f64` milliseconds with a *configurable* `factor`
/// and bounded random jitter, proven equivalent to the TypeScript
/// `reconnectBackoff.ts` via golden vectors. Folding it into the integer helper
/// would change its rounding/jitter/factor semantics, so it stays here.
pub fn backoff_delay(attempt: i64, config: &BackoffConfig) -> f64 {
    let n = attempt.max(1);
    // Saturate the exponent instead of truncating it: a plain `as i32` would
    // wrap a huge attempt number to a negative exponent and collapse the delay
    // far below the cap. With `factor >= 1` a saturated power is `inf`, which
    // the cap then clamps.
    let exponent = i32::try_from(n - 1).unwrap_or(i32::MAX);
    let raw = config.base_delay_ms * config.factor.powi(exponent);
    raw.min(config.max_delay_ms)
}

/// The concrete delay to wait before the given attempt (1-based): the capped
/// exponential delay `d` ([`backoff_delay`]) shortened by bounded "equal
/// jitter" (#3730) to `d * (1 - jitter_ratio * rand())`.
///
/// - **Never above the cap.** Jitter only shortens a window, so the result is
///   `<= d <= max_delay_ms`, and the nominal schedule is the worst case.
/// - **Never a zero-delay storm.** `jitter_ratio` is clamped to
///   `[0, MAX_JITTER_RATIO]`, so the result is `>= d / 2`.
/// - **Deterministic under test.** `rand` is injectable; it should return a
///   value in `[0, 1)`. A value outside `[0, 1]` is clamped and a non-finite
///   one reads as `0` (no shortening), so a broken RNG cannot break the bounds.
///
/// The result is rounded to whole milliseconds.
pub fn next_reconnect_delay(
    attempt: i64,
    config: &BackoffConfig,
    rand: &mut dyn FnMut() -> f64,
) -> i64 {
    let nominal = backoff_delay(attempt, config);
    let ratio = if config.jitter_ratio.is_finite() {
        config.jitter_ratio.clamp(0.0, MAX_JITTER_RATIO)
    } else {
        0.0
    };
    if ratio <= 0.0 {
        return nominal.round().max(0.0) as i64;
    }
    let draw = rand();
    let u = if draw.is_finite() {
        draw.clamp(0.0, 1.0)
    } else {
        0.0
    };
    (nominal * (1.0 - ratio * u)).round().max(0.0) as i64
}

/// Whether the loop should give up rather than start another attempt. With
/// `max_attempts == 0` the loop never gives up on its own (unbounded retry).
/// Once `attempt` attempts have already been made, a further failure gives up
/// when `attempt >= max_attempts`.
pub fn should_give_up(attempt: i64, config: &BackoffConfig) -> bool {
    if config.max_attempts <= 0 {
        return false;
    }
    attempt >= config.max_attempts
}

/// Pure transition for the reconnect state machine. Given the current state, an
/// event, the config, and an injectable RNG, returns the next state. Unknown
/// transitions are a no-op (return the same state) so a stray event cannot
/// corrupt the loop.
///
/// The `delay_ms` on a `Waiting` result is the concrete jittered delay the
/// timer driver should arm; `attempt` counts attempts that have been started.
pub fn reconnect_reducer(
    state: &ReconnectState,
    event: ReconnectEvent,
    config: &BackoffConfig,
    rand: &mut dyn FnMut() -> f64,
) -> ReconnectState {
    match event {
        // The user stops the loop from any phase.
        ReconnectEvent::Cancel => ReconnectState {
            phase: ReconnectPhase::Gaveup,
            attempt: state.attempt,
            delay_ms: 0,
        },

        ReconnectEvent::Drop => {
            // A fresh drop (from idle or a previously-connected loop) arms the
            // first backoff window. A drop while already waiting/connecting is
            // ignored — the loop is already running and `Failure` handles a
            // failed attempt.
            if state.phase == ReconnectPhase::Idle || state.phase == ReconnectPhase::Connected {
                let next_attempt = 1;
                ReconnectState {
                    phase: ReconnectPhase::Waiting,
                    // No attempt started yet; incremented on "attempt".
                    attempt: state.attempt,
                    delay_ms: next_reconnect_delay(next_attempt, config, rand),
                }
            } else {
                *state
            }
        }

        ReconnectEvent::Attempt => {
            // The backoff timer fired: begin a connection attempt.
            if state.phase != ReconnectPhase::Waiting {
                return *state;
            }
            ReconnectState {
                phase: ReconnectPhase::Connecting,
                attempt: state.attempt + 1,
                delay_ms: 0,
            }
        }

        ReconnectEvent::Success => {
            if state.phase != ReconnectPhase::Connecting {
                return *state;
            }
            ReconnectState {
                phase: ReconnectPhase::Connected,
                attempt: 0,
                delay_ms: 0,
            }
        }

        ReconnectEvent::Failure => {
            if state.phase != ReconnectPhase::Connecting {
                return *state;
            }
            // `attempt` already counts this just-failed attempt (incremented on
            // "attempt"). Give up once we have used our budget; otherwise arm
            // the next backoff window sized for the *next* attempt number.
            if should_give_up(state.attempt, config) {
                return ReconnectState {
                    phase: ReconnectPhase::Gaveup,
                    attempt: state.attempt,
                    delay_ms: 0,
                };
            }
            let next_attempt_number = state.attempt + 1;
            ReconnectState {
                phase: ReconnectPhase::Waiting,
                attempt: state.attempt,
                delay_ms: next_reconnect_delay(next_attempt_number, config, rand),
            }
        }
    }
}

/// Whether a phase is one where the loop is actively trying (spinner/countdown).
pub fn is_active_reconnect_phase(phase: ReconnectPhase) -> bool {
    matches!(phase, ReconnectPhase::Waiting | ReconnectPhase::Connecting)
}

#[cfg(test)]
mod tests;
