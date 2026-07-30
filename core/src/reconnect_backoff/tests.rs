//! Unit tests (mirroring `reconnectBackoff.test.ts`) plus property tests over
//! the backoff-schedule and state-machine invariants.

use super::*;
use proptest::prelude::*;

/// Deterministic config with jitter disabled, for exact delay assertions
/// (mirrors the `NO_JITTER` fixture in `reconnectBackoff.test.ts`).
const NO_JITTER: BackoffConfig = BackoffConfig {
    base_delay_ms: 1_000.0,
    factor: 2.0,
    max_delay_ms: 8_000.0,
    max_attempts: 5,
    jitter_ratio: 0.0,
};

/// A constant RNG returning `v` on every call — the Rust analogue of the TS
/// `() => v` injected generator.
fn rng(v: f64) -> impl FnMut() -> f64 {
    move || v
}

// ── backoffDelay ────────────────────────────────────────────────────────────

#[test]
fn backoff_delay_returns_base_for_first_attempt() {
    assert_eq!(backoff_delay(1, &NO_JITTER), 1_000.0);
}

#[test]
fn backoff_delay_grows_exponentially_by_the_factor() {
    assert_eq!(backoff_delay(2, &NO_JITTER), 2_000.0);
    assert_eq!(backoff_delay(3, &NO_JITTER), 4_000.0);
    assert_eq!(backoff_delay(4, &NO_JITTER), 8_000.0);
}

#[test]
fn backoff_delay_caps_at_max_delay() {
    // Attempt 5 would be 16_000 but is clamped to the 8_000 ceiling.
    assert_eq!(backoff_delay(5, &NO_JITTER), 8_000.0);
    assert_eq!(backoff_delay(50, &NO_JITTER), 8_000.0);
}

#[test]
fn backoff_delay_treats_attempt_below_one_as_first() {
    assert_eq!(backoff_delay(0, &NO_JITTER), 1_000.0);
    assert_eq!(backoff_delay(-3, &NO_JITTER), 1_000.0);
}

// ── nextReconnectDelay (jitter) ─────────────────────────────────────────────

#[test]
fn next_delay_equals_plain_backoff_when_jitter_disabled() {
    assert_eq!(next_reconnect_delay(3, &NO_JITTER, &mut rng(0.5)), 4_000);
}

#[test]
fn next_delay_applies_symmetric_jitter() {
    let cfg = BackoffConfig {
        jitter_ratio: 0.2,
        ..NO_JITTER
    };
    // rand=0 → factor (1 + (-0.2)) = 0.8 → 800 for base 1000.
    assert_eq!(next_reconnect_delay(1, &cfg, &mut rng(0.0)), 800);
    // rand→1 (upper bound) → factor (1 + 0.2) = 1.2 → 1200.
    assert_eq!(next_reconnect_delay(1, &cfg, &mut rng(0.999999)), 1_200);
    // rand=0.5 → no swing → exactly base.
    assert_eq!(next_reconnect_delay(1, &cfg, &mut rng(0.5)), 1_000);
}

#[test]
fn next_delay_never_negative() {
    let cfg = BackoffConfig {
        jitter_ratio: 2.0,
        ..NO_JITTER
    };
    assert!(next_reconnect_delay(1, &cfg, &mut rng(0.0)) >= 0);
}

// ── shouldGiveUp ────────────────────────────────────────────────────────────

#[test]
fn should_give_up_once_attempts_reach_max() {
    assert!(!should_give_up(4, &NO_JITTER));
    assert!(should_give_up(5, &NO_JITTER));
    assert!(should_give_up(6, &NO_JITTER));
}

#[test]
fn should_give_up_never_when_unbounded() {
    let cfg = BackoffConfig {
        max_attempts: 0,
        ..NO_JITTER
    };
    assert!(!should_give_up(1_000, &cfg));
}

// ── reconnectReducer transitions ────────────────────────────────────────────

#[test]
fn drop_from_idle_arms_first_backoff_window() {
    let s = reconnect_reducer(
        &initial_reconnect_state(),
        ReconnectEvent::Drop,
        &NO_JITTER,
        &mut rng(0.5),
    );
    assert_eq!(s.phase, ReconnectPhase::Waiting);
    assert_eq!(s.attempt, 0);
    assert_eq!(s.delay_ms, 1_000);
}

