//! Unit tests (mirroring `restoreMode.test.ts`) plus property tests over the
//! session-pruning invariants.

use super::*;
use proptest::prelude::*;
use serde_json::json;

/// Build an [`AppSettings`] from the two fields the decision reads.
fn settings(mode: Option<&str>, legacy: Option<bool>) -> AppSettings {
    AppSettings {
        restore_last_session_mode: mode.map(str::to_string),
        restore_last_session_on_startup: legacy,
    }
}

/// A leaf node from a list of tabs.
fn leaf(tabs: Vec<WorkspaceTabDef>) -> WorkspaceLayoutNode {
    WorkspaceLayoutNode::Leaf(WorkspaceLeafNode { tabs })
}

/// A single-group session wrapping `layout`.
fn one_group_session(layout: WorkspaceLayoutNode) -> LastSession {
    LastSession {
        version: "1".to_string(),
        tab_groups: vec![WorkspaceTabGroupDef {
            name: "Group".to_string(),
            color: None,
            layout,
            window_id: None,
        }],
        active_group_index: 0,
        windows: None,
    }
}

/// An inline-config tab with an optional title.
fn inline_tab(title: Option<&str>, type_: &str, config: serde_json::Value) -> WorkspaceTabDef {
    WorkspaceTabDef {
        title: title.map(str::to_string),
        inline_config: Some(InlineConfig {
            type_: type_.to_string(),
            config,
        }),
        ..Default::default()
    }
}

// ── resolveRestoreMode ───────────────────────────────────────────────────────

#[test]
fn resolve_returns_explicit_mode_when_set() {
    assert_eq!(
        resolve_restore_mode(&settings(Some("never"), None)),
        RestoreLastSessionMode::Never
    );
    assert_eq!(
        resolve_restore_mode(&settings(Some("ask"), None)),
        RestoreLastSessionMode::Ask
    );
    assert_eq!(
        resolve_restore_mode(&settings(Some("always"), None)),
        RestoreLastSessionMode::Always
    );
}

#[test]
fn resolve_prefers_explicit_over_legacy_boolean() {
    assert_eq!(
        resolve_restore_mode(&settings(Some("always"), Some(false))),
        RestoreLastSessionMode::Always
    );
}

#[test]
fn resolve_migrates_legacy_false_to_never() {
    assert_eq!(
        resolve_restore_mode(&settings(None, Some(false))),
        RestoreLastSessionMode::Never
    );
}

#[test]
fn resolve_defaults_to_ask_when_nothing_set() {
    assert_eq!(
        resolve_restore_mode(&settings(None, None)),
        RestoreLastSessionMode::Ask
    );
}

#[test]
fn resolve_defaults_to_ask_when_legacy_true() {
    assert_eq!(
        resolve_restore_mode(&settings(None, Some(true))),
        RestoreLastSessionMode::Ask
    );
}

#[test]
fn resolve_falls_through_to_ask_for_out_of_range_mode() {
    assert_eq!(
        resolve_restore_mode(&settings(Some("bogus"), None)),
        RestoreLastSessionMode::Ask
    );
}

// ── summarizeLastSession ─────────────────────────────────────────────────────

fn nested_session() -> LastSession {
    one_group_session(WorkspaceLayoutNode::Split(WorkspaceSplitNode {
        direction: SplitDirection::Horizontal,
        children: vec![
            leaf(vec![
                inline_tab(Some("prod-db"), "ssh", json!({ "host": "prod-db" })),
                inline_tab(None, "serial", json!({ "device": "/dev/ttyUSB0" })),
            ]),
            leaf(vec![inline_tab(None, "local", json!({ "shell": "bash" }))]),
        ],
        sizes: None,
    }))
}

#[test]
fn summarize_counts_every_tab_across_nested_leaves() {
    assert_eq!(summarize_last_session(&nested_session(), &[]).tab_count, 3);
}

#[test]
fn summarize_uses_title_override_and_type_labels() {
    let tabs = summarize_last_session(&nested_session(), &[]).tabs;
    assert_eq!(tabs[0].title, "prod-db");
    assert_eq!(tabs[0].type_label, "SSH");
    // No title falls back to the device path with the Serial badge.
    assert_eq!(tabs[1].title, "/dev/ttyUSB0");
    assert_eq!(tabs[1].type_label, "Serial");
    assert_eq!(tabs[2].title, "Local");
    assert_eq!(tabs[2].type_label, "Local");
}

