//! TS → agent contract test for the `connections.*` RPC params (AGT-028).
//!
//! `tests/fixtures/contract/agent_connection_params.json` is produced by the
//! frontend's real payload builders (`src/services/agentConnectionPayloads.ts`,
//! pinned by `agentConnectionPayloads.contract.test.ts` via vitest's
//! `toMatchFileSnapshot`). This test decodes every case into the shared core DTO
//! the desktop and the agent both use, and asserts the re-encoded JSON is
//! byte-identical to what the frontend built. That proves, per case:
//!
//! - the payload decodes (no missing required key, no wrong JSON type);
//! - no key is silently dropped (a drifted/unknown key would vanish on re-encode —
//!   the class of bug that let `session_type` slip past the agent);
//! - the desktop's decode → re-encode is wire-neutral, so agents in the field see
//!   exactly the JSON the frontend produced.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use termihub_core::protocol::methods::{
    ConnectionCreateParams, ConnectionUpdateParams, FolderUpdateParams, CONNECTIONS_CREATE,
    CONNECTIONS_FOLDERS_UPDATE, CONNECTIONS_UPDATE,
};

const FIXTURE: &str = include_str!("fixtures/contract/agent_connection_params.json");

/// Decode `params` as `T` and re-encode it, failing with the case name on drift.
fn assert_round_trips<T: DeserializeOwned + Serialize>(name: &str, params: &Value) {
    let decoded: T = serde_json::from_value(params.clone())
        .unwrap_or_else(|e| panic!("case {name:?}: frontend payload does not decode: {e}"));
    let reencoded = serde_json::to_value(&decoded).expect("re-encode DTO");
    assert_eq!(
        &reencoded, params,
        "case {name:?}: re-encoded wire JSON differs from the frontend payload \
         (a key was dropped or reshaped)"
    );
}

#[test]
fn frontend_payloads_decode_into_core_dtos_wire_unchanged() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("fixture has a cases array");

    let mut seen = std::collections::BTreeSet::new();
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let method = case["method"].as_str().expect("case method");
        let params = &case["params"];
        match method {
            CONNECTIONS_CREATE => assert_round_trips::<ConnectionCreateParams>(name, params),
            CONNECTIONS_UPDATE => assert_round_trips::<ConnectionUpdateParams>(name, params),
            CONNECTIONS_FOLDERS_UPDATE => assert_round_trips::<FolderUpdateParams>(name, params),
            other => panic!("case {name:?}: unexpected method {other:?}"),
        }
        seen.insert(method);
    }

    // Guard against a fixture that silently loads nothing or loses a verb.
    assert!(
        cases.len() >= 8,
        "expected >= 8 contract cases, got {}",
        cases.len()
    );
    for method in [
        CONNECTIONS_CREATE,
        CONNECTIONS_UPDATE,
        CONNECTIONS_FOLDERS_UPDATE,
    ] {
        assert!(seen.contains(method), "no contract case for {method}");
    }
}

/// A drifted key must fail the round trip — the check above is not vacuous.
#[test]
fn drifted_key_fails_the_round_trip() {
    let drifted = serde_json::json!({"id": "c", "session_type": "ssh"});
    let decoded: ConnectionUpdateParams =
        serde_json::from_value(drifted.clone()).expect("agent decode ignores unknown keys");
    assert_ne!(serde_json::to_value(&decoded).expect("encode"), drifted);
}
