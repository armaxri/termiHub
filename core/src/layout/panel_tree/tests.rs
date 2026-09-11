//! Unit tests (mirroring `panelTree.test.ts` / `panelTree.fileDrop.test.ts`)
//! plus property tests over the tree-algebra invariants.

use super::*;
use proptest::prelude::*;
use std::collections::HashSet;

// ── Test builders ───────────────────────────────────────────────────────────

fn make_tab(id: &str) -> Tab {
    Tab {
        id: id.to_string(),
        session_id: None,
        content_type: "terminal".to_string(),
    }
}

fn make_leaf(id: &str, tab_ids: &[&str]) -> LeafPanel {
    let tabs: Vec<Tab> = tab_ids.iter().map(|t| make_tab(t)).collect();
    let active_tab_id = tabs.first().map(|t| t.id.clone());
    LeafPanel {
        id: id.to_string(),
        tabs,
        active_tab_id,
    }
}

fn leaf_node(id: &str, tab_ids: &[&str]) -> PanelNode {
    PanelNode::Leaf(make_leaf(id, tab_ids))
}

fn make_split(id: &str, direction: Direction, children: Vec<PanelNode>) -> SplitContainer {
    SplitContainer {
        id: id.to_string(),
        direction,
        children,
        sizes: None,
        last_active_leaf_id: None,
    }
}

fn split_node(id: &str, direction: Direction, children: Vec<PanelNode>) -> PanelNode {
    PanelNode::Split(make_split(id, direction, children))
}

// ── createLeafPanel ─────────────────────────────────────────────────────────

#[test]
fn create_leaf_panel_returns_empty_leaf() {
    let leaf = create_leaf_panel();
    assert!(!leaf.id.is_empty());
    assert!(leaf.tabs.is_empty());
    assert!(leaf.active_tab_id.is_none());
}

#[test]
fn create_leaf_panel_generates_unique_ids() {
    let a = create_leaf_panel();
    let b = create_leaf_panel();
    assert_ne!(a.id, b.id);
}

// ── findLeaf ────────────────────────────────────────────────────────────────

#[test]
fn find_leaf_single() {
    let leaf = leaf_node("leaf-1", &[]);
    assert_eq!(find_leaf(&leaf, "leaf-1").unwrap().id, "leaf-1");
}

#[test]
fn find_leaf_nested() {
    let split = split_node(
        "split-1",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
    );
    assert_eq!(find_leaf(&split, "leaf-2").unwrap().id, "leaf-2");
}

#[test]
fn find_leaf_unknown() {
    let leaf = leaf_node("leaf-1", &[]);
    assert!(find_leaf(&leaf, "unknown").is_none());
}

// ── findLeafByTab ───────────────────────────────────────────────────────────

#[test]
fn find_leaf_by_tab_found() {
    let leaf = leaf_node("leaf-1", &["tab-a", "tab-b"]);
    assert_eq!(find_leaf_by_tab(&leaf, "tab-b").unwrap().id, "leaf-1");
}

#[test]
fn find_leaf_by_tab_unknown() {
    let leaf = leaf_node("leaf-1", &["tab-a"]);
    assert!(find_leaf_by_tab(&leaf, "tab-unknown").is_none());
}

// ── getAllLeaves ────────────────────────────────────────────────────────────

#[test]
fn get_all_leaves_single() {
    let leaf = leaf_node("leaf-1", &[]);
    let leaves = get_all_leaves(&leaf);
    assert_eq!(leaves.len(), 1);
    assert_eq!(leaves[0].id, "leaf-1");
}

#[test]
fn get_all_leaves_nested_in_order() {
    let inner = split_node(
        "s-inner",
        Direction::Vertical,
        vec![leaf_node("leaf-2", &[]), leaf_node("leaf-3", &[])],
    );
    let root = split_node(
        "s-root",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), inner],
    );
    let ids: Vec<&str> = get_all_leaves(&root)
        .iter()
        .map(|l| l.id.as_str())
        .collect();
    assert_eq!(ids, vec!["leaf-1", "leaf-2", "leaf-3"]);
}

// ── updateLeaf ──────────────────────────────────────────────────────────────

#[test]
fn update_leaf_updates_match() {
    let leaf = leaf_node("leaf-1", &["tab-1"]);
    let updated = update_leaf(&leaf, "leaf-1", |l| LeafPanel {
        active_tab_id: Some("tab-1".to_string()),
        ..l.clone()
    });
    match updated {
        PanelNode::Leaf(l) => assert_eq!(l.active_tab_id.as_deref(), Some("tab-1")),
        _ => panic!("expected leaf"),
    }
}

#[test]
fn update_leaf_leaves_non_match_unchanged() {
    let leaf = leaf_node("leaf-1", &[]);
    let result = update_leaf(&leaf, "other", |l| LeafPanel {
        active_tab_id: Some("changed".to_string()),
        ..l.clone()
    });
    assert_eq!(result, leaf);
}

// ── removeLeaf ──────────────────────────────────────────────────────────────

#[test]
fn remove_leaf_root_returns_none() {
    let leaf = leaf_node("leaf-1", &[]);
    assert!(remove_leaf(&leaf, "leaf-1").is_none());
}

#[test]
fn remove_leaf_non_match_unchanged() {
    let leaf = leaf_node("leaf-1", &[]);
    assert_eq!(remove_leaf(&leaf, "other").unwrap(), leaf);
}