#[test]
fn summarize_derives_a_probe_target_per_tab() {
    let tabs = summarize_last_session(&nested_session(), &[]).tabs;
    assert_eq!(
        tabs[0].target,
        Some(RestoreTabTarget {
            kind: TargetKind::Host,
            host: Some("prod-db".to_string()),
            port: Some(22),
            device: None,
            agent_id: None,
        })
    );
    assert_eq!(
        tabs[1].target,
        Some(RestoreTabTarget {
            kind: TargetKind::Serial,
            host: None,
            port: None,
            device: Some("/dev/ttyUSB0".to_string()),
            agent_id: None,
        })
    );
    assert_eq!(
        tabs[2].target.as_ref().map(|t| t.kind),
        Some(TargetKind::Local)
    );
}

#[test]
fn summarize_uses_the_telnet_default_port() {
    let session = one_group_session(leaf(vec![inline_tab(
        None,
        "telnet",
        json!({ "host": "switch" }),
    )]));
    assert_eq!(
        summarize_last_session(&session, &[]).tabs[0].target,
        Some(RestoreTabTarget {
            kind: TargetKind::Host,
            host: Some("switch".to_string()),
            port: Some(23),
            device: None,
            agent_id: None,
        })
    );
}

#[test]
fn summarize_honours_an_explicit_host_port() {
    let session = one_group_session(leaf(vec![inline_tab(
        None,
        "ssh",
        json!({ "host": "h", "port": 2222 }),
    )]));
    assert_eq!(
        summarize_last_session(&session, &[]).tabs[0]
            .target
            .as_ref()
            .and_then(|t| t.port),
        Some(2222)
    );
}

#[test]
fn summarize_resolves_a_connection_ref_target() {
    let connections = vec![SavedConnection {
        id: "c1".to_string(),
        config: ConnectionConfig {
            type_: "ssh".to_string(),
            config: json!({ "host": "10.0.0.5", "port": 22 }),
        },
    }];
    let session = one_group_session(leaf(vec![WorkspaceTabDef {
        connection_ref: Some("c1".to_string()),
        title: Some("prod".to_string()),
        ..Default::default()
    }]));
    assert_eq!(
        summarize_last_session(&session, &connections).tabs[0].target,
        Some(RestoreTabTarget {
            kind: TargetKind::Host,
            host: Some("10.0.0.5".to_string()),
            port: Some(22),
            device: None,
            agent_id: None,
        })
    );
    // Without the connections the ref cannot resolve → not network-probed.
    assert_eq!(
        summarize_last_session(&session, &[]).tabs[0]
            .target
            .as_ref()
            .map(|t| t.kind),
        Some(TargetKind::Local)
    );
}

#[test]
fn summarize_derives_an_agent_target() {
    let session = one_group_session(leaf(vec![WorkspaceTabDef {
        agent_ref: Some(AgentRef {
            agent_id: "a1".to_string(),
            definition_id: "d1".to_string(),
        }),
        ..Default::default()
    }]));
    assert_eq!(
        summarize_last_session(&session, &[]).tabs[0].target,
        Some(RestoreTabTarget {
            kind: TargetKind::Agent,
            host: None,
            port: None,
            device: None,
            agent_id: Some("a1".to_string()),
        })
    );
    assert_eq!(
        summarize_last_session(&session, &[]).tabs[0].type_label,
        "Agent"
    );
}

#[test]
fn summarize_reports_zero_tabs_for_empty_session() {
    let session = one_group_session(leaf(vec![]));
    let prompt = summarize_last_session(&session, &[]);
    assert_eq!(prompt.tab_count, 0);
    assert!(prompt.tabs.is_empty());
}

// ── filterSessionBySelection ─────────────────────────────────────────────────

fn filter_fixture_session() -> LastSession {
    one_group_session(WorkspaceLayoutNode::Split(WorkspaceSplitNode {
        direction: SplitDirection::Horizontal,
        sizes: Some(vec![60.0, 40.0]),
        children: vec![
            leaf(vec![
                inline_tab(Some("ssh"), "ssh", json!({ "host": "h" })),
                inline_tab(Some("serial"), "serial", json!({ "device": "/dev/x" })),
            ]),
            leaf(vec![inline_tab(Some("local"), "local", json!({}))]),
        ],
    }))
}

fn set(indices: &[i64]) -> HashSet<i64> {
    indices.iter().copied().collect()
}

