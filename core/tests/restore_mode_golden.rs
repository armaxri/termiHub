//! Golden-vector equivalence tests for the restore-mode decision logic (#2145).
//!
//! Each fixture under `tests/fixtures/golden/restore_mode/*.json` names one
//! exported function and a list of input → expected cases extracted from the
//! authoritative TypeScript suite (`src/utils/restoreMode.test.ts`). This test
//! runs the Rust port against every case and asserts the serialized result
//! matches, proving the two implementations stay in lockstep.
//!
//! Fixture format and the shared-convention rationale live in
//! `tests/fixtures/golden/README.md`. This reuses verbatim the directory
//! layout, envelope, and matcher the panel-tree port (#2143) established. The
//! optional `connections` list and the flat `selected` index array are carried
//! per case in `args`.

use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use termihub_core::restore_mode::{
    filter_session_by_selection, get_workspace_leaves, resolve_restore_mode,
    summarize_last_session, AppSettings, LastSession, SavedConnection, WorkspaceLayoutNode,
};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("golden")
        .join("restore_mode")
}

/// Deep JSON equality with the golden-vector numeric convention: numbers
/// compare within a 1e-9 tolerance (cross-language float rounding in the
/// size-redistribution path). Object key sets must match exactly.
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

/// Run one case for `operation`, returning the serialized actual result.
fn run_case(operation: &str, case: &Value) -> Value {
    let input = &case["input"];
    let args = &case["args"];
    match operation {
        "resolveRestoreMode" => {
            let settings: AppSettings = from(input);
            serde_json::to_value(resolve_restore_mode(&settings)).expect("serialize mode")
        }
        "summarizeLastSession" => {
            let session: LastSession = from(input);
            let connections: Vec<SavedConnection> = match args.get("connections") {
                Some(v) if !v.is_null() => from(v),
                _ => Vec::new(),
            };
            serde_json::to_value(summarize_last_session(&session, &connections))
                .expect("serialize prompt")
        }
        "filterSessionBySelection" => {
            let session: LastSession = from(input);
            let selected: HashSet<i64> = from::<Vec<i64>>(&args["selected"]).into_iter().collect();
            serde_json::to_value(filter_session_by_selection(&session, &selected))
                .expect("serialize session")
        }
        "getWorkspaceLeaves" => {
            let root: WorkspaceLayoutNode = from(input);
            Value::Array(
                get_workspace_leaves(&root)
                    .into_iter()
                    .map(|l| {
                        serde_json::to_value(WorkspaceLayoutNode::Leaf(l.clone()))
                            .expect("serialize leaf")
                    })
                    .collect(),
            )
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
    assert!(total_cases >= 20, "only ran {total_cases} golden cases");
}