#[test]
fn remove_leaf_unwraps_single_child() {
    let leaf2 = leaf_node("leaf-2", &[]);
    let split = split_node(
        "split-1",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), leaf2.clone()],
    );
    assert_eq!(remove_leaf(&split, "leaf-1").unwrap(), leaf2);
}

#[test]
fn remove_leaf_redistributes_sizes() {
    let root = PanelNode::Split(SplitContainer {
        sizes: Some(vec![50.0, 25.0, 25.0]),
        ..make_split(
            "split-1",
            Direction::Horizontal,
            vec![
                leaf_node("leaf-1", &[]),
                leaf_node("leaf-2", &[]),
                leaf_node("leaf-3", &[]),
            ],
        )
    });
    let result = remove_leaf(&root, "leaf-1").unwrap();
    match result {
        PanelNode::Split(s) => {
            assert_eq!(s.children.len(), 2);
            let total: f64 = s.sizes.as_ref().unwrap().iter().sum();
            assert!((total - 100.0).abs() < 1e-9);
        }
        _ => panic!("expected split"),
    }
}

#[test]
fn remove_leaf_collapses_sized_two_child_split() {
    let leaf2 = leaf_node("leaf-2", &[]);
    let root = PanelNode::Split(SplitContainer {
        sizes: Some(vec![70.0, 30.0]),
        ..make_split(
            "split-1",
            Direction::Horizontal,
            vec![leaf_node("leaf-1", &[]), leaf2.clone()],
        )
    });
    assert_eq!(remove_leaf(&root, "leaf-1").unwrap(), leaf2);
}

// ── splitLeaf ───────────────────────────────────────────────────────────────

#[test]
fn split_leaf_wraps_in_container() {
    let existing = leaf_node("leaf-1", &[]);
    let new_leaf = make_leaf("new-leaf", &[]);
    let result = split_leaf(
        &existing,
        "leaf-1",
        &new_leaf,
        Direction::Horizontal,
        Position::After,
    );
    match result {
        PanelNode::Split(s) => {
            assert_eq!(s.direction, Direction::Horizontal);
            assert_eq!(s.children.len(), 2);
            assert!(matches!(&s.children[0], PanelNode::Leaf(l) if l.id == "leaf-1"));
            assert!(matches!(&s.children[1], PanelNode::Leaf(l) if l.id == "new-leaf"));
        }
        _ => panic!("expected split"),
    }
}

#[test]
fn split_leaf_before() {
    let existing = leaf_node("leaf-1", &[]);
    let new_leaf = make_leaf("new-leaf", &[]);
    let result = split_leaf(
        &existing,
        "leaf-1",
        &new_leaf,
        Direction::Vertical,
        Position::Before,
    );
    match result {
        PanelNode::Split(s) => {
            assert!(matches!(&s.children[0], PanelNode::Leaf(l) if l.id == "new-leaf"));
            assert!(matches!(&s.children[1], PanelNode::Leaf(l) if l.id == "leaf-1"));
        }
        _ => panic!("expected split"),
    }
}

#[test]
fn split_leaf_inserts_as_sibling_when_directions_match() {
    let split = split_node(
        "split-1",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
    );
    let new_leaf = make_leaf("new-leaf", &[]);
    let result = split_leaf(
        &split,
        "leaf-1",
        &new_leaf,
        Direction::Horizontal,
        Position::After,
    );
    match result {
        PanelNode::Split(s) => {
            let ids: Vec<&str> = s
                .children
                .iter()
                .map(|c| match c {
                    PanelNode::Leaf(l) => l.id.as_str(),
                    _ => "split",
                })
                .collect();
            assert_eq!(ids, vec!["leaf-1", "new-leaf", "leaf-2"]);
        }
        _ => panic!("expected split"),
    }
}

#[test]
fn split_leaf_halves_size_of_sized_sibling() {
    let root = PanelNode::Split(SplitContainer {
        sizes: Some(vec![60.0, 40.0]),
        ..make_split(
            "split-1",
            Direction::Horizontal,
            vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
        )
    });
    let new_leaf = make_leaf("new-leaf", &[]);
    let result = split_leaf(
        &root,
        "leaf-1",
        &new_leaf,
        Direction::Horizontal,
        Position::After,
    );
    match result {
        PanelNode::Split(s) => {
            let sizes = s.sizes.unwrap();
            assert_eq!(sizes.len(), 3);
            assert!((sizes[0] - 30.0).abs() < 1e-9);
            assert!((sizes[1] - 30.0).abs() < 1e-9);
            assert!((sizes[2] - 40.0).abs() < 1e-9);
        }
        _ => panic!("expected split"),
    }
}

#[test]
fn split_leaf_no_sizes_when_parent_has_none() {
    let root = split_node(
        "split-1",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
    );
    let new_leaf = make_leaf("new-leaf", &[]);
    let result = split_leaf(
        &root,
        "leaf-1",
        &new_leaf,
        Direction::Horizontal,
        Position::After,
    );
    match result {
        PanelNode::Split(s) => assert!(s.sizes.is_none()),
        _ => panic!("expected split"),
    }
}

#[test]
fn split_leaf_with_id_adopts_provided_container_id() {
    // Wrapping a lone leaf: the new container adopts the supplied id verbatim
    // (#2708), instead of a freshly-minted `panel-…` id.
    let existing = leaf_node("leaf-1", &[]);
    let new_leaf = make_leaf("new-leaf", &[]);
    let result = split_leaf_with_id(
        &existing,
        "leaf-1",
        &new_leaf,
        Direction::Horizontal,
        Position::After,
        Some("split-adopted"),
    );
    match result {
        PanelNode::Split(s) => assert_eq!(s.id, "split-adopted"),
        _ => panic!("expected split"),
    }
}

