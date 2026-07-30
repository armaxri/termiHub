//! Agentless auto-reconnect backoff state machine (#1962).
//!
//! A faithful Rust port of the frontend's `src/utils/reconnectBackoff.ts`: a
//! pure, timer-free model of the "resilient reconnect" loop used for plain SSH
//! connections over flaky links. It answers two questions the store's timer
//! driver needs:
//!
//!   1. How long to wait before the next connection attempt (exponential
//!      backoff with jitter, capped).
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
    /// Fraction of the computed delay applied as symmetric random jitter, in
    /// `[0, 1]`. `0.2` spreads each delay by ±20% so a fleet of dropped tabs
    /// does not stampede the server in lockstep. `0` disables jitter
    /// (deterministic).
    pub jitter_ratio: f64,
}

/// Defaults tuned for a truck-on-cellular field scenario (#1962): a quick first
/// retry so a brief blip recovers almost instantly, doubling up to a 30 s
/// ceiling so a long outage does not hammer the network, and a bounded attempt
/// count so a permanently-dead host eventually surfaces the manual "Reconnect
/// failed" overlay instead of spinning forever.
pub const DEFAULT_BACKOFF: BackoffConfig = BackoffConfig {
    base_delay_ms: 1_000.0,
    factor: 2.0,
    max_delay_ms: 30_000.0,
    max_attempts: 10,
    jitter_ratio: 0.2,
};

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
pub fn backoff_delay(attempt: i64, config: &BackoffConfig) -> f64 {
    let n = attempt.max(1);
    let raw = config.base_delay_ms * config.factor.powi((n - 1) as i32);
    raw.min(config.max_delay_ms)
}

/// The concrete delay to wait before the given attempt (1-based), applying the
/// cap and then symmetric jitter of `±jitter_ratio`. `rand` is injectable for
/// deterministic tests; it must return a value in `[0, 1)`.
///
/// The result is clamped to `>= 0` and rounded to whole milliseconds.
pub fn next_reconnect_delay(
    attempt: i64,
    config: &BackoffConfig,
    rand: &mut dyn FnMut() -> f64,
) -> i64 {
    let base = backoff_delay(attempt, config);
    if config.jitter_ratio <= 0.0 {
        return base.round() as i64;
    }
    // Map rand() ∈ [0,1) to a symmetric factor in [-1, 1).
    let swing = (rand() * 2.0 - 1.0) * config.jitter_ratio;
    (base * (1.0 + swing)).round().max(0.0) as i64
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