fn collect_titles(session: &LastSession) -> Vec<String> {
    session
        .tab_groups
        .iter()
        .flat_map(|g| get_workspace_leaves(&g.layout))
        .flat_map(|l| l.tabs.iter().filter_map(|t| t.title.clone()))
        .collect()
}

fn count_tabs(node: &WorkspaceLayoutNode) -> usize {
    match node {
        WorkspaceLayoutNode::Leaf(l) => l.tabs.len(),
        WorkspaceLayoutNode::Split(s) => s.children.iter().map(count_tabs).sum(),
    }
}

#[test]
fn filter_keeps_only_selected_tabs() {
    let filtered = filter_session_by_selection(&filter_fixture_session(), &set(&[0, 2]));
    assert_eq!(collect_titles(&filtered), vec!["ssh", "local"]);
}

#[test]
fn filter_collapses_a_split_whose_sibling_empties() {
    // Deselect the local tab (index 2) → second leaf empties, the split
    // collapses to the first leaf.
    let filtered = filter_session_by_selection(&filter_fixture_session(), &set(&[0, 1]));
    let layout = &filtered.tab_groups[0].layout;
    assert!(matches!(layout, WorkspaceLayoutNode::Leaf(_)));
    assert_eq!(count_tabs(layout), 2);
}

#[test]
fn filter_drops_a_group_whose_every_tab_was_deselected() {
    let two_groups = LastSession {
        version: "1".to_string(),
        active_group_index: 1,
        windows: None,
        tab_groups: vec![
            WorkspaceTabGroupDef {
                name: "A".to_string(),
                color: None,
                window_id: None,
                layout: leaf(vec![WorkspaceTabDef {
                    title: Some("a".to_string()),
                    ..Default::default()
                }]),
            },
            WorkspaceTabGroupDef {
                name: "B".to_string(),
                color: None,
                window_id: None,
                layout: leaf(vec![WorkspaceTabDef {
                    title: Some("b".to_string()),
                    ..Default::default()
                }]),
            },
        ],
    };
    // Keep only tab 0 (group A) → group B is removed, active remaps to A.
    let filtered = filter_session_by_selection(&two_groups, &set(&[0]));
    assert_eq!(
        filtered
            .tab_groups
            .iter()
            .map(|g| g.name.clone())
            .collect::<Vec<_>>(),
        vec!["A"]
    );
    assert_eq!(filtered.active_group_index, 0);
}

#[test]
fn filter_yields_no_groups_when_nothing_selected() {
    let filtered = filter_session_by_selection(&filter_fixture_session(), &HashSet::new());
    assert!(filtered.tab_groups.is_empty());
}

#[test]
fn filter_redistributes_sizes_when_a_child_is_dropped() {
    // A three-way split; drop the middle child by deselecting its only tab.
    let session = one_group_session(WorkspaceLayoutNode::Split(WorkspaceSplitNode {
        direction: SplitDirection::Vertical,
        sizes: Some(vec![50.0, 30.0, 20.0]),
        children: vec![
            leaf(vec![WorkspaceTabDef::default()]),
            leaf(vec![WorkspaceTabDef::default()]),
            leaf(vec![WorkspaceTabDef::default()]),
        ],
    }));
    // Keep tabs 0 and 2 (drop index 1, the middle leaf).
    let filtered = filter_session_by_selection(&session, &set(&[0, 2]));
    match &filtered.tab_groups[0].layout {
        WorkspaceLayoutNode::Split(s) => {
            // 50 and 20 renormalize to 100: 50/70*100, 20/70*100.
            let sizes = s.sizes.as_ref().expect("sizes preserved");
            assert!((sizes[0] - 50.0 / 70.0 * 100.0).abs() < 1e-9);
            assert!((sizes[1] - 20.0 / 70.0 * 100.0).abs() < 1e-9);
        }
        _ => panic!("expected a two-child split"),
    }
}

// ── getWorkspaceLeaves ───────────────────────────────────────────────────────

#[test]
fn get_workspace_leaves_walks_depth_first() {
    let tree = WorkspaceLayoutNode::Split(WorkspaceSplitNode {
        direction: SplitDirection::Horizontal,
        sizes: None,
        children: vec![
            leaf(vec![inline_tab(Some("a"), "local", json!({}))]),
            WorkspaceLayoutNode::Split(WorkspaceSplitNode {
                direction: SplitDirection::Vertical,
                sizes: None,
                children: vec![
                    leaf(vec![inline_tab(Some("b"), "local", json!({}))]),
                    leaf(vec![inline_tab(Some("c"), "local", json!({}))]),
                ],
            }),
        ],
    });
    let leaves = get_workspace_leaves(&tree);
    assert_eq!(leaves.len(), 3);
    let titles: Vec<_> = leaves
        .iter()
        .flat_map(|l| l.tabs.iter().filter_map(|t| t.title.as_deref()))
        .collect();
    assert_eq!(titles, vec!["a", "b", "c"]);
}