#[test]
fn split_leaf_with_id_mints_when_absent() {
    // `None` preserves the pre-#2708 behaviour: a fresh `panel-…` id.
    let existing = leaf_node("leaf-1", &[]);
    let new_leaf = make_leaf("new-leaf", &[]);
    let result = split_leaf_with_id(
        &existing,
        "leaf-1",
        &new_leaf,
        Direction::Horizontal,
        Position::After,
        None,
    );
    match result {
        PanelNode::Split(s) => assert!(s.id.starts_with("panel-")),
        _ => panic!("expected split"),
    }
}

#[test]
fn split_leaf_with_id_ignores_container_id_on_sibling_insert() {
    // Inserting into a same-direction split creates no new container, so the
    // supplied id is ignored and the existing container id is preserved.
    let split = split_node(
        "split-1",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
    );
    let new_leaf = make_leaf("new-leaf", &[]);
    let result = split_leaf_with_id(
        &split,
        "leaf-1",
        &new_leaf,
        Direction::Horizontal,
        Position::After,
        Some("unused-id"),
    );
    match result {
        PanelNode::Split(s) => assert_eq!(s.id, "split-1"),
        _ => panic!("expected split"),
    }
}

#[test]
fn contains_panel_id_finds_leaf_and_split_ids() {
    let tree = split_node(
        "split-1",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
    );
    assert!(contains_panel_id(&tree, "split-1"));
    assert!(contains_panel_id(&tree, "leaf-2"));
    assert!(!contains_panel_id(&tree, "absent"));
}

// ── simplifyTree ────────────────────────────────────────────────────────────

#[test]
fn simplify_tree_leaf_unchanged() {
    let leaf = leaf_node("leaf-1", &[]);
    assert_eq!(simplify_tree(&leaf), leaf);
}

#[test]
fn simplify_tree_flattens_same_direction() {
    let inner = split_node(
        "inner",
        Direction::Horizontal,
        vec![leaf_node("leaf-2", &[]), leaf_node("leaf-3", &[])],
    );
    let outer = split_node(
        "outer",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), inner],
    );
    match simplify_tree(&outer) {
        PanelNode::Split(s) => assert_eq!(s.children.len(), 3),
        _ => panic!("expected split"),
    }
}

#[test]
fn simplify_tree_unwraps_single_child() {
    let leaf = leaf_node("leaf-1", &[]);
    let split = split_node("split-1", Direction::Horizontal, vec![leaf.clone()]);
    assert_eq!(simplify_tree(&split), leaf);
}

// ── edgeToSplit ─────────────────────────────────────────────────────────────

#[test]
fn edge_to_split_mappings() {
    assert_eq!(
        edge_to_split(DropEdge::Left),
        Some(SplitSpec {
            direction: Direction::Horizontal,
            position: Position::Before
        })
    );
    assert_eq!(
        edge_to_split(DropEdge::Right),
        Some(SplitSpec {
            direction: Direction::Horizontal,
            position: Position::After
        })
    );
    assert_eq!(
        edge_to_split(DropEdge::Top),
        Some(SplitSpec {
            direction: Direction::Vertical,
            position: Position::Before
        })
    );
    assert_eq!(
        edge_to_split(DropEdge::Bottom),
        Some(SplitSpec {
            direction: Direction::Vertical,
            position: Position::After
        })
    );
    assert_eq!(edge_to_split(DropEdge::Center), None);
}

// ── findAdjacentLeaf ────────────────────────────────────────────────────────

#[test]
fn find_adjacent_leaf_single_is_none() {
    let leaf = leaf_node("leaf-1", &[]);
    for dir in [
        FocusDirection::Left,
        FocusDirection::Right,
        FocusDirection::Up,
        FocusDirection::Down,
    ] {
        assert!(find_adjacent_leaf(&leaf, "leaf-1", dir).is_none());
    }
}

#[test]
fn find_adjacent_leaf_horizontal() {
    let root = split_node(
        "s",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-1", FocusDirection::Right)
            .unwrap()
            .id,
        "leaf-2"
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-2", FocusDirection::Left)
            .unwrap()
            .id,
        "leaf-1"
    );
    assert!(find_adjacent_leaf(&root, "leaf-1", FocusDirection::Left).is_none());
    assert!(find_adjacent_leaf(&root, "leaf-2", FocusDirection::Right).is_none());
    assert!(find_adjacent_leaf(&root, "leaf-1", FocusDirection::Up).is_none());
}

#[test]
fn find_adjacent_leaf_nested() {
    let inner = split_node(
        "v",
        Direction::Vertical,
        vec![leaf_node("leaf-2", &[]), leaf_node("leaf-3", &[])],
    );
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), inner],
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-1", FocusDirection::Right)
            .unwrap()
            .id,
        "leaf-2"
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-2", FocusDirection::Left)
            .unwrap()
            .id,
        "leaf-1"
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-3", FocusDirection::Left)
            .unwrap()
            .id,
        "leaf-1"
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-2", FocusDirection::Down)
            .unwrap()
            .id,
        "leaf-3"
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-3", FocusDirection::Up)
            .unwrap()
            .id,
        "leaf-2"
    );
}

