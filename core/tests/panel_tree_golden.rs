//! Golden-vector equivalence tests for the panel-tree algebra (#2143).
//!
//! Each fixture under `tests/fixtures/golden/panel_tree/*.json` names one
//! exported function and a list of input → expected cases extracted from the
//! authoritative TypeScript suite (`src/utils/panelTree.test.ts`,
//! `panelTree.fileDrop.test.ts`). This test runs the Rust port against every
//! case and asserts the serialized result matches, proving the two
//! implementations stay in lockstep.
//!
//! Fixture format and the shared-convention rationale live in
//! `tests/fixtures/golden/README.md`. This is the first Phase-0 port; the
//! sibling util ports (#2144–#2147) reuse the same directory layout, envelope,
//! and matcher.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use termihub_core::layout::panel_tree::{
    count_tabs_in_tree, edge_to_split, find_adjacent_leaf, find_leaf, find_leaf_by_tab,
    get_all_leaves, get_panel_active_session_id, is_window_empty, mark_active_leaf,
    normalize_sizes, remove_leaf, simplify_tree, split_leaf, Direction, DropEdge, FocusDirection,
    LeafPanel, PanelNode, Position, TabGroup,
};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("golden")
        .join("panel_tree")
}

/// Deep JSON equality with two golden-vector conventions:
///   * the string `"__GENERATED__"` in `expected` matches any string in
///     `actual` (freshly generated panel ids are non-deterministic);
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

fn leaf_opt_to_value(leaf: Option<&LeafPanel>) -> Value {
    match leaf {
        Some(l) => serde_json::to_value(PanelNode::Leaf(l.clone())).expect("serialize leaf"),
        None => Value::Null,
    }
}

fn node_opt_to_value(node: Option<PanelNode>) -> Value {
    match node {
        Some(n) => serde_json::to_value(n).expect("serialize node"),
        None => Value::Null,
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
        "countTabsInTree" => json!(count_tabs_in_tree(&from::<PanelNode>(input))),
        "isWindowEmpty" => {
            let root: PanelNode = from(input);
            let groups: Vec<TabGroup> = from(&args["tabGroups"]);
            let active = args["activeTabGroupId"].as_str();
            json!(is_window_empty(&root, &groups, active))
        }
        "normalizeSizes" => json!(normalize_sizes(&from::<Vec<f64>>(input))),
        "findLeaf" => {
            let root: PanelNode = from(input);
            leaf_opt_to_value(find_leaf(&root, args["leafId"].as_str().unwrap()))
        }
        "findLeafByTab" => {
            let root: PanelNode = from(input);
            leaf_opt_to_value(find_leaf_by_tab(&root, args["tabId"].as_str().unwrap()))
        }
        "getPanelActiveSessionId" => {
            let panel: LeafPanel = from(input);
            match get_panel_active_session_id(&panel) {
                Some(s) => json!(s),
                None => Value::Null,
            }
        }
        "getAllLeaves" => {
            let root: PanelNode = from(input);
            Value::Array(
                get_all_leaves(&root)
                    .into_iter()
                    .map(|l| serde_json::to_value(PanelNode::Leaf(l.clone())).expect("serialize"))
                    .collect(),
            )
        }
        "removeLeaf" => {
            let root: PanelNode = from(input);
            node_opt_to_value(remove_leaf(&root, args["leafId"].as_str().unwrap()))
        }
        "splitLeaf" => {
            let root: PanelNode = from(input);
            let new_leaf: LeafPanel = from(&args["newLeaf"]);
            let direction: Direction = from(&args["direction"]);
            let position: Position = from(&args["position"]);
            serde_json::to_value(split_leaf(
                &root,
                args["targetId"].as_str().unwrap(),
                &new_leaf,
                direction,
                position,
            ))
            .expect("serialize")
        }
        "simplifyTree" => {
            serde_json::to_value(simplify_tree(&from::<PanelNode>(input))).expect("s")
        }
        "edgeToSplit" => {
            let edge: DropEdge = from(input);
            match edge_to_split(edge) {
                Some(spec) => serde_json::to_value(spec).expect("serialize"),
                None => Value::Null,
            }
        }
        "findAdjacentLeaf" => {
            let root: PanelNode = from(input);
            let direction: FocusDirection = from(&args["direction"]);
            leaf_opt_to_value(find_adjacent_leaf(
                &root,
                args["currentLeafId"].as_str().unwrap(),
                direction,
            ))
        }
        "markActiveLeaf" => {
            let root: PanelNode = from(input);
            serde_json::to_value(mark_active_leaf(&root, args["leafId"].as_str().unwrap()))
                .expect("serialize")
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
    assert!(total_cases >= 40, "only ran {total_cases} golden cases");
}
