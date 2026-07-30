//! Unit + property tests for the shadow [`LayoutStore`] (#2151).
//!
//! The store is exercised through its public API and asserted on the projected
//! view model (deserialized back into a [`PanelNode`] so the ported algebra's
//! own invariants — unique leaf ids, tab-count identity — can be checked). The
//! property tests drive random sequences of the four `layout.*` transforms and
//! assert the tree invariants hold after every step.

use proptest::prelude::*;
use serde_json::Value;

use super::*;
use termihub_core::layout::panel_tree::{
    count_tabs_in_tree, find_leaf, get_all_leaves, Direction, DropEdge, LeafPanel, PanelNode,
    Position, SplitContainer, Tab,
};

// ── Fixtures / helpers ───────────────────────────────────────────────────────

fn tab(id: &str) -> Tab {
    Tab {
        id: id.to_string(),
        session_id: None,
        content_type: "terminal".to_string(),
    }
}

fn leaf(id: &str, tab_ids: &[&str]) -> LeafPanel {
    let tabs: Vec<Tab> = tab_ids.iter().map(|t| tab(t)).collect();
    let active_tab_id = tabs.first().map(|t| t.id.clone());
    LeafPanel {
        id: id.to_string(),
        tabs,
        active_tab_id,
    }
}

/// A two-leaf horizontal split: `a` holds `t1`,`t2`; `b` holds `t3`.
fn two_panel_tree() -> PanelNode {
    PanelNode::Split(SplitContainer {
        id: "root".to_string(),
        direction: Direction::Horizontal,
        children: vec![
            PanelNode::Leaf(leaf("a", &["t1", "t2"])),
            PanelNode::Leaf(leaf("b", &["t3"])),
        ],
        sizes: None,
        last_active_leaf_id: None,
    })
}

fn root_of(store: &LayoutStore, client: &str) -> PanelNode {
    serde_json::from_value(store.snapshot(client)["root"].clone()).expect("root deserializes")
}

fn active_of(store: &LayoutStore, client: &str) -> Option<String> {
    match store.snapshot(client)["activePanelId"].clone() {
        Value::String(s) => Some(s),
        _ => None,
    }
}

const ALL_EDGES: [DropEdge; 5] = [
    DropEdge::Left,
    DropEdge::Right,
    DropEdge::Top,
    DropEdge::Bottom,
    DropEdge::Center,
];

// ── Seeding ──────────────────────────────────────────────────────────────────

#[test]
fn unknown_client_is_seeded_with_one_empty_focused_leaf() {
    let store = LayoutStore::new();
    let root = root_of(&store, "C");
    let leaves = get_all_leaves(&root);
    assert_eq!(leaves.len(), 1, "one leaf");
    assert!(leaves[0].tabs.is_empty(), "empty");
    assert_eq!(
        active_of(&store, "C").as_deref(),
        Some(leaves[0].id.as_str()),
        "seeded leaf is focused",
    );
}

#[test]
fn snapshot_does_not_mutate_an_existing_client() {
    let store = LayoutStore::new();
    let first = store.snapshot("C");
    let second = store.snapshot("C");
    assert_eq!(first, second, "repeated snapshot is stable");
}

#[test]
fn clients_are_isolated() {
    let store = LayoutStore::new();
    store.seed_for_test("A", two_panel_tree(), Some("a".to_string()));
    // B is untouched: seeded independently.
    assert_eq!(count_tabs_in_tree(&root_of(&store, "A")), 3);
    assert_eq!(count_tabs_in_tree(&root_of(&store, "B")), 0);
}

// ── split ────────────────────────────────────────────────────────────────────

#[test]
fn split_inserts_a_new_empty_focused_leaf_and_preserves_tab_count() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    store
        .split("C", "b", Direction::Vertical, Position::After)
        .unwrap();

    let root = root_of(&store, "C");
    assert_eq!(count_tabs_in_tree(&root), 3, "no tabs created");
    assert_eq!(get_all_leaves(&root).len(), 3, "one more leaf");
    // The new (empty) leaf is focused.
    let active = active_of(&store, "C").unwrap();
    let active_leaf = find_leaf(&root, &active).unwrap();
    assert!(active_leaf.tabs.is_empty(), "new leaf is empty and focused");
}

