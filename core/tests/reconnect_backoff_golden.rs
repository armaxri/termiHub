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
//! layout, envelope, and matcher the panel-tree port (#2143) established. The
//! injectable RNG is encoded per case as a constant `rand` value in `args`.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use termihub_core::reconnect_backoff::{
    backoff_delay, is_active_reconnect_phase, next_reconnect_delay, reconnect_reducer,
    should_give_up, BackoffConfig, ReconnectEvent, ReconnectPhase, ReconnectState,
};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("golden")
        .join("reconnect_backoff")
}

/// Deep JSON equality with the golden-vector numeric convention: numbers
/// compare within a 1e-9 tolerance (cross-language float rounding, and the
/// integer-valued `f64` results the backoff curve returns).
fn json_matches(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Number(e), Value::Number(a)) => match (e.as_f64(), a.as_f64()) {
            (Some(x), Some(y)) => (x - y).abs() < 1e-9,
            _ => e == a,
        },
        (Value::Array(e), Value::Array(a)) => {
            e.len() == a.len() && e.iter().zip(a).all(|(x, y)| json_matches(x, y))
        }
        (Value::Object(e), Value::Object(a)) => {
            e.len() == a.len()
                && e.iter()
                    .all(|(k, v)| a.get(k).is_some_and(|av| json_matches(v, av)))
        }
        _ => expected == actual,
    }
}

fn from<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).expect("deserialize fixture value")
}

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
        "isActiveReconnectPhase" => {
            let phase: ReconnectPhase = from(input);
            json!(is_active_reconnect_phase(phase))
        }
        other => panic!("unknown golden operation: {other}"),
    }
}

#[test]
fn golden_vectors_match_typescript() {
    let dir = fixture_dir();
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read fixture dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    assert!(
        !files.is_empty(),
        "no golden fixtures found in {}",
        dir.display()
    );

    let mut total_cases = 0usize;
    for file in files {
        let raw = fs::read_to_string(&file).expect("read fixture");
        let fixture: Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", file.display()));
        let operation = fixture["operation"]
            .as_str()
            .unwrap_or_else(|| panic!("{} missing operation", file.display()));
        let cases = fixture["cases"]
            .as_array()
            .unwrap_or_else(|| panic!("{} missing cases array", file.display()));

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let actual = run_case(operation, case);
            let expected = &case["expected"];
            assert!(
                json_matches(expected, &actual),
                "golden mismatch in {} :: {operation} :: {name}\n  expected: {}\n  actual:   {}",
                file.display(),
                serde_json::to_string(expected).unwrap_or_default(),
                serde_json::to_string(&actual).unwrap_or_default(),
            );
            total_cases += 1;
        }
    }
    // Sanity: make sure the harness actually exercised a meaningful body of cases.
    assert!(total_cases >= 30, "only ran {total_cases} golden cases");
}
