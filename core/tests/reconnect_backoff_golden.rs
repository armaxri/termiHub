//! Golden-vector equivalence tests for the reconnect-backoff state machine
//! (#2144).
//!
//! Each fixture under `tests/fixtures/golden/reconnect_backoff/*.json` names one
//! exported function and a list of input → expected cases extracted from the
//! authoritative TypeScript suite (`src/utils/reconnectBackoff.test.ts`). This
//! test runs the Rust port against every case and asserts the serialized result
//! matches, proving the two implementations stay in lockstep.
//!
//! Fixture format and the shared-convention rationale live in
//! `tests/fixtures/golden/README.md`. This reuses verbatim the directory
//! layout, envelope, and matcher the panel-tree port (#2143) established, now
//! driven by the shared runner in `support::golden` (#2147). The injectable RNG
//! is encoded per case as a constant `rand` value in `args`.

mod support;

use serde_json::{json, Value};
use support::golden::{from, run_golden_suite};
use termihub_core::reconnect_backoff::{
    backoff_delay, is_active_reconnect_phase, next_reconnect_delay, reconnect_reducer,
    should_give_up, worst_case_total_backoff_ms, BackoffConfig, ReconnectEvent, ReconnectPhase,
    ReconnectState, DEFAULT_BACKOFF, MAX_JITTER_RATIO, RECONNECT_GIVE_UP_WINDOW_MS,
    RECONNECT_POLICY,
};

/// The per-case constant RNG (`() => rand`), defaulting to the no-swing 0.5 when
/// a case omits it (jitter-disabled cases never read it).
fn case_rng(args: &Value) -> impl FnMut() -> f64 {
    let r = args["rand"].as_f64().unwrap_or(0.5);
    move || r
}

/// Run one case for `operation`, returning the serialized actual result.
fn run_case(operation: &str, case: &Value) -> Value {
    let input = &case["input"];
    let args = &case["args"];
    match operation {
        "backoffDelay" => {
            let config: BackoffConfig = from(&args["config"]);
            json!(backoff_delay(input.as_i64().expect("attempt int"), &config))
        }
        "nextReconnectDelay" => {
            let config: BackoffConfig = from(&args["config"]);
            let mut rand = case_rng(args);
            json!(next_reconnect_delay(
                input.as_i64().expect("attempt int"),
                &config,
                &mut rand
            ))
        }
        "shouldGiveUp" => {
            let config: BackoffConfig = from(&args["config"]);
            json!(should_give_up(
                input.as_i64().expect("attempt int"),
                &config
            ))
        }
        "reconnectReducer" => {
            let state: ReconnectState = from(input);
            let event: ReconnectEvent = from(&args["event"]);
            let config: BackoffConfig = from(&args["config"]);
            let mut rand = case_rng(args);
            serde_json::to_value(reconnect_reducer(&state, event, &config, &mut rand))
                .expect("serialize state")
        }
        "worstCaseTotalBackoffMs" => {
            let config: BackoffConfig = from(input);
            json!(worst_case_total_backoff_ms(&config))
        }
        // The shared policy constants (#3730): pins the Rust constants to the
        // same values the TypeScript twin replays from this fixture.
        "reconnectPolicy" => match input.as_str() {
            None => serde_json::to_value(RECONNECT_POLICY).expect("serialize policy"),
            Some("default") => serde_json::to_value(DEFAULT_BACKOFF).expect("serialize policy"),
            Some("giveUpWindowMs") => json!(RECONNECT_GIVE_UP_WINDOW_MS),
            Some("maxJitterRatio") => json!(MAX_JITTER_RATIO),
            Some(other) => panic!("unknown reconnectPolicy input: {other}"),
        },
        "isActiveReconnectPhase" => {
            let phase: ReconnectPhase = from(input);
            json!(is_active_reconnect_phase(phase))
        }
        other => panic!("unknown golden operation: {other}"),
    }
}

#[test]
fn golden_vectors_match_typescript() {
    run_golden_suite("reconnect_backoff", 45, run_case);
}