#[test]
fn find_adjacent_leaf_enters_subtree_at_correct_edge() {
    let inner = split_node(
        "v",
        Direction::Vertical,
        vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
    );
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![inner, leaf_node("leaf-3", &[])],
    );
    // leaf-3 left enters the vertical split, picks the last child (leaf-2).
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-3", FocusDirection::Left)
            .unwrap()
            .id,
        "leaf-2"
    );
}

#[test]
fn find_adjacent_leaf_uses_last_active() {
    let inner = PanelNode::Split(SplitContainer {
        last_active_leaf_id: Some("leaf-3".to_string()),
        ..make_split(
            "v",
            Direction::Vertical,
            vec![leaf_node("leaf-2", &[]), leaf_node("leaf-3", &[])],
        )
    });
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), inner],
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-1", FocusDirection::Right)
            .unwrap()
            .id,
        "leaf-3"
    );
}

#[test]
fn find_adjacent_leaf_falls_back_when_last_active_stale() {
    let inner = PanelNode::Split(SplitContainer {
        last_active_leaf_id: Some("removed-leaf".to_string()),
        ..make_split(
            "v",
            Direction::Vertical,
            vec![leaf_node("leaf-2", &[]), leaf_node("leaf-3", &[])],
        )
    });
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), inner],
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-1", FocusDirection::Right)
            .unwrap()
            .id,
        "leaf-2"
    );
}

#[test]
fn find_adjacent_leaf_uses_last_active_deeply_nested() {
    let deep = PanelNode::Split(SplitContainer {
        last_active_leaf_id: Some("leaf-4".to_string()),
        ..make_split(
            "deep-h",
            Direction::Horizontal,
            vec![leaf_node("leaf-3", &[]), leaf_node("leaf-4", &[])],
        )
    });
    let inner = PanelNode::Split(SplitContainer {
        last_active_leaf_id: Some("leaf-4".to_string()),
        ..make_split(
            "v",
            Direction::Vertical,
            vec![leaf_node("leaf-2", &[]), deep],
        )
    });
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), inner],
    );
    assert_eq!(
        find_adjacent_leaf(&root, "leaf-1", FocusDirection::Right)
            .unwrap()
            .id,
        "leaf-4"
    );
}

// ── empty-Split robustness (CORE-038) ────────────────────────────────────────

#[test]
fn find_adjacent_leaf_empty_split_sibling_does_not_panic() {
    // A restored / hand-edited workspace file can carry a degenerate empty
    // `Split`. Navigating toward it must not panic (CORE-038): before the guard,
    // entering the empty split indexed `children[0]` on an empty vector.
    let empty = split_node("empty", Direction::Vertical, vec![]);
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), empty],
    );
    // Moving right from leaf-1 tries to enter the empty split — no leaf there.
    assert!(find_adjacent_leaf(&root, "leaf-1", FocusDirection::Right).is_none());
    assert!(find_adjacent_leaf(&root, "leaf-1", FocusDirection::Left).is_none());
    // get_all_leaves stays safe over the empty branch too.
    assert_eq!(get_all_leaves(&root).len(), 1);
}

#[test]
fn sanitize_tree_collapses_empty_split_to_leaf() {
    let empty = split_node("empty", Direction::Vertical, vec![]);
    match sanitize_tree(&empty) {
        PanelNode::Leaf(_) => {}
        _ => panic!("an empty split must collapse to a leaf"),
    }
}

#[test]
fn sanitize_tree_collapses_single_child_split() {
    let leaf = leaf_node("leaf-1", &[]);
    let split = split_node("s", Direction::Horizontal, vec![leaf.clone()]);
    assert_eq!(sanitize_tree(&split), leaf);
}

#[test]
fn sanitize_tree_collapses_nested_empty_split() {
    // [Leaf, Split[]] → [Leaf, emptyLeaf]: the empty split becomes an empty leaf
    // sibling, keeping the parent well-formed (≥2 children, no panic-prone split).
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![
            leaf_node("leaf-1", &[]),
            split_node("inner", Direction::Vertical, vec![]),
        ],
    );
    let sanitized = sanitize_tree(&root);
    assert_no_singleton_splits(&sanitized);
    assert_eq!(get_all_leaves(&sanitized).len(), 2);
}

#[test]
fn sanitize_tree_leaves_wellformed_tree_unchanged() {
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
    );
    assert_eq!(sanitize_tree(&root), root);
}

#[test]
fn sanitize_tree_drops_mismatched_sizes() {
    // A hand-edited file may carry a sizes array that no longer matches children.
    let root = PanelNode::Split(SplitContainer {
        sizes: Some(vec![50.0, 30.0, 20.0]), // 3 sizes, 2 children
        ..make_split(
            "h",
            Direction::Horizontal,
            vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
        )
    });
    match sanitize_tree(&root) {
        PanelNode::Split(s) => assert!(s.sizes.is_none(), "mismatched sizes must be dropped"),
        _ => panic!("expected split"),
    }
}

// ── markActiveLeaf ──────────────────────────────────────────────────────────

#[test]
fn mark_active_leaf_marks_all_ancestors() {
    let inner = split_node(
        "v",
        Direction::Vertical,
        vec![leaf_node("leaf-2", &[]), leaf_node("leaf-3", &[])],
    );
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![leaf_node("leaf-1", &[]), inner],
    );
    match mark_active_leaf(&root, "leaf-3") {
        PanelNode::Split(s) => {
            assert_eq!(s.last_active_leaf_id.as_deref(), Some("leaf-3"));
            match &s.children[1] {
                PanelNode::Split(inner) => {
                    assert_eq!(inner.last_active_leaf_id.as_deref(), Some("leaf-3"))
                }
                _ => panic!("expected split"),
            }
        }
        _ => panic!("expected split"),
    }
}

