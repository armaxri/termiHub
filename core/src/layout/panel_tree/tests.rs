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
