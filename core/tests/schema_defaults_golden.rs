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
//! and matcher, now driven by the shared runner in `support::golden` (#2147).

mod support;

use serde_json::{json, Map, Value};
use support::golden::{from, run_golden_suite};
use termihub_core::connection::schema::{SettingsField, SettingsSchema};
use termihub_core::connection::schema_defaults::{
    build_defaults, filter_credential_fields, filter_runtime_options,
    find_key_passphrase_prompt_info, find_password_prompt_info, is_field_visible,
    PasswordPromptInfo,
};

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
    run_golden_suite("schema_defaults", 25, run_case);
}
