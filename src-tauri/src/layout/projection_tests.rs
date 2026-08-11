//! Projection-contract tests for the client-scoped `layout@<clientId>` region
//! (#2151), reusing the substrate harness patterns established by the Phase-1
//! tests and the tunnel pilot (an in-memory [`ProjectionSink`] + a client cache
//! that applies diffs). The routes here drive a real [`LayoutStore`] directly
//! (the production `register_layout_intents` resolves the same store from the
//! Tauri `AppHandle`; that thin wiring is integration-verified via a local
//! `./scripts/dev.sh` run) through the identical parse → mutate → publish path.
//!
//! Asserted: subscribe → seeded snapshot (identical to every subscriber), an
//! accepted intent → exactly one coalesced diff fanned to every subscriber with
//! monotonic versions, client-scoped isolation (an intent from one client does
//! not touch another client's region), rejection paths advance nothing, and a
//! dead subscriber is reaped.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::*;
use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, ProjectionError,
    ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};
use termihub_core::layout::panel_tree::{
    Direction, DropEdge, LeafPanel, PanelNode, Position, SplitContainer, Tab,
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

/// A store seeded with `two_panel_tree` for `client`.
fn seeded_store(client: &str) -> Arc<LayoutStore> {
    let store = Arc::new(LayoutStore::new());
    store.seed_for_test(client, two_panel_tree(), Some("a".to_string()));
    store
}

/// The production `layout.*` routes, but bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_layout_intents` runs.
fn registry_for(store: Arc<LayoutStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("layout.split", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        let direction: Direction = required_enum(intent, "direction")?;
        let position: Position = required_enum(intent, "position")?;
        s.split(
            &intent.client_id,
            group.as_deref(),
            &panel_id,
            direction,
            position,
        )
        .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.merge", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let source = required_str(intent, "sourcePanelId")?;
        let target = required_str(intent, "targetPanelId")?;
        s.merge(&intent.client_id, group.as_deref(), &source, &target)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.moveTab", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let tab_id = required_str(intent, "tabId")?;
        let target = required_str(intent, "targetPanelId")?;
        let edge: DropEdge = required_enum(intent, "edge")?;
        s.move_tab(&intent.client_id, group.as_deref(), &tab_id, &target, edge)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.closeTabStructure", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let tab_id = required_str(intent, "tabId")?;
        s.close_tab_structure(&intent.client_id, group.as_deref(), &tab_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.addTab", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        let tab = parse_tab(intent)?;
        s.add_tab(&intent.client_id, group.as_deref(), &panel_id, tab)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.removePanel", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        s.remove_panel(&intent.client_id, group.as_deref(), &panel_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.reorderTabs", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        let old_index = required_usize(intent, "oldIndex")?;
        let new_index = required_usize(intent, "newIndex")?;
        s.reorder_tabs(
            &intent.client_id,
            group.as_deref(),
            &panel_id,
            old_index,
            new_index,
        )
        .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.setActivePanel", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        s.set_active_panel(&intent.client_id, group.as_deref(), &panel_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.setActiveTab", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let tab_id = required_str(intent, "tabId")?;
        s.set_active_tab(&intent.client_id, group.as_deref(), &tab_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.resize", move |intent, projector| {
        let group = optional_str(intent, "groupId");
        let split_id = required_str(intent, "splitId")?;
        let sizes = required_sizes(intent, "sizes")?;
        s.resize(&intent.client_id, group.as_deref(), &split_id, sizes)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.replace", move |intent, projector| {
        let (root, active_panel_id) = parse_replace(intent)?;
        s.replace(&intent.client_id, root, active_panel_id);
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.addGroup", move |intent, projector| {
        let name = optional_str(intent, "name");
        s.add_group(&intent.client_id, name);
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.closeGroup", move |intent, projector| {
        let group_id = required_str(intent, "groupId")?;
        s.close_group(&intent.client_id, &group_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.renameGroup", move |intent, projector| {
        let group_id = required_str(intent, "groupId")?;
        let name = required_str(intent, "name")?;
        s.rename_group(&intent.client_id, &group_id, name)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.setGroupColor", move |intent, projector| {
        let group_id = required_str(intent, "groupId")?;
        let color = optional_str(intent, "color");
        s.set_group_color(&intent.client_id, &group_id, color)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.setActiveGroup", move |intent, projector| {
        let group_id = required_str(intent, "groupId")?;
        s.set_active_group(&intent.client_id, &group_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.reorderGroups", move |intent, projector| {
        let from_index = required_usize(intent, "fromIndex")?;
        let to_index = required_usize(intent, "toIndex")?;
        s.reorder_groups(&intent.client_id, from_index, to_index)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.moveTabToGroup", move |intent, projector| {
        let tab_id = required_str(intent, "tabId")?;
        let from_panel_id = required_str(intent, "fromPanelId")?;
        let target_group_id = required_str(intent, "targetGroupId")?;
        s.move_tab_to_group(&intent.client_id, &tab_id, &from_panel_id, &target_group_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.addGroupWithTab", move |intent, projector| {
        let tab_id = required_str(intent, "tabId")?;
        let from_panel_id = required_str(intent, "fromPanelId")?;
        s.add_group_with_tab(&intent.client_id, &tab_id, &from_panel_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store;
    registry.route("layout.replaceGroups", move |intent, projector| {
        let (groups, active_group_id) = parse_replace_groups(intent)?;
        s.replace_groups(&intent.client_id, groups, active_group_id);
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    registry
}

/// An in-memory sink recording delivered frames; can be killed to simulate a
/// dead subscriber (mirrors the substrate/tunnel test double).
struct VecSink {
    frames: Mutex<Vec<ProjectionFrame>>,
    alive: AtomicBool,
}

impl VecSink {
    fn new() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            alive: AtomicBool::new(true),
        }
    }

    fn diffs(&self) -> Vec<DiffFrame> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|f| match f {
                ProjectionFrame::Diff(d) => Some(d.clone()),
                ProjectionFrame::Snapshot(_) => None,
            })
            .collect()
    }
}

impl ProjectionSink for VecSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(ProjectionError::SinkClosed("killed".into()));
        }
        self.frames.lock().unwrap().push(frame.clone());
        Ok(())
    }
}

/// A minimal client cache mirroring the TypeScript `ProjectionClient`.
struct ClientCache {
    version: u64,
    view: Value,
}

impl ClientCache {
    fn from_snapshot(s: &SnapshotFrame) -> Self {
        Self {
            version: s.version,
            view: s.view.clone(),
        }
    }

    fn apply(&mut self, diff: &DiffFrame) {
        assert_eq!(diff.base_version, self.version, "diff must fit the cache");
        apply_ops(&mut self.view, &diff.ops).expect("diff applies cleanly");
        self.version = diff.version;
    }
}

fn intent(kind: &str, client: &str, payload: Value) -> Intent {
    Intent {
        intent_id: format!("01J-{kind}"),
        kind: kind.to_string(),
        payload,
        client_id: client.to_string(),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn subscribe_returns_the_seeded_snapshot_identically_to_every_subscriber() {
    let store = seeded_store("A");
    let region = layout_region("A");

    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));

    let snap_a = projector.subscribe(&region, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(&region, "sub-b", "A", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "layout@A");
    // The view model is the full multi-group view: one group holding the panel
    // tree + focused panel, and the active-group id (#2283 slice C).
    let groups = snap_a.view["groups"].as_array().expect("groups array");
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0]["activePanelId"], json!("a"));
    assert_eq!(groups[0]["root"]["type"], json!("split"));
    assert_eq!(snap_a.view["activeGroupId"], groups[0]["id"]);
}

#[test]
fn split_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub-a", "A", sink_a.clone());
    projector.subscribe(&region, "sub-b", "A", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "layout.split",
        "A",
        json!({ "panelId": "a", "direction": "vertical", "position": "after" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![crate::projection::ProducedRegion {
            region: region.clone(),
            version: 1,
        }])
    );

    let diffs_a = sink_a.diffs();
    let diffs_b = sink_b.diffs();
    assert_eq!(diffs_a.len(), 1, "exactly one diff to A");
    assert_eq!(diffs_b.len(), 1, "exactly one diff to B");
    assert_eq!(diffs_a[0], diffs_b[0], "identical diff to every subscriber");
    assert_eq!(diffs_a[0].base_version, 0);
    assert_eq!(diffs_a[0].version, 1);

    cache_a.apply(&diffs_a[0]);
    assert_eq!(
        cache_a.view,
        store.snapshot_full("A"),
        "cache converges on authority"
    );
}

#[test]
fn move_and_close_intents_advance_the_region_monotonically() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "layout.moveTab",
        "A",
        json!({ "tabId": "t1", "targetPanelId": "b", "edge": "center" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let ack = dispatcher.dispatch(intent(
        "layout.closeTabStructure",
        "A",
        json!({ "tabId": "t3" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 2, "one diff per accepted intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 2);
    assert_eq!(
        cache.view,
        store.snapshot_full("A"),
        "cache converges on authority"
    );
}

#[test]
fn replace_seeds_a_tree_then_a_structural_intent_round_trips() {
    // The step-2 bridge flow: an empty store is seeded from the frontend tree via
    // `layout.replace`, then a structural intent mutates that seeded tree and the
    // cache converges on authority — the round-trip the frontend reconciles.
    let store = Arc::new(LayoutStore::new());
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    // Lazily seeds an empty leaf; the region exists before the first replace.
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // Seed the store with the frontend's authoritative tree.
    let ack = dispatcher.dispatch(intent(
        "layout.replace",
        "A",
        json!({ "root": two_panel_tree(), "activePanelId": "a" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    // Now a structural intent operates on the seeded tree.
    let ack = dispatcher.dispatch(intent(
        "layout.moveTab",
        "A",
        json!({ "tabId": "t1", "targetPanelId": "b", "edge": "center" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 2, "one diff for replace, one for the move");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 2);
    assert_eq!(
        cache.view,
        store.snapshot_full("A"),
        "cache converges on authority"
    );
    // t1 landed in b; a is left with t2 — tab count is conserved across the seed.
    let root: PanelNode =
        serde_json::from_value(store.snapshot_full("A")["groups"][0]["root"].clone()).unwrap();
    assert_eq!(
        termihub_core::layout::panel_tree::count_tabs_in_tree(&root),
        3
    );
}

#[test]
fn the_step2b_intents_round_trip_and_converge_on_authority() {
    // The four step-2b cuts (#2188): removePanel, reorderTabs, setActivePanel,
    // resize each accept and fan a single diff, and the client cache converges on
    // the store's authoritative view after each.
    let store = Arc::new(LayoutStore::new());
    // A three-leaf tree so removePanel/resize have structure to work on.
    let tree = PanelNode::Split(SplitContainer {
        id: "root".to_string(),
        direction: Direction::Horizontal,
        children: vec![
            PanelNode::Leaf(leaf("a", &["t1", "t2"])),
            PanelNode::Leaf(leaf("b", &["t3"])),
            PanelNode::Leaf(leaf("c", &["t4"])),
        ],
        sizes: None,
        last_active_leaf_id: None,
    });
    store.seed_for_test("A", tree, Some("a".to_string()));
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "layout.reorderTabs",
        "A",
        json!({ "panelId": "a", "oldIndex": 0, "newIndex": 1 }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    let ack = dispatcher.dispatch(intent(
        "layout.resize",
        "A",
        json!({ "splitId": "root", "sizes": [50.0, 25.0, 25.0] }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    let ack = dispatcher.dispatch(intent(
        "layout.setActivePanel",
        "A",
        json!({ "panelId": "c" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    let ack = dispatcher.dispatch(intent("layout.removePanel", "A", json!({ "panelId": "b" })));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 4, "one diff per accepted intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 4);
    assert_eq!(
        cache.view,
        store.snapshot_full("A"),
        "cache converges on authority"
    );

    // Final assertions on the authoritative tree.
    let root: PanelNode =
        serde_json::from_value(store.snapshot_full("A")["groups"][0]["root"].clone()).unwrap();
    let a = termihub_core::layout::panel_tree::find_leaf(&root, "a").unwrap();
    assert_eq!(
        a.tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["t2", "t1"],
        "reorder landed"
    );
    assert!(
        termihub_core::layout::panel_tree::find_leaf(&root, "b").is_none(),
        "removePanel dropped b"
    );
    assert_eq!(
        store.snapshot_full("A")["groups"][0]["activePanelId"],
        json!("c"),
        "focus folded into the projection"
    );
}

#[test]
fn a_bad_reorder_index_is_rejected_without_advancing() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    // b holds a single tab → index 5 is out of range.
    let ack = dispatcher.dispatch(intent(
        "layout.reorderTabs",
        "A",
        json!({ "panelId": "b", "oldIndex": 5, "newIndex": 0 }),
    ));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn intents_are_client_scoped_across_regions() {
    // One store seeded for two clients; each client subscribes to its own region.
    let store = Arc::new(LayoutStore::new());
    store.seed_for_test("A", two_panel_tree(), Some("a".to_string()));
    store.seed_for_test("B", two_panel_tree(), Some("a".to_string()));

    let projector = Arc::new(Projector::new());
    projector.register_region(&layout_region("A"), store.snapshot_full("A"));
    projector.register_region(&layout_region("B"), store.snapshot_full("B"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    projector.subscribe(&layout_region("A"), "sa", "A", sink_a.clone());
    projector.subscribe(&layout_region("B"), "sb", "B", sink_b.clone());

    // A splits; only A's region advances.
    dispatcher.dispatch(intent(
        "layout.split",
        "A",
        json!({ "panelId": "a", "direction": "horizontal", "position": "after" }),
    ));

    assert_eq!(sink_a.diffs().len(), 1, "A's region got the diff");
    assert_eq!(sink_b.diffs().len(), 0, "B's region untouched");
    assert_eq!(projector.region_version(&layout_region("B")), Some(0));
}

#[test]
fn a_rejected_intent_advances_nothing() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    // Unknown tab → rejected, no diff, no version bump.
    let ack = dispatcher.dispatch(intent(
        "layout.moveTab",
        "A",
        json!({ "tabId": "ghost", "targetPanelId": "b", "edge": "center" }),
    ));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "tab_not_found");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn a_dead_subscriber_is_reaped_and_others_keep_receiving() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(&region, "live", "A", live.clone());
    projector.subscribe(&region, "dead", "A", dead.clone());
    dead.alive.store(false, Ordering::SeqCst);

    dispatcher.dispatch(intent(
        "layout.split",
        "A",
        json!({ "panelId": "a", "direction": "vertical", "position": "before" }),
    ));

    assert_eq!(projector.subscriber_count(&region), 1, "dead reaped");
    assert_eq!(live.diffs().len(), 1, "live subscriber still receives");
}

// ── New route parity: addTab / group-level intents (#2283 slice A) ────────────

/// Wire a projector + dispatcher over `store` for client `A`, returning the
/// dispatcher, the region id, a subscribed sink, and the seeded client cache.
fn harness_for(store: Arc<LayoutStore>) -> (Dispatcher, String, Arc<VecSink>, ClientCache) {
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let cache = ClientCache::from_snapshot(&snap);
    (dispatcher, region, sink, cache)
}

#[test]
fn add_tab_route_inserts_a_tab_and_converges() {
    let store = seeded_store("A");
    let (dispatcher, _region, sink, mut cache) = harness_for(store.clone());

    let ack = dispatcher.dispatch(intent(
        "layout.addTab",
        "A",
        json!({ "panelId": "b", "tab": { "id": "new", "contentType": "terminal" } }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    for diff in &sink.diffs() {
        cache.apply(diff);
    }
    assert_eq!(
        cache.view,
        store.snapshot_full("A"),
        "cache converges on authority"
    );

    let root: PanelNode =
        serde_json::from_value(store.snapshot_full("A")["groups"][0]["root"].clone()).unwrap();
    let b = termihub_core::layout::panel_tree::find_leaf(&root, "b").unwrap();
    assert!(
        b.tabs.iter().any(|t| t.id == "new"),
        "tab inserted via route"
    );
}

#[test]
fn add_group_route_appends_a_group_and_widens_the_full_view() {
    let store = seeded_store("A");
    let (dispatcher, region, sink, mut cache) = harness_for(store.clone());

    let ack = dispatcher.dispatch(intent("layout.addGroup", "A", json!({ "name": "Extra" })));
    assert_eq!(ack.status, IntentStatus::Accepted);

    // The full authority now has two groups with the new one active.
    let full = store.snapshot_full("A");
    let groups = full["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 2);
    assert_eq!(full["activeGroupId"], groups[1]["id"]);
    assert_eq!(groups[1]["name"], json!("Extra"));

    // The multi-group region carries every group, so adding one moves the view:
    // one diff, and the cache converges on the widened authority (#2283 slice C).
    let _ = region;
    for diff in &sink.diffs() {
        cache.apply(diff);
    }
    assert_eq!(
        cache.view,
        store.snapshot_full("A"),
        "region carries the full multi-group view"
    );
    assert_eq!(cache.view["groups"].as_array().unwrap().len(), 2);
}

#[test]
fn rename_group_route_moves_the_full_view_and_updates_authority() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    let group_id = store.snapshot_full("A")["activeGroupId"]
        .as_str()
        .unwrap()
        .to_string();
    let ack = dispatcher.dispatch(intent(
        "layout.renameGroup",
        "A",
        json!({ "groupId": group_id, "name": "Renamed" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    // The full view carries group metadata, so a rename now moves the region:
    // exactly one diff, and the cache converges on the renamed authority.
    assert_eq!(sink.diffs().len(), 1, "rename moves the full view");
    assert_eq!(projector.region_version(&region), Some(1));
    for diff in &sink.diffs() {
        cache.apply(diff);
    }
    assert_eq!(cache.view, store.snapshot_full("A"));
    assert_eq!(
        store.snapshot_full("A")["groups"][0]["name"],
        json!("Renamed")
    );
}

#[test]
fn replace_groups_route_installs_a_multi_group_layout_then_routes_operate() {
    let store = Arc::new(LayoutStore::new());
    let (dispatcher, _region, _sink, _cache) = harness_for(store.clone());

    // Install two groups; g1 active holding two_panel_tree, g2 a single leaf.
    let ack = dispatcher.dispatch(intent(
        "layout.replaceGroups",
        "A",
        json!({
            "activeGroupId": "g1",
            "groups": [
                { "id": "g1", "name": "Main", "root": two_panel_tree(), "activePanelId": "a" },
                {
                    "id": "g2",
                    "name": "Second",
                    "root": leaf_node("z", &["t9"]),
                    "activePanelId": "z"
                }
            ]
        }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        store.snapshot_full("A")["groups"].as_array().unwrap().len(),
        2
    );

    // Move t3 (panel b of active g1) into g2 via the route.
    let ack = dispatcher.dispatch(intent(
        "layout.moveTabToGroup",
        "A",
        json!({ "tabId": "t3", "fromPanelId": "b", "targetGroupId": "g2" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let full = store.snapshot_full("A");
    let g2_root: PanelNode = serde_json::from_value(
        full["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["id"] == json!("g2"))
            .unwrap()["root"]
            .clone(),
    )
    .unwrap();
    assert!(
        termihub_core::layout::panel_tree::find_leaf_by_tab(&g2_root, "t3").is_some(),
        "t3 landed in g2 via the route"
    );
}

#[test]
fn close_group_route_rejects_the_last_group() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    let group_id = store.snapshot_full("A")["activeGroupId"]
        .as_str()
        .unwrap()
        .to_string();
    let ack = dispatcher.dispatch(intent(
        "layout.closeGroup",
        "A",
        json!({ "groupId": group_id }),
    ));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "last_group");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn set_active_tab_route_focuses_a_tab_and_converges() {
    let store = seeded_store("A");
    let (dispatcher, _region, sink, mut cache) = harness_for(store.clone());

    // Activate t3 — it lives in panel b, so focus should repoint to b.
    let ack = dispatcher.dispatch(intent("layout.setActiveTab", "A", json!({ "tabId": "t3" })));
    assert_eq!(ack.status, IntentStatus::Accepted);

    for diff in &sink.diffs() {
        cache.apply(diff);
    }
    assert_eq!(
        cache.view,
        store.snapshot_full("A"),
        "cache converges on authority"
    );

    let full = store.snapshot_full("A");
    let root: PanelNode = serde_json::from_value(full["groups"][0]["root"].clone()).unwrap();
    let b = termihub_core::layout::panel_tree::find_leaf(&root, "b").unwrap();
    assert_eq!(
        b.active_tab_id.as_deref(),
        Some("t3"),
        "tab focused via route"
    );
    assert_eq!(
        full["groups"][0]["activePanelId"],
        json!("b"),
        "active panel repointed via route"
    );
}

#[test]
fn set_active_tab_route_rejects_an_unknown_tab() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot_full("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent(
        "layout.setActiveTab",
        "A",
        json!({ "tabId": "ghost" }),
    ));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "tab_not_found");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

/// A leaf `PanelNode` value for JSON payload fixtures.
fn leaf_node(id: &str, tab_ids: &[&str]) -> PanelNode {
    PanelNode::Leaf(leaf(id, tab_ids))
}