#[test]
fn mark_active_leaf_skips_unrelated_splits() {
    let left = split_node(
        "left",
        Direction::Vertical,
        vec![leaf_node("leaf-1", &[]), leaf_node("leaf-2", &[])],
    );
    let root = split_node(
        "h",
        Direction::Horizontal,
        vec![left, leaf_node("leaf-3", &[])],
    );
    match mark_active_leaf(&root, "leaf-3") {
        PanelNode::Split(s) => {
            assert_eq!(s.last_active_leaf_id.as_deref(), Some("leaf-3"));
            match &s.children[0] {
                PanelNode::Split(left) => assert!(left.last_active_leaf_id.is_none()),
                _ => panic!("expected split"),
            }
        }
        _ => panic!("expected split"),
    }
}

#[test]
fn mark_active_leaf_unchanged_when_not_found() {
    let root = split_node("h", Direction::Horizontal, vec![leaf_node("leaf-1", &[])]);
    assert_eq!(mark_active_leaf(&root, "nonexistent"), root);
}

#[test]
fn mark_active_leaf_unchanged_when_already_marked() {
    let root = PanelNode::Split(SplitContainer {
        last_active_leaf_id: Some("leaf-1".to_string()),
        ..make_split("h", Direction::Horizontal, vec![leaf_node("leaf-1", &[])])
    });
    assert_eq!(mark_active_leaf(&root, "leaf-1"), root);
}

// ── normalizeSizes ──────────────────────────────────────────────────────────

#[test]
fn normalize_sizes_sums_to_100() {
    let result = normalize_sizes(&[30.0, 20.0, 50.0]);
    let total: f64 = result.iter().sum();
    assert!((total - 100.0).abs() < 1e-9);
    assert!((result[0] - 30.0).abs() < 1e-9);
}

#[test]
fn normalize_sizes_scales_up_and_down() {
    let up = normalize_sizes(&[10.0, 10.0]);
    assert!((up[0] - 50.0).abs() < 1e-9);
    let down = normalize_sizes(&[100.0, 100.0]);
    assert!((down[0] - 50.0).abs() < 1e-9);
}

#[test]
fn normalize_sizes_zero_total_distributes_equally() {
    let result = normalize_sizes(&[0.0, 0.0, 0.0]);
    for v in result {
        assert!((v - 100.0 / 3.0).abs() < 1e-9);
    }
}

// ── countTabsInTree / isWindowEmpty ─────────────────────────────────────────

fn make_group(id: &str, root: PanelNode) -> TabGroup {
    TabGroup {
        id: id.to_string(),
        name: id.to_string(),
        root_panel: root,
        active_panel_id: None,
        color: None,
    }
}

#[test]
fn count_tabs_empty_and_split() {
    assert_eq!(count_tabs_in_tree(&leaf_node("leaf-1", &[])), 0);
    let tree = split_node(
        "split-1",
        Direction::Horizontal,
        vec![
            leaf_node("leaf-1", &["a", "b"]),
            leaf_node("leaf-2", &["c"]),
        ],
    );
    assert_eq!(count_tabs_in_tree(&tree), 3);
}

#[test]
fn is_window_empty_various() {
    let active = leaf_node("leaf-1", &[]);
    assert!(is_window_empty(
        &active,
        &[make_group("g1", active.clone())],
        Some("g1")
    ));

    let active_with_tab = leaf_node("leaf-1", &["a"]);
    assert!(!is_window_empty(
        &active_with_tab,
        &[make_group("g1", active_with_tab.clone())],
        Some("g1")
    ));

    let inactive = leaf_node("leaf-2", &["a"]);
    assert!(!is_window_empty(
        &active,
        &[make_group("g1", active.clone()), make_group("g2", inactive)],
        Some("g1")
    ));

    assert!(is_window_empty(
        &active,
        &[
            make_group("g1", active.clone()),
            make_group("g2", leaf_node("leaf-2", &[]))
        ],
        Some("g1")
    ));

    // Uses the live active tree, not the stale stored copy.
    let live_active = leaf_node("leaf-1", &["a"]);
    let stale_stored = leaf_node("leaf-1", &[]);
    assert!(!is_window_empty(
        &live_active,
        &[make_group("g1", stale_stored)],
        Some("g1")
    ));
}

// ── getPanelActiveSessionId (per-pane file drop routing) ─────────────────────

fn tab_with(id: &str, session: Option<&str>, content: &str) -> Tab {
    Tab {
        id: id.to_string(),
        session_id: session.map(str::to_string),
        content_type: content.to_string(),
    }
}

fn leaf_with_tabs(tabs: Vec<Tab>, active: Option<&str>) -> LeafPanel {
    LeafPanel {
        id: "panel-1".to_string(),
        tabs,
        active_tab_id: active.map(str::to_string),
    }
}

#[test]
fn panel_active_session_returns_active_terminal_session() {
    let panel = leaf_with_tabs(
        vec![
            tab_with("a", Some("sess-a"), "terminal"),
            tab_with("b", Some("sess-b"), "terminal"),
        ],
        Some("b"),
    );
    assert_eq!(get_panel_active_session_id(&panel), Some("sess-b"));
}