#[test]
fn split_of_unknown_panel_is_rejected() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    let err = store
        .split("C", "nope", Direction::Horizontal, Position::After)
        .unwrap_err();
    assert_eq!(err, LayoutError::PanelNotFound("nope".to_string()));
    assert_eq!(err.code(), "panel_not_found");
}

// ── merge ────────────────────────────────────────────────────────────────────

#[test]
fn merge_moves_all_tabs_into_target_and_drops_the_source() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    store.merge("C", "a", "b").unwrap();

    let root = root_of(&store, "C");
    // The tree simplifies to the single surviving leaf `b` holding all 3 tabs.
    let leaves = get_all_leaves(&root);
    assert_eq!(leaves.len(), 1, "source dropped, split simplified");
    assert_eq!(leaves[0].id, "b");
    assert_eq!(count_tabs_in_tree(&root), 3, "all tabs preserved");
    let ids: Vec<&str> = leaves[0].tabs.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["t3", "t1", "t2"], "target tabs then source tabs");
    assert_eq!(active_of(&store, "C").as_deref(), Some("b"));
}

#[test]
fn merge_into_self_is_rejected() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    assert_eq!(store.merge("C", "a", "a").unwrap_err(), LayoutError::SamePanel);
}

#[test]
fn merge_with_unknown_source_is_rejected() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    assert_eq!(
        store.merge("C", "ghost", "b").unwrap_err(),
        LayoutError::PanelNotFound("ghost".to_string()),
    );
}

// ── moveTab ──────────────────────────────────────────────────────────────────

#[test]
fn move_tab_center_drops_the_tab_into_the_target_stack() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    store.move_tab("C", "t1", "b", DropEdge::Center).unwrap();

    let root = root_of(&store, "C");
    assert_eq!(count_tabs_in_tree(&root), 3, "tab count preserved");
    let b = find_leaf(&root, "b").unwrap();
    assert!(b.tabs.iter().any(|t| t.id == "t1"), "t1 now in b");
    assert_eq!(b.active_tab_id.as_deref(), Some("t1"), "moved tab focused");
    let a = find_leaf(&root, "a").unwrap();
    assert!(!a.tabs.iter().any(|t| t.id == "t1"), "t1 left a");
}

#[test]
fn move_tab_edge_splits_the_target_into_a_new_leaf() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    store.move_tab("C", "t3", "a", DropEdge::Right).unwrap();

    let root = root_of(&store, "C");
    // b held only t3; moving it out empties and prunes b. t3 lands in a fresh
    // leaf split to the right of a. Total tabs unchanged.
    assert_eq!(count_tabs_in_tree(&root), 3);
    let leaves = get_all_leaves(&root);
    assert!(
        leaves.iter().all(|l| l.id != "b"),
        "emptied source leaf pruned",
    );
    let holder = leaves
        .iter()
        .find(|l| l.tabs.iter().any(|t| t.id == "t3"))
        .expect("a leaf holds t3");
    assert_eq!(holder.tabs.len(), 1, "t3 alone in its new leaf");
}

#[test]
fn move_tab_of_unknown_tab_is_rejected() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    assert_eq!(
        store
            .move_tab("C", "ghost", "b", DropEdge::Center)
            .unwrap_err(),
        LayoutError::TabNotFound("ghost".to_string()),
    );
}

// ── closeTabStructure ────────────────────────────────────────────────────────

#[test]
fn close_tab_removes_one_tab_keeping_a_non_empty_leaf() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    store.close_tab_structure("C", "t1").unwrap();

    let root = root_of(&store, "C");
    assert_eq!(count_tabs_in_tree(&root), 2, "one tab removed");
    // a still holds t2, so the leaf survives; active tab falls back to t2.
    let a = find_leaf(&root, "a").unwrap();
    assert_eq!(a.tabs.len(), 1);
    assert_eq!(a.active_tab_id.as_deref(), Some("t2"));
}