#[test]
fn get_workspace_leaves_on_a_single_leaf() {
    let tree = leaf(vec![WorkspaceTabDef::default()]);
    assert_eq!(get_workspace_leaves(&tree).len(), 1);
}

// ── Property tests ───────────────────────────────────────────────────────────

/// Assert no leaf is empty and no split has fewer than two children — the
/// structural invariants [`filter_session_by_selection`] must uphold.
fn assert_well_formed(node: &WorkspaceLayoutNode) -> Result<(), TestCaseError> {
    match node {
        WorkspaceLayoutNode::Leaf(l) => {
            prop_assert!(!l.tabs.is_empty(), "kept leaf must be non-empty");
        }
        WorkspaceLayoutNode::Split(s) => {
            prop_assert!(s.children.len() >= 2, "split must keep >= 2 children");
            for child in &s.children {
                assert_well_formed(child)?;
            }
        }
    }
    Ok(())
}

fn arb_tab() -> impl Strategy<Value = WorkspaceTabDef> {
    prop::option::of("[a-z]{1,4}").prop_map(|title| WorkspaceTabDef {
        title,
        ..Default::default()
    })
}

fn arb_layout() -> impl Strategy<Value = WorkspaceLayoutNode> {
    let leaf = prop::collection::vec(arb_tab(), 0..4)
        .prop_map(|tabs| WorkspaceLayoutNode::Leaf(WorkspaceLeafNode { tabs }));
    leaf.prop_recursive(3, 24, 4, |inner| {
        (
            prop::sample::select(vec![SplitDirection::Horizontal, SplitDirection::Vertical]),
            prop::collection::vec(inner, 1..4),
        )
            .prop_map(|(direction, children)| {
                WorkspaceLayoutNode::Split(WorkspaceSplitNode {
                    direction,
                    children,
                    sizes: None,
                })
            })
    })
}

proptest! {
    /// Filtering keeps exactly the selected tabs and always yields a well-formed
    /// tree (no empty leaves, no under-filled splits).
    #[test]
    fn prop_filter_keeps_exactly_selected(layout in arb_layout(), picks in prop::collection::vec(any::<bool>(), 0..48)) {
        let session = one_group_session(layout.clone());
        let total = count_tabs(&layout);
        let selected: HashSet<i64> = (0..total as i64)
            .filter(|i| *picks.get(*i as usize).unwrap_or(&false))
            .collect();
        let expected = selected.len();

        let out = filter_session_by_selection(&session, &selected);
        let got: usize = out.tab_groups.iter().map(|g| count_tabs(&g.layout)).sum();
        prop_assert_eq!(got, expected);

        for g in &out.tab_groups {
            assert_well_formed(&g.layout)?;
        }
        // A group survives iff it retained at least one tab.
        prop_assert_eq!(out.tab_groups.is_empty(), expected == 0);
    }

    /// The active-group index always points at a surviving group (or 0 when none).
    #[test]
    fn prop_active_index_stays_in_range(layout in arb_layout(), picks in prop::collection::vec(any::<bool>(), 0..48)) {
        let session = one_group_session(layout.clone());
        let total = count_tabs(&layout);
        let selected: HashSet<i64> = (0..total as i64)
            .filter(|i| *picks.get(*i as usize).unwrap_or(&false))
            .collect();
        let out = filter_session_by_selection(&session, &selected);
        if out.tab_groups.is_empty() {
            prop_assert_eq!(out.active_group_index, 0);
        } else {
            prop_assert!(out.active_group_index >= 0);
            prop_assert!((out.active_group_index as usize) < out.tab_groups.len());
        }
    }

    /// The summary reports one tab per leaf-tab and its count matches the tree.
    #[test]
    fn prop_summary_counts_all_tabs(layout in arb_layout()) {
        let session = one_group_session(layout.clone());
        let prompt = summarize_last_session(&session, &[]);
        prop_assert_eq!(prompt.tab_count, count_tabs(&layout));
        prop_assert_eq!(prompt.tabs.len(), count_tabs(&layout));
    }
}