#[test]
fn panel_active_session_none_when_connecting() {
    let panel = leaf_with_tabs(vec![tab_with("a", None, "terminal")], Some("a"));
    assert_eq!(get_panel_active_session_id(&panel), None);
}

#[test]
fn panel_active_session_none_when_not_terminal() {
    let panel = leaf_with_tabs(vec![tab_with("a", Some("sess-a"), "settings")], Some("a"));
    assert_eq!(get_panel_active_session_id(&panel), None);
}

#[test]
fn panel_active_session_none_for_empty_or_missing() {
    assert_eq!(
        get_panel_active_session_id(&leaf_with_tabs(vec![], None)),
        None
    );
    let panel = leaf_with_tabs(
        vec![tab_with("a", Some("sess-a"), "terminal")],
        Some("gone"),
    );
    assert_eq!(get_panel_active_session_id(&panel), None);
}

// ── Property tests ──────────────────────────────────────────────────────────

/// A structural tree shape, independent of ids. Converted to a `PanelNode` with
/// globally-unique ids in traversal order so `find_leaf` behaves deterministically.
#[derive(Clone, Debug)]
enum Shape {
    Leaf(usize),
    Split(Direction, Vec<Shape>),
}

fn shape_strategy() -> impl Strategy<Value = Shape> {
    let leaf = (0usize..3).prop_map(Shape::Leaf);
    leaf.prop_recursive(4, 24, 4, |inner| {
        (
            prop_oneof![Just(Direction::Horizontal), Just(Direction::Vertical)],
            prop::collection::vec(inner, 2..=4),
        )
            .prop_map(|(dir, children)| Shape::Split(dir, children))
    })
}

fn build_tree(shape: &Shape, next_leaf: &mut usize, next_split: &mut usize) -> PanelNode {
    match shape {
        Shape::Leaf(tab_count) => {
            let id = format!("leaf-{next_leaf}");
            let leaf_idx = *next_leaf;
            *next_leaf += 1;
            let tabs: Vec<Tab> = (0..*tab_count)
                .map(|t| make_tab(&format!("tab-{leaf_idx}-{t}")))
                .collect();
            let active_tab_id = tabs.first().map(|t| t.id.clone());
            PanelNode::Leaf(LeafPanel {
                id,
                tabs,
                active_tab_id,
            })
        }
        Shape::Split(dir, children) => {
            let id = format!("split-{next_split}");
            *next_split += 1;
            let built: Vec<PanelNode> = children
                .iter()
                .map(|c| build_tree(c, next_leaf, next_split))
                .collect();
            PanelNode::Split(SplitContainer {
                id,
                direction: *dir,
                children: built,
                sizes: None,
                last_active_leaf_id: None,
            })
        }
    }
}

fn tree_strategy() -> impl Strategy<Value = PanelNode> {
    shape_strategy().prop_map(|shape| {
        let mut next_leaf = 0;
        let mut next_split = 0;
        build_tree(&shape, &mut next_leaf, &mut next_split)
    })
}

fn leaf_ids(root: &PanelNode) -> Vec<String> {
    get_all_leaves(root).iter().map(|l| l.id.clone()).collect()
}

/// Every split in a well-formed tree has at least two children.
fn assert_no_singleton_splits(node: &PanelNode) {
    if let PanelNode::Split(s) = node {
        assert!(s.children.len() >= 2, "split {} has <2 children", s.id);
        for child in &s.children {
            assert_no_singleton_splits(child);
        }
    }
}

