//! Golden-vector equivalence tests for the schema-defaults logic (#2146).
//!
//! Each fixture under `tests/fixtures/golden/schema_defaults/*.json` names one
//! exported function and a list of input → expected cases extracted from the
//! authoritative TypeScript suite (`src/utils/schemaDefaults.test.ts`). This
//! test runs the Rust port against every case and asserts the serialized result
//! matches, proving the two implementations stay in lockstep.
//!
//! Fixture format and the shared-convention rationale live in
//! `tests/fixtures/golden/README.md`. The panel-tree port (#2143) established
//! the convention; this sibling port reuses the same directory layout, envelope,
//! and matcher.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use termihub_core::connection::schema::{SettingsField, SettingsSchema};
use termihub_core::connection::schema_defaults::{
    build_defaults, filter_credential_fields, filter_runtime_options,
    find_key_passphrase_prompt_info, find_password_prompt_info, is_field_visible,
    PasswordPromptInfo,
};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("golden")
        .join("schema_defaults")
}

/// Deep JSON equality with two golden-vector conventions (shared with the
/// panel-tree harness):
///   * the string `"__GENERATED__"` in `expected` matches any string in
///     `actual`;
///   * numbers compare within a 1e-9 tolerance (cross-language float rounding).
fn json_matches(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::String(e), _) if e == "__GENERATED__" => actual.is_string(),
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

/// Extract the `settings` argument (a JSON object) into a `Map`.
fn settings(args: &Value) -> Map<String, Value> {
    args.get("settings")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn prompt_to_value(info: Option<PasswordPromptInfo>) -> Value {
    match info {
        Some(i) => serde_json::to_value(i).expect("serialize prompt info"),
        None => Value::Null,
    }
}

/// Run one case for `operation`, returning the serialized actual result.
fn run_case(operation: &str, case: &Value) -> Value {
    let input = &case["input"];
    let args = &case["args"];
    match operation {
        "buildDefaults" => Value::Object(build_defaults(&from::<SettingsSchema>(input))),
        "isFieldVisible" => json!(is_field_visible(
            &from::<SettingsField>(input),
            &settings(args)
        )),
        "findPasswordPromptInfo" => prompt_to_value(find_password_prompt_info(
            &from::<SettingsSchema>(input),
            &settings(args),
        )),
        "findKeyPassphrasePromptInfo" => prompt_to_value(find_key_passphrase_prompt_info(
            &from::<SettingsSchema>(input),
            &settings(args),
            args["keyEncrypted"].as_bool().expect("keyEncrypted bool"),
        )),
        "filterCredentialFields" => serde_json::to_value(filter_credential_fields(
            &from::<SettingsSchema>(input),
            args["credentialMode"].as_str(),
        ))
        .expect("serialize schema"),
        "filterRuntimeOptions" => serde_json::to_value(filter_runtime_options(
            &from::<SettingsSchema>(input),
            args["dockerAvailable"]
                .as_bool()
                .expect("dockerAvailable bool"),
            args["podmanAvailable"]
                .as_bool()
                .expect("podmanAvailable bool"),
        ))
        .expect("serialize schema"),
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
    assert!(total_cases >= 25, "only ran {total_cases} golden cases");
}