#[test]
fn close_last_tab_in_a_leaf_prunes_and_simplifies() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("b".to_string()));
    store.close_tab_structure("C", "t3").unwrap();

    let root = root_of(&store, "C");
    // b emptied → pruned → split simplified to just a.
    let leaves = get_all_leaves(&root);
    assert_eq!(leaves.len(), 1);
    assert_eq!(leaves[0].id, "a");
    assert_eq!(count_tabs_in_tree(&root), 2);
    // Focus repointed off the vanished leaf onto the survivor.
    assert_eq!(active_of(&store, "C").as_deref(), Some("a"));
}

#[test]
fn close_of_unknown_tab_is_rejected() {
    let store = LayoutStore::new();
    store.seed_for_test("C", two_panel_tree(), Some("a".to_string()));
    assert_eq!(
        store.close_tab_structure("C", "ghost").unwrap_err(),
        LayoutError::TabNotFound("ghost".to_string()),
    );
}

// ── Property tests over the transforms ───────────────────────────────────────

/// After every applied transform: at least one leaf survives, leaf ids stay
/// unique, and the focused panel (when set) still exists.
fn assert_tree_invariants(root: &PanelNode, active: Option<&str>) {
    let leaves = get_all_leaves(root);
    assert!(!leaves.is_empty(), "tree never empties to nothing");
    let mut ids: Vec<&str> = leaves.iter().map(|l| l.id.as_str()).collect();
    let count = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), count, "leaf ids stay unique");
    if let Some(active) = active {
        assert!(find_leaf(root, active).is_some(), "focused panel exists");
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// A random sequence of the four transforms preserves the tree invariants
    /// after every step, and each transform moves the total tab count exactly as
    /// specified: only `closeTabStructure` decrements it (by one), split / merge
    /// / moveTab conserve it.
    #[test]
    fn random_transform_sequence_holds_invariants(
        seq in prop::collection::vec((0u8..4, any::<usize>(), any::<usize>(), 0u8..5), 0..40)
    ) {
        let store = LayoutStore::new();
        let client = "P";
        store.seed_for_test(client, two_panel_tree(), Some("a".to_string()));

        for (op, i, j, e) in seq {
            let root = root_of(&store, client);
            let leaves = get_all_leaves(&root);
            let leaf_ids: Vec<String> = leaves.iter().map(|l| l.id.clone()).collect();
            let src = &leaves[i % leaves.len()];
            let src_id = src.id.clone();
            let tgt_id = leaf_ids[j % leaf_ids.len()].clone();
            let before = count_tabs_in_tree(&root);

            match op {
                0 => {
                    let direction = if e % 2 == 0 { Direction::Horizontal } else { Direction::Vertical };
                    let position = if (e / 2) % 2 == 0 { Position::Before } else { Position::After };
                    store.split(client, &src_id, direction, position).unwrap();
                    prop_assert_eq!(count_tabs_in_tree(&root_of(&store, client)), before);
                }
                1 => {
                    if src_id != tgt_id {
                        store.merge(client, &src_id, &tgt_id).unwrap();
                        prop_assert_eq!(count_tabs_in_tree(&root_of(&store, client)), before);
                    }
                }
                2 => {
                    if let Some(t) = src.tabs.first() {
                        let tab_id = t.id.clone();
                        let edge = ALL_EDGES[e as usize % ALL_EDGES.len()];
                        store.move_tab(client, &tab_id, &tgt_id, edge).unwrap();
                        prop_assert_eq!(count_tabs_in_tree(&root_of(&store, client)), before);
                    }
                }
                _ => {
                    if let Some(t) = src.tabs.first() {
                        let tab_id = t.id.clone();
                        store.close_tab_structure(client, &tab_id).unwrap();
                        prop_assert_eq!(count_tabs_in_tree(&root_of(&store, client)), before - 1);
                    }
                }
            }

            let after = root_of(&store, client);
            let active = active_of(&store, client);
            assert_tree_invariants(&after, active.as_deref());
        }
    }
}