proptest! {
    #[test]
    fn prop_leaf_ids_are_unique(tree in tree_strategy()) {
        let ids = leaf_ids(&tree);
        let unique: HashSet<&String> = ids.iter().collect();
        prop_assert_eq!(ids.len(), unique.len());
    }

    #[test]
    fn prop_count_tabs_matches_leaves(tree in tree_strategy()) {
        let by_leaves: usize = get_all_leaves(&tree).iter().map(|l| l.tabs.len()).sum();
        prop_assert_eq!(count_tabs_in_tree(&tree), by_leaves);
    }

    #[test]
    fn prop_every_leaf_is_findable(tree in tree_strategy()) {
        for id in leaf_ids(&tree) {
            prop_assert!(find_leaf(&tree, &id).is_some());
        }
    }

    #[test]
    fn prop_remove_leaf_drops_exactly_one(tree in tree_strategy()) {
        let ids = leaf_ids(&tree);
        for target in &ids {
            match remove_leaf(&tree, target) {
                None => {
                    // Only valid when the target was the whole tree.
                    prop_assert_eq!(ids.len(), 1);
                }
                Some(result) => {
                    let mut expected: Vec<String> =
                        ids.iter().filter(|i| *i != target).cloned().collect();
                    let mut got = leaf_ids(&result);
                    expected.sort();
                    got.sort();
                    prop_assert_eq!(got, expected);
                    // No orphaned single-child splits remain.
                    assert_no_singleton_splits(&result);
                }
            }
        }
    }

    #[test]
    fn prop_split_then_remove_round_trips(tree in tree_strategy()) {
        let ids = leaf_ids(&tree);
        let new_leaf = make_leaf("inserted-leaf", &[]);
        for target in &ids {
            for (dir, pos) in [
                (Direction::Horizontal, Position::After),
                (Direction::Vertical, Position::Before),
            ] {
                let split = split_leaf(&tree, target, &new_leaf, dir, pos);
                // The inserted leaf exists and total leaf count grew by one.
                prop_assert!(find_leaf(&split, "inserted-leaf").is_some());
                prop_assert_eq!(leaf_ids(&split).len(), ids.len() + 1);
                // Removing it again restores the original leaf-id set.
                let restored = remove_leaf(&split, "inserted-leaf")
                    .expect("tree still has the original leaves");
                let mut got = leaf_ids(&restored);
                let mut expected = ids.clone();
                got.sort();
                expected.sort();
                prop_assert_eq!(got, expected);
            }
        }
    }

    #[test]
    fn prop_simplify_is_idempotent_and_wellformed(tree in tree_strategy()) {
        let once = simplify_tree(&tree);
        let twice = simplify_tree(&once);
        prop_assert_eq!(&once, &twice);
        // Simplify preserves the leaf set.
        let mut before = leaf_ids(&tree);
        let mut after = leaf_ids(&once);
        before.sort();
        after.sort();
        prop_assert_eq!(after, before);
        assert_no_singleton_splits(&once);
        // No split child shares its parent's direction.
        assert_flattened(&once);
    }

    #[test]
    fn prop_mark_active_marks_ancestors_only(tree in tree_strategy()) {
        for id in leaf_ids(&tree) {
            let marked = mark_active_leaf(&tree, &id);
            // Structure/leaf-set unchanged.
            let mut before = leaf_ids(&tree);
            let mut after = leaf_ids(&marked);
            before.sort();
            after.sort();
            prop_assert_eq!(after, before);
            assert_ancestors_marked(&marked, &id);
        }
    }

    #[test]
    fn prop_find_adjacent_returns_existing_other_leaf(tree in tree_strategy()) {
        let ids: HashSet<String> = leaf_ids(&tree).into_iter().collect();
        for id in &ids {
            for dir in [
                FocusDirection::Left,
                FocusDirection::Right,
                FocusDirection::Up,
                FocusDirection::Down,
            ] {
                if let Some(found) = find_adjacent_leaf(&tree, id, dir) {
                    prop_assert!(ids.contains(&found.id));
                    prop_assert_ne!(&found.id, id);
                }
            }
        }
    }

    #[test]
    fn prop_normalize_sizes_sums_to_100(raw in prop::collection::vec(0.0f64..1000.0, 1..8)) {
        let normalized = normalize_sizes(&raw);
        prop_assert_eq!(normalized.len(), raw.len());
        let total: f64 = normalized.iter().sum();
        prop_assert!((total - 100.0).abs() < 1e-6);
    }

    /// Closing panels one at a time down to the last must never panic and must
    /// keep the tree well-formed at every step (CORE-038: the close-sequence
    /// vector into an empty/degenerate `Split`).
    #[test]
    fn prop_closing_all_panels_never_panics(tree in tree_strategy()) {
        let mut current = tree;
        loop {
            let ids = leaf_ids(&current);
            // Exercise navigation from every leaf in every direction — must not panic.
            for id in &ids {
                for dir in [
                    FocusDirection::Left,
                    FocusDirection::Right,
                    FocusDirection::Up,
                    FocusDirection::Down,
                ] {
                    let _ = find_adjacent_leaf(&current, id, dir);
                }
            }
            assert_no_singleton_splits(&current);
            // Close the first leaf; stop once the last (root) leaf is removed.
            match remove_leaf(&current, &ids[0]) {
                Some(next) => current = next,
                None => break,
            }
        }
    }

    /// A tree corrupted with an injected empty `Split` (only a restored /
    /// hand-edited file produces this) must survive navigation without panicking,
    /// and `sanitize_tree` must yield a well-formed tree (CORE-038).
    #[test]
    fn prop_injected_empty_split_is_navigable_and_sanitizes(tree in tree_strategy()) {
        let degenerate = PanelNode::Split(SplitContainer {
            id: "corrupt-root".to_string(),
            direction: Direction::Horizontal,
            children: vec![tree, split_node("empty", Direction::Vertical, vec![])],
            sizes: None,
            last_active_leaf_id: None,
        });
        for id in leaf_ids(&degenerate) {
            for dir in [
                FocusDirection::Left,
                FocusDirection::Right,
                FocusDirection::Up,
                FocusDirection::Down,
            ] {
                let _ = find_adjacent_leaf(&degenerate, &id, dir);
            }
        }
        let sanitized = sanitize_tree(&degenerate);
        assert_no_singleton_splits(&sanitized);
    }
}

/// Assert no split node has a child split of the same direction (post-simplify).
fn assert_flattened(node: &PanelNode) {
    if let PanelNode::Split(s) = node {
        for child in &s.children {
            if let PanelNode::Split(cs) = child {
                assert_ne!(
                    cs.direction, s.direction,
                    "unflattened same-direction nesting"
                );
            }
            assert_flattened(child);
        }
    }
}

/// Assert every split containing `leaf_id` is marked with it and no split that
/// does not contain it is.
fn assert_ancestors_marked(node: &PanelNode, leaf_id: &str) {
    if let PanelNode::Split(s) = node {
        let contains = find_leaf(node, leaf_id).is_some();
        if contains {
            assert_eq!(
                s.last_active_leaf_id.as_deref(),
                Some(leaf_id),
                "ancestor split {} of {} not marked",
                s.id,
                leaf_id
            );
        } else {
            assert_ne!(
                s.last_active_leaf_id.as_deref(),
                Some(leaf_id),
                "non-ancestor split {} marked with {}",
                s.id,
                leaf_id
            );
        }
        for child in &s.children {
            assert_ancestors_marked(child, leaf_id);
        }
    }
}

