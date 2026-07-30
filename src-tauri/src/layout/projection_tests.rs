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
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, Projector,
    ProjectionError, ProjectionFrame, ProjectionSink, SnapshotFrame,
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
        let panel_id = required_str(intent, "panelId")?;
        let direction: Direction = required_enum(intent, "direction")?;
        let position: Position = required_enum(intent, "position")?;
        s.split(&intent.client_id, &panel_id, direction, position)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.merge", move |intent, projector| {
        let source = required_str(intent, "sourcePanelId")?;
        let target = required_str(intent, "targetPanelId")?;
        s.merge(&intent.client_id, &source, &target)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("layout.moveTab", move |intent, projector| {
        let tab_id = required_str(intent, "tabId")?;
        let target = required_str(intent, "targetPanelId")?;
        let edge: DropEdge = required_enum(intent, "edge")?;
        s.move_tab(&intent.client_id, &tab_id, &target, edge)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &s, &intent.client_id))
    });

    let s = store;
    registry.route("layout.closeTabStructure", move |intent, projector| {
        let tab_id = required_str(intent, "tabId")?;
        s.close_tab_structure(&intent.client_id, &tab_id)
            .map_err(to_ack_err)?;
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
    projector.register_region(&region, store.snapshot("A"));

    let snap_a = projector.subscribe(&region, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(&region, "sub-b", "A", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "layout@A");
    // The view model is the panel tree + focused panel.
    assert_eq!(snap_a.view["activePanelId"], json!("a"));
    assert_eq!(snap_a.view["root"]["type"], json!("split"));
}

#[test]
fn split_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
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
    assert_eq!(cache_a.view, store.snapshot("A"), "cache converges on authority");
}

#[test]
fn move_and_close_intents_advance_the_region_monotonically() {
    let store = seeded_store("A");
    let region = layout_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
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
    assert_eq!(cache.view, store.snapshot("A"), "cache converges on authority");
}

#[test]
fn intents_are_client_scoped_across_regions() {
    // One store seeded for two clients; each client subscribes to its own region.
    let store = Arc::new(LayoutStore::new());
    store.seed_for_test("A", two_panel_tree(), Some("a".to_string()));
    store.seed_for_test("B", two_panel_tree(), Some("a".to_string()));

    let projector = Arc::new(Projector::new());
    projector.register_region(&layout_region("A"), store.snapshot("A"));
    projector.register_region(&layout_region("B"), store.snapshot("B"));
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
    projector.register_region(&region, store.snapshot("A"));
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
    projector.register_region(&region, store.snapshot("A"));
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