#[test]
fn attempt_from_waiting_starts_connection_and_counts_it() {
    let waiting = reconnect_reducer(
        &initial_reconnect_state(),
        ReconnectEvent::Drop,
        &NO_JITTER,
        &mut rng(0.5),
    );
    let connecting =
        reconnect_reducer(&waiting, ReconnectEvent::Attempt, &NO_JITTER, &mut rng(0.5));
    assert_eq!(connecting.phase, ReconnectPhase::Connecting);
    assert_eq!(connecting.attempt, 1);
    assert_eq!(connecting.delay_ms, 0);
}

#[test]
fn success_from_connecting_settles_and_resets() {
    let mut s = reconnect_reducer(
        &initial_reconnect_state(),
        ReconnectEvent::Drop,
        &NO_JITTER,
        &mut rng(0.5),
    );
    s = reconnect_reducer(&s, ReconnectEvent::Attempt, &NO_JITTER, &mut rng(0.5));
    s = reconnect_reducer(&s, ReconnectEvent::Success, &NO_JITTER, &mut rng(0.5));
    assert_eq!(s.phase, ReconnectPhase::Connected);
    assert_eq!(s.attempt, 0);
}

#[test]
fn failure_from_connecting_backs_off_with_longer_delay() {
    let mut s = reconnect_reducer(
        &initial_reconnect_state(),
        ReconnectEvent::Drop,
        &NO_JITTER,
        &mut rng(0.5),
    );
    s = reconnect_reducer(&s, ReconnectEvent::Attempt, &NO_JITTER, &mut rng(0.5)); // attempt 1
    s = reconnect_reducer(&s, ReconnectEvent::Failure, &NO_JITTER, &mut rng(0.5));
    assert_eq!(s.phase, ReconnectPhase::Waiting);
    assert_eq!(s.attempt, 1);
    // Next attempt is #2 → 2_000ms.
    assert_eq!(s.delay_ms, 2_000);
}

#[test]
fn walks_a_full_escalating_backoff_schedule_until_give_up() {
    let mut delays: Vec<i64> = Vec::new();
    let mut s = reconnect_reducer(
        &initial_reconnect_state(),
        ReconnectEvent::Drop,
        &NO_JITTER,
        &mut rng(0.5),
    );
    delays.push(s.delay_ms);
    // 5 attempts allowed; the 5th failure gives up.
    for _ in 0..5 {
        s = reconnect_reducer(&s, ReconnectEvent::Attempt, &NO_JITTER, &mut rng(0.5));
        assert_eq!(s.phase, ReconnectPhase::Connecting);
        s = reconnect_reducer(&s, ReconnectEvent::Failure, &NO_JITTER, &mut rng(0.5));
        if s.phase == ReconnectPhase::Waiting {
            delays.push(s.delay_ms);
        }
    }
    assert_eq!(s.phase, ReconnectPhase::Gaveup);
    assert_eq!(s.attempt, 5);
    // Escalating, capped at 8_000: 1000, 2000, 4000, 8000, 8000.
    assert_eq!(delays, vec![1_000, 2_000, 4_000, 8_000, 8_000]);
}

#[test]
fn cancel_from_any_phase_gives_up() {
    let waiting = reconnect_reducer(
        &initial_reconnect_state(),
        ReconnectEvent::Drop,
        &NO_JITTER,
        &mut rng(0.5),
    );
    assert_eq!(
        reconnect_reducer(&waiting, ReconnectEvent::Cancel, &NO_JITTER, &mut rng(0.5)).phase,
        ReconnectPhase::Gaveup
    );
    let connecting =
        reconnect_reducer(&waiting, ReconnectEvent::Attempt, &NO_JITTER, &mut rng(0.5));
    assert_eq!(
        reconnect_reducer(
            &connecting,
            ReconnectEvent::Cancel,
            &NO_JITTER,
            &mut rng(0.5)
        )
        .phase,
        ReconnectPhase::Gaveup
    );
}

#[test]
fn redrop_after_reconnect_restarts_from_attempt_one() {
    let mut s = reconnect_reducer(
        &initial_reconnect_state(),
        ReconnectEvent::Drop,
        &NO_JITTER,
        &mut rng(0.5),
    );
    s = reconnect_reducer(&s, ReconnectEvent::Attempt, &NO_JITTER, &mut rng(0.5));
    s = reconnect_reducer(&s, ReconnectEvent::Success, &NO_JITTER, &mut rng(0.5));
    assert_eq!(s.phase, ReconnectPhase::Connected);
    s = reconnect_reducer(&s, ReconnectEvent::Drop, &NO_JITTER, &mut rng(0.5));
    assert_eq!(s.phase, ReconnectPhase::Waiting);
    assert_eq!(s.delay_ms, 1_000); // fresh attempt-1 delay
}

