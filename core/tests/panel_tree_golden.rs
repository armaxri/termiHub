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
//! sibling util ports (#2144–#2146) reuse the same directory layout, envelope,
//! and matcher, all now driven by the shared runner in `support::golden`
//! (#2147). This suite supplies only the panel-tree `run_case` mapping.

mod support;

use serde_json::{json, Value};
use support::golden::{from, run_golden_suite};
use termihub_core::layout::panel_tree::{
    count_tabs_in_tree, edge_to_split, find_adjacent_leaf, find_leaf, find_leaf_by_tab,
    get_all_leaves, get_panel_active_session_id, is_window_empty, mark_active_leaf,
    normalize_sizes, remove_leaf, simplify_tree, split_leaf, Direction, DropEdge, FocusDirection,
    LeafPanel, PanelNode, Position, TabGroup,
};

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
    run_golden_suite("panel_tree", 40, run_case);
}