// ── moveTab (atomic move + prune, #2712) ─────────────────────────────────────

/// Every tab id anywhere in the tree, in leaf order.
fn all_tab_ids(root: &PanelNode) -> Vec<String> {
    get_all_leaves(root)
        .iter()
        .flat_map(|l| l.tabs.iter().map(|t| t.id.clone()))
        .collect()
}

/// Every leaf id anywhere in the tree.
fn all_leaf_ids(root: &PanelNode) -> Vec<String> {
    get_all_leaves(root).iter().map(|l| l.id.clone()).collect()
}

/// A two-panel horizontal split with fixed 50/50 sizes: `a` holds `t1,t2`, `b`
/// holds `t3`. The `sizes` make the width invariant checkable.
fn two_panel_tree() -> PanelNode {
    PanelNode::Split(SplitContainer {
        id: "root".to_string(),
        direction: Direction::Horizontal,
        children: vec![leaf_node("a", &["t1", "t2"]), leaf_node("b", &["t3"])],
        sizes: Some(vec![50.0, 50.0]),
        last_active_leaf_id: None,
    })
}

#[test]
fn move_tab_center_merge_prunes_source_in_one_transform() {
    let tree = two_panel_tree();
    // Move the sole tab out of `b` onto `a`'s stack: `b` empties and is pruned, so
    // the tree collapses straight to the single merged leaf `a`.
    let result = move_tab(&tree, "t3", "a", DropEdge::Center);

    // The settled tree is a single full-width leaf — never the pre-prune two-panel
    // (narrower) geometry. Because the result is a bare `Leaf` (no split, no
    // `sizes`), no interim narrower panel width was ever produced.
    match &result {
        PanelNode::Leaf(leaf) => {
            assert_eq!(leaf.id, "a", "the surviving leaf is the merge destination");
            assert_eq!(
                leaf.tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
                vec!["t1", "t2", "t3"],
                "the moved tab is appended to the destination stack"
            );
            assert_eq!(
                leaf.active_tab_id.as_deref(),
                Some("t3"),
                "the moved tab is focused in its new home"
            );
        }
        PanelNode::Split(_) => {
            panic!("expected a single merged leaf, got a split (pre-prune state)")
        }
    }

    // The emptied source leaf id is gone from the whole tree — no orphan panel.
    assert!(!all_leaf_ids(&result).contains(&"b".to_string()));
    assert_eq!(get_all_leaves(&result).len(), 1);
    assert_eq!(count_tabs_in_tree(&result), 3);
}

#[test]
fn move_tab_edge_splits_target_and_prunes_source() {
    let tree = two_panel_tree();
    // Drop `t3` on `a`'s right edge: `a` splits, the tab lands in a new leaf on the
    // right, and the emptied `b` is pruned — the panel count stays at 2, but the
    // tree never transits a stale 3-panel intermediate (source + target-halves).
    let result = move_tab(&tree, "t3", "a", DropEdge::Right);

    let leaves = get_all_leaves(&result);
    assert_eq!(leaves.len(), 2, "target split into two, source pruned");
    assert!(!all_leaf_ids(&result).contains(&"b".to_string()));
    // The original destination leaf keeps its tabs; the new leaf holds the move.
    assert!(leaves
        .iter()
        .any(|l| l.id == "a" && all_tab_ids(&PanelNode::Leaf((*l).clone())) == vec!["t1", "t2"]));
    assert!(leaves
        .iter()
        .any(|l| l.tabs.len() == 1 && l.tabs[0].id == "t3"));
    assert_eq!(count_tabs_in_tree(&result), 3);
}

#[test]
fn move_tab_center_keeps_both_panels_when_source_not_emptied() {
    let tree = two_panel_tree();
    // Move `t1` (one of two tabs in `a`) onto `b`: `a` still holds `t2`, so it is
    // not pruned and both panels remain.
    let result = move_tab(&tree, "t1", "b", DropEdge::Center);

    assert_eq!(get_all_leaves(&result).len(), 2, "source retains a tab");
    let a = find_leaf(&result, "a").expect("source panel survives");
    assert_eq!(
        a.tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["t2"]
    );
    let b = find_leaf(&result, "b").expect("target panel survives");
    assert_eq!(
        b.tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["t3", "t1"]
    );
    assert_eq!(b.active_tab_id.as_deref(), Some("t1"));
}

#[test]
fn move_tab_preserves_every_tab_id() {
    let tree = two_panel_tree();
    let before: HashSet<String> = all_tab_ids(&tree).into_iter().collect();
    let result = move_tab(&tree, "t3", "a", DropEdge::Center);
    let after: HashSet<String> = all_tab_ids(&result).into_iter().collect();
    assert_eq!(before, after, "no tab id is dropped or invented by a move");
}

#[test]
fn move_tab_unknown_tab_is_structural_noop() {
    let tree = two_panel_tree();
    let result = move_tab(&tree, "does-not-exist", "a", DropEdge::Center);
    assert_eq!(result, tree, "an unknown tab leaves the tree unchanged");
}

#[test]
fn move_tab_unknown_target_is_structural_noop() {
    let tree = two_panel_tree();
    let result = move_tab(&tree, "t3", "no-such-panel", DropEdge::Center);
    assert_eq!(result, tree, "an unknown target leaves the tree unchanged");
}