#[test]
fn ignores_stray_events_that_do_not_match_phase() {
    let initial = initial_reconnect_state();
    // attempt while idle is a no-op.
    assert_eq!(
        reconnect_reducer(&initial, ReconnectEvent::Attempt, &NO_JITTER, &mut rng(0.5)),
        initial
    );
    // success while idle is a no-op.
    assert_eq!(
        reconnect_reducer(&initial, ReconnectEvent::Success, &NO_JITTER, &mut rng(0.5)),
        initial
    );
    // duplicate drop while waiting does not re-arm.
    let waiting = reconnect_reducer(&initial, ReconnectEvent::Drop, &NO_JITTER, &mut rng(0.5));
    assert_eq!(
        reconnect_reducer(&waiting, ReconnectEvent::Drop, &NO_JITTER, &mut rng(0.5)),
        waiting
    );
}

#[test]
fn unbounded_retries_never_reach_gaveup_on_failure() {
    let cfg = BackoffConfig {
        max_attempts: 0,
        ..NO_JITTER
    };
    let mut s = reconnect_reducer(
        &initial_reconnect_state(),
        ReconnectEvent::Drop,
        &cfg,
        &mut rng(0.5),
    );
    for _ in 0..100 {
        s = reconnect_reducer(&s, ReconnectEvent::Attempt, &cfg, &mut rng(0.5));
        s = reconnect_reducer(&s, ReconnectEvent::Failure, &cfg, &mut rng(0.5));
        assert_eq!(s.phase, ReconnectPhase::Waiting);
    }
    // Only Cancel stops an unbounded loop.
    assert_eq!(
        reconnect_reducer(&s, ReconnectEvent::Cancel, &cfg, &mut rng(0.5)).phase,
        ReconnectPhase::Gaveup
    );
}

// ── isActiveReconnectPhase ──────────────────────────────────────────────────

#[test]
fn is_active_true_while_waiting_or_connecting() {
    assert!(is_active_reconnect_phase(ReconnectPhase::Waiting));
    assert!(is_active_reconnect_phase(ReconnectPhase::Connecting));
}

#[test]
fn is_active_false_when_idle_connected_or_gaveup() {
    assert!(!is_active_reconnect_phase(ReconnectPhase::Idle));
    assert!(!is_active_reconnect_phase(ReconnectPhase::Connected));
    assert!(!is_active_reconnect_phase(ReconnectPhase::Gaveup));
}

// ── Property tests ──────────────────────────────────────────────────────────

/// A well-formed config with positive, finite tunables (jitter can be zero) —
/// the domain the backoff logic is designed for.
fn arb_config() -> impl Strategy<Value = BackoffConfig> {
    (
        1.0f64..100_000.0,
        1.0f64..4.0,
        1.0f64..600_000.0,
        0i64..50,
        0.0f64..1.0,
    )
        .prop_map(
            |(base_delay_ms, factor, max_delay_ms, max_attempts, jitter_ratio)| BackoffConfig {
                base_delay_ms,
                factor,
                // Ensure the cap is never below the base so the curve has room
                // to grow before clamping.
                max_delay_ms: max_delay_ms.max(base_delay_ms),
                max_attempts,
                jitter_ratio,
            },
        )
}

