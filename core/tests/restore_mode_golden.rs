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
//! layout, envelope, and matcher the panel-tree port (#2143) established, now
//! driven by the shared runner in `support::golden` (#2147). The optional
//! `connections` list and the flat `selected` index array are carried per case
//! in `args`.

mod support;

use serde_json::Value;
use std::collections::HashSet;
use support::golden::{from, run_golden_suite};
use termihub_core::restore_mode::{
    filter_session_by_selection, get_workspace_leaves, resolve_restore_mode,
    summarize_last_session, AppSettings, LastSession, SavedConnection, WorkspaceLayoutNode,
};

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
    run_golden_suite("restore_mode", 20, run_case);
}