proptest! {
    /// The pre-jitter curve is monotonically non-decreasing in the attempt
    /// number and never exceeds the cap.
    #[test]
    fn backoff_delay_is_monotonic_and_capped(cfg in arb_config(), a in 1i64..40) {
        let here = backoff_delay(a, &cfg);
        let next = backoff_delay(a + 1, &cfg);
        prop_assert!(next >= here - 1e-6, "curve decreased: {here} -> {next}");
        prop_assert!(here <= cfg.max_delay_ms + 1e-6, "exceeded cap: {here}");
        prop_assert!(next <= cfg.max_delay_ms + 1e-6, "exceeded cap: {next}");
    }

    /// Attempts at or below 1 all collapse to the base delay (never sub-base,
    /// never negative).
    #[test]
    fn backoff_delay_floor_is_base(cfg in arb_config(), a in -20i64..=1) {
        prop_assert_eq!(backoff_delay(a, &cfg), backoff_delay(1, &cfg));
        prop_assert!(backoff_delay(a, &cfg) >= 0.0);
    }

    /// The jittered delay stays within the symmetric `±jitter_ratio` band
    /// around the pre-jitter value and is never negative, for any RNG output in
    /// `[0, 1)`.
    #[test]
    fn next_delay_stays_within_jitter_band(cfg in arb_config(), a in 1i64..40, r in 0.0f64..1.0) {
        let base = backoff_delay(a, &cfg);
        let d = next_reconnect_delay(a, &cfg, &mut rng(r));
        prop_assert!(d >= 0, "negative delay: {d}");
        let lo = (base * (1.0 - cfg.jitter_ratio)).round() as i64 - 1;
        let hi = (base * (1.0 + cfg.jitter_ratio)).round() as i64 + 1;
        prop_assert!(d >= lo && d <= hi, "delay {d} outside [{lo}, {hi}]");
    }

    /// With jitter disabled the concrete delay is exactly the rounded curve,
    /// independent of the RNG.
    #[test]
    fn next_delay_is_deterministic_without_jitter(cfg in arb_config(), a in 1i64..40, r in 0.0f64..1.0) {
        let no_jitter = BackoffConfig { jitter_ratio: 0.0, ..cfg };
        let expected = backoff_delay(a, &no_jitter).round() as i64;
        prop_assert_eq!(next_reconnect_delay(a, &no_jitter, &mut rng(r)), expected);
    }

    /// `cancel` from any reachable phase always lands in `gaveup`.
    #[test]
    fn cancel_always_gives_up(cfg in arb_config(), phase in prop_oneof![
        Just(ReconnectPhase::Idle),
        Just(ReconnectPhase::Waiting),
        Just(ReconnectPhase::Connecting),
        Just(ReconnectPhase::Connected),
        Just(ReconnectPhase::Gaveup),
    ], attempt in 0i64..30) {
        let state = ReconnectState { phase, attempt, delay_ms: 0 };
        let next = reconnect_reducer(&state, ReconnectEvent::Cancel, &cfg, &mut rng(0.5));
        prop_assert_eq!(next.phase, ReconnectPhase::Gaveup);
    }

    /// A drop while already waiting or connecting is idempotent — the loop is
    /// already running and must not re-arm.
    #[test]
    fn drop_while_active_is_idempotent(cfg in arb_config(), attempt in 0i64..30) {
        for phase in [ReconnectPhase::Waiting, ReconnectPhase::Connecting] {
            let state = ReconnectState { phase, attempt, delay_ms: 4_242 };
            let next = reconnect_reducer(&state, ReconnectEvent::Drop, &cfg, &mut rng(0.5));
            prop_assert_eq!(next, state);
        }
    }

    /// Stray events that do not match the current phase never mutate the state.
    #[test]
    fn stray_events_are_noops(cfg in arb_config(), attempt in 0i64..30) {
        // attempt/success/failure are only meaningful from waiting/connecting.
        let idle = ReconnectState { phase: ReconnectPhase::Idle, attempt, delay_ms: 0 };
        for ev in [ReconnectEvent::Attempt, ReconnectEvent::Success, ReconnectEvent::Failure] {
            prop_assert_eq!(reconnect_reducer(&idle, ev, &cfg, &mut rng(0.5)), idle);
        }
    }

    /// A bounded loop always terminates in `gaveup` after enough failures, and
    /// never keeps trying past `max_attempts`.
    #[test]
    fn bounded_loop_eventually_gives_up(cfg in arb_config().prop_filter(
        "bounded", |c| c.max_attempts >= 1
    )) {
        let mut s = reconnect_reducer(
            &initial_reconnect_state(), ReconnectEvent::Drop, &cfg, &mut rng(0.5));
        // Drive attempt/failure cycles well past the budget.
        for _ in 0..(cfg.max_attempts + 5) {
            if s.phase == ReconnectPhase::Gaveup {
                break;
            }
            s = reconnect_reducer(&s, ReconnectEvent::Attempt, &cfg, &mut rng(0.5));
            s = reconnect_reducer(&s, ReconnectEvent::Failure, &cfg, &mut rng(0.5));
        }
        prop_assert_eq!(s.phase, ReconnectPhase::Gaveup);
        prop_assert!(s.attempt <= cfg.max_attempts,
            "ran {} attempts past budget {}", s.attempt, cfg.max_attempts);
    }
}
