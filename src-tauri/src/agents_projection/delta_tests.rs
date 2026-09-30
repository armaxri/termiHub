//! Output-parity proof for the incremental `agents` publish (PERF-006, #2888).
//!
//! Every fold shape the store has is published through the production
//! [`publish_agents`] (hybrid reduced diff) and the emitted ops are asserted
//! **equal** to the whole-region diff `compute_ops(prev_full, new_full)` the old
//! path computed, and the subscriber cache — fed only those ops — is asserted to
//! converge on the store snapshot. The debug cross-check inside the publish runs
//! on every step as well (and panics under `cfg(test)` on any divergence).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::apply_agents_delta;
use crate::agents_projection::projection::{publish_agents, AGENTS_REGION};
use crate::agents_projection::store::{
    AgentConnectionState, AgentDefinition, AgentFolder, AgentSession, AgentsDelta, AgentsStore,
    SavedAgentSeed,
};
use crate::projection::{
    apply_ops, compute_ops, DiffOp, ProjectionError, ProjectionFrame, ProjectionSink, Projector,
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// Records the ops of every diff frame it receives.
#[derive(Default)]
struct OpsSink {
    diffs: Mutex<Vec<Vec<DiffOp>>>,
}

impl OpsSink {
    fn count(&self) -> usize {
        self.diffs.lock().unwrap().len()
    }

    fn last(&self) -> Vec<DiffOp> {
        self.diffs
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default()
    }
}

impl ProjectionSink for OpsSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        if let ProjectionFrame::Diff(diff) = frame {
            self.diffs.lock().unwrap().push(diff.ops.clone());
        }
        Ok(())
    }
}

/// A projector with the region seeded from `store` and one recording
/// subscriber, with the store's seed dirt already drained (a no-op publish).
struct Harness {
    projector: Projector,
    sink: Arc<OpsSink>,
    /// The whole-region view before the next fold (the old path's `prev`).
    prev: Value,
    /// A client cache fed only the emitted ops.
    client: Value,
}

impl Harness {
    fn new(store: &AgentsStore) -> Self {
        let projector = Projector::new();
        projector.register_region(AGENTS_REGION, store.snapshot());
        let sink = Arc::new(OpsSink::default());
        projector.subscribe(AGENTS_REGION, "sub", "A", sink.clone());
        assert!(
            publish_agents(&projector, store).is_empty(),
            "draining the seed dirt against an equal baseline is a no-op"
        );
        let prev = store.snapshot();
        Self {
            projector,
            sink,
            client: prev.clone(),
            prev,
        }
    }

    /// Publish `store` and assert the emitted diff is byte-identical to the
    /// whole-region diff from the previous view to the store's snapshot.
    fn check(&mut self, store: &AgentsStore, label: &str) {
        let before = self.sink.count();
        let new_full = store.snapshot();
        let expected = compute_ops(&self.prev, &new_full);

        let produced = publish_agents(&self.projector, store);

        if expected.is_empty() {
            assert!(
                produced.is_empty(),
                "{label}: no region advanced on a no-op"
            );
            assert_eq!(self.sink.count(), before, "{label}: no diff on a no-op");
        } else {
            assert_eq!(self.sink.count(), before + 1, "{label}: exactly one diff");
            assert_eq!(
                self.sink.last(),
                expected,
                "{label}: incremental ops must equal the whole-region diff"
            );
            apply_ops(&mut self.client, &self.sink.last()).expect("diff applies cleanly");
        }
        assert_eq!(self.client, new_full, "{label}: client converges");
        assert_eq!(
            self.projector.snapshot(AGENTS_REGION).view,
            new_full,
            "{label}: region view == store authority"
        );
        self.prev = new_full;
    }
}

fn definition(id: &str, folder: Option<&str>) -> AgentDefinition {
    AgentDefinition {
        id: id.to_string(),
        name: format!("def-{id}"),
        session_type: "shell".to_string(),
        config: json!({ "shell": "bash" }),
        persistent: false,
        folder_id: folder.map(str::to_string),
        terminal_options: None,
        icon: None,
        source_file: None,
    }
}

fn folder(id: &str) -> AgentFolder {
    AgentFolder {
        id: id.to_string(),
        name: format!("folder-{id}"),
        parent_id: None,
        is_expanded: true,
    }
}

fn session(id: &str) -> AgentSession {
    AgentSession {
        session_id: id.to_string(),
        title: format!("session {id}"),
        session_type: "shell".to_string(),
        status: "running".to_string(),
        attached: true,
        definition_id: None,
    }
}

fn seed(id: &str, host: &str) -> SavedAgentSeed {
    SavedAgentSeed {
        id: id.to_string(),
        name: format!("Agent {id}"),
        config: json!({ "host": host }),
        agent_settings: json!({}),
    }
}

/// A populated store: several agents, each with sessions, definitions and
/// folders, so a whole-region rebuild is O(N) and a single-agent fold must not
/// touch the rest.
fn populated_store() -> AgentsStore {
    let store = AgentsStore::new();
    for i in 0..5 {
        let id = format!("a{i}");
        store.add(&id, &format!("Agent {i}"), json!({ "host": i }), json!({}));
        store.refresh(
            &id,
            vec![session(&format!("{id}-s0")), session(&format!("{id}-s1"))],
            vec![definition(&format!("{id}-d0"), Some(&format!("{id}-f0")))],
            vec![folder(&format!("{id}-f0"))],
        );
    }
    store
}

// ── Per-fold-shape parity ────────────────────────────────────────────────────

/// Every list-level fold (the ordered `agents` array): add, per-field writes,
/// reorder in both directions, remove, and no-ops.
#[test]
fn list_folds_are_byte_identical_to_the_whole_region_diff() {
    let store = populated_store();
    let mut h = Harness::new(&store);

    store.add("a9", "Agent Nine", json!({ "host": 9 }), json!({ "x": 1 }));
    h.check(&store, "add");
    store.add("a9", "dup", Value::Null, Value::Null);
    h.check(&store, "add-duplicate-no-op");
    store.update("a2", "Renamed", json!({ "host": "new" }), json!({ "y": 2 }));
    h.check(&store, "update");
    store.apply_settings("a3", json!({ "autoConnect": true }));
    h.check(&store, "apply-settings");
    store.toggle_expanded("a1");
    h.check(&store, "toggle-expanded");
    store.set_status("a1", AgentConnectionState::Connected, None);
    h.check(&store, "status-connected");
    store.set_status(
        "a1",
        AgentConnectionState::Disconnected,
        Some("boom".into()),
    );
    h.check(&store, "status-disconnected-with-error");
    store.set_status("a1", AgentConnectionState::Disconnected, None);
    h.check(&store, "status-same-no-op");
    store.set_capabilities("a4", json!({ "sessionTypes": ["shell"] }));
    h.check(&store, "set-capabilities");
    store.reorder(0, 4);
    h.check(&store, "reorder-forward");
    store.reorder(5, 1);
    h.check(&store, "reorder-backward");
    store.reorder(2, 2);
    h.check(&store, "reorder-same-index-no-op");
    store.reorder(0, 99);
    h.check(&store, "reorder-out-of-range-no-op");
    store.set_status("nope", AgentConnectionState::Connected, None);
    h.check(&store, "unknown-id-no-op");
    store.remove("a0");
    h.check(&store, "remove");
    store.remove("a0");
    h.check(&store, "remove-idempotent-no-op");
}

/// Every keyed-map fold (sessions / definitions / folders), including the
/// cross-entry `delete_folder` reparent and the unknown-agent create (#2486).
#[test]
fn keyed_map_folds_are_byte_identical_to_the_whole_region_diff() {
    let store = populated_store();
    let mut h = Harness::new(&store);

    store.set_sessions("a1", vec![session("a1-s9")]);
    h.check(&store, "set-sessions");
    store.remove_session("a1", "a1-s9");
    h.check(&store, "remove-session");
    store.remove_session("a1", "missing");
    h.check(&store, "remove-session-no-op");
    store.clear_sessions("a2");
    h.check(&store, "clear-sessions");
    store.set_definitions(
        "a3",
        vec![definition("a3-d5", None), definition("a3-d6", None)],
    );
    h.check(&store, "set-definitions");
    store.set_folders("a3", vec![folder("a3-f1"), folder("a3-f2")]);
    h.check(&store, "set-folders");
    store.save_definition("a4", definition("a4-d1", Some("a4-f0")));
    h.check(&store, "save-definition");
    let mut edited = definition("a4-d1", None);
    edited.name = "edited".into();
    store.update_definition("a4", edited);
    h.check(&store, "update-definition");
    store.delete_definition("a4", "a4-d1");
    h.check(&store, "delete-definition");
    store.create_folder("a2", folder("a2-f7"));
    h.check(&store, "create-folder");
    let mut collapsed = folder("a2-f7");
    collapsed.is_expanded = false;
    store.update_folder("a2", collapsed);
    h.check(&store, "update-folder");
    // Cross-entry: removes the folder AND reparents a definition of the same agent.
    store.delete_folder("a0", "a0-f0");
    h.check(&store, "delete-folder-reparents");
    // #2486: a create for an agent whose entry does not exist yet adds a new map key.
    store.save_definition("ghost", definition("g-d0", None));
    h.check(&store, "save-definition-unknown-agent");
    store.create_folder("ghost", folder("g-f0"));
    h.check(&store, "create-folder-unknown-agent");
    store.refresh(
        "a1",
        vec![session("a1-s3")],
        vec![definition("a1-d3", None)],
        vec![folder("a1-f3")],
    );
    h.check(&store, "refresh");
    store.disconnect("a1");
    h.check(&store, "disconnect");
}

/// The whole-list folds: `reflect_saved_agents` (add + drop + reorder + refresh
/// persisted fields, dropping the removed agents' map entries, incl. the orphan
/// `ghost` key) and `replace`.
#[test]
fn whole_list_folds_are_byte_identical_to_the_whole_region_diff() {
    let store = populated_store();
    store.save_definition("ghost", definition("g-d0", None));
    let mut h = Harness::new(&store);

    store.reflect_saved_agents(vec![
        seed("a3", "h3"),
        seed("new", "hn"),
        seed("a1", "h1-changed"),
        seed("a0", "h0"),
    ]);
    h.check(&store, "reflect-add-drop-reorder");
    store.reflect_saved_agents(vec![
        seed("a3", "h3"),
        seed("new", "hn"),
        seed("a1", "h1-changed"),
        seed("a0", "h0"),
    ]);
    h.check(&store, "reflect-idempotent-no-op");

    let source = populated_store();
    source.remove("a2");
    source.add("z", "Zed", json!({}), json!({}));
    source.set_sessions("a4", vec![session("a4-only")]);
    let snap = source.snapshot();
    let parse = |key: &str| snap[key].clone();
    store.replace(
        serde_json::from_value(parse("agents")).unwrap(),
        serde_json::from_value(parse("sessions")).unwrap(),
        serde_json::from_value(parse("definitions")).unwrap(),
        serde_json::from_value(parse("folders")).unwrap(),
    );
    h.check(&store, "replace");
    assert_eq!(
        h.prev,
        source.snapshot(),
        "region mirrors the replace source"
    );

    store.replace(Vec::new(), HashMap::new(), HashMap::new(), HashMap::new());
    h.check(&store, "replace-with-empty");
}

/// Several folds of both kinds coalesced into one publish: one diff, still
/// byte-identical (exercises the sorted top-level concatenation
/// `agents` < `definitions` < `folders` < `sessions` within one reduced diff).
#[test]
fn coalesced_list_and_map_folds_are_byte_identical() {
    let store = populated_store();
    let mut h = Harness::new(&store);

    store.reorder(4, 0);
    store.set_status("a2", AgentConnectionState::Connecting, None);
    store.save_definition("a1", definition("a1-dx", None));
    store.create_folder("a3", folder("a3-fx"));
    store.remove_session("a0", "a0-s0");
    store.remove("a4");
    store.add("b", "Bee", json!({}), json!({}));
    h.check(&store, "coalesced");
}

/// A long deterministic pseudo-random fold sequence over every store operation:
/// the first half publishes after every fold, the second half after a random
/// number of coalesced folds.
#[test]
fn pseudo_random_fold_sequences_are_byte_identical() {
    let store = populated_store();
    let mut h = Harness::new(&store);
    let mut rng: u64 = 0x2888_5EED;
    let mut next = |n: u64| {
        rng = rng
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (rng >> 33) % n
    };

    for step in 0..600 {
        let id = format!("a{}", next(7));
        let item = format!("x{}", next(4));
        match next(22) {
            0 => store.add(&id, "added", json!({ "n": step }), json!({})),
            1 => store.update(&id, "upd", json!({ "n": step }), json!({ "s": step })),
            2 => store.apply_settings(&id, json!({ "s": step })),
            3 => store.remove(&id),
            4 => store.reorder(next(8) as usize, next(8) as usize),
            5 => store.toggle_expanded(&id),
            6 => store.set_status(&id, AgentConnectionState::Connected, None),
            7 => store.set_status(&id, AgentConnectionState::Disconnected, Some("e".into())),
            8 => store.set_capabilities(&id, json!({ "v": step })),
            9 => store.disconnect(&id),
            10 => store.refresh(
                &id,
                vec![session(&item)],
                vec![definition(&item, Some("x0"))],
                vec![folder("x0")],
            ),
            11 => store.clear_sessions(&id),
            12 => store.set_sessions(&id, vec![session(&item), session("s-extra")]),
            13 => store.remove_session(&id, &item),
            14 => store.set_definitions(&id, vec![definition(&item, None)]),
            15 => store.set_folders(&id, vec![folder(&item)]),
            16 => store.save_definition(&id, definition(&item, Some("x1"))),
            17 => store.update_definition(&id, definition(&item, None)),
            18 => store.delete_definition(&id, &item),
            19 => store.create_folder(&id, folder(&item)),
            20 => store.delete_folder(&id, &item),
            _ => store.reflect_saved_agents(
                (0..next(6))
                    .map(|i| seed(&format!("a{}", (i + next(3)) % 7), "h"))
                    .fold(Vec::<SavedAgentSeed>::new(), |mut acc, s| {
                        if !acc.iter().any(|x| x.id == s.id) {
                            acc.push(s);
                        }
                        acc
                    }),
            ),
        }
        if step < 300 || next(3) == 0 {
            h.check(&store, &format!("random-step-{step}"));
        }
    }
    h.check(&store, "random-final");
}

// ── The cross-check itself ───────────────────────────────────────────────────

/// A deliberately incomplete delta (a dirty-tracking bug: the list changed but
/// the delta does not say so) is caught by the cross-check, which resyncs the
/// view to the truth and emits the whole-region diff instead.
#[test]
fn an_incomplete_delta_is_detected_and_resynced() {
    let store = populated_store();
    let mut view = store.snapshot();
    let old = view.clone();
    let _ = store.drain_delta();

    store.set_status("a1", AgentConnectionState::Connected, None);
    let truth = store.snapshot();
    let bogus = AgentsDelta::default();

    let (ops, divergence) = apply_agents_delta(&mut view, &bogus, Some(&truth), || unreachable!());
    assert!(divergence.is_some(), "the missed list change is reported");
    assert_eq!(view, truth, "the view is resynced to the truth");
    assert_eq!(
        ops,
        compute_ops(&old, &truth),
        "the whole-region diff is emitted"
    );
}

/// An unseeded region view (never registered) falls back to the whole-region
/// path byte-for-byte.
#[test]
fn an_unseeded_view_falls_back_to_the_whole_region_diff() {
    let store = populated_store();
    let delta = store.drain_delta();
    let mut view = Value::Null;
    let (ops, divergence) = apply_agents_delta(&mut view, &delta, None, || store.snapshot());
    assert!(divergence.is_none());
    assert_eq!(view, store.snapshot());
    assert_eq!(ops, compute_ops(&Value::Null, &store.snapshot()));
}

/// A single-agent map fold drains only that agent's entries and leaves the list
/// out — the O(change) property the migration exists for.
#[test]
fn a_single_agent_map_fold_drains_only_that_agent() {
    let store = populated_store();
    let _ = store.drain_delta();

    store.save_definition("a2", definition("a2-new", None));
    let delta = store.drain_delta();
    assert!(
        delta.agents.is_none(),
        "the ordered list is not re-serialized"
    );
    let ids: Vec<&str> = delta.definitions.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(ids, vec!["a2"]);

    store.set_status("a2", AgentConnectionState::Connected, None);
    let delta = store.drain_delta();
    assert!(
        delta.agents.is_some(),
        "a list field write carries the list"
    );
    assert!(delta.definitions.is_empty(), "and no map entries");
}

// ── Concurrency (the #3788 / #3780 pattern) ──────────────────────────────────

/// Several threads each fold and then publish — as the intent dispatcher and the
/// server-side `fold_agent_transition` callers do. With no final flush publish,
/// the subscriber (fed only diffs) and the region must end equal to the store,
/// and the debug cross-check (armed under `cfg(test)`) must never fire: the
/// delta is drained under the region lock, so drains apply in lock order.
#[test]
fn concurrent_folds_and_publishes_converge_on_the_store() {
    use std::sync::Barrier;
    use std::thread;

    const THREADS: usize = 6;
    const ITERS: usize = 300;
    let store = Arc::new(populated_store());
    let projector = Arc::new(Projector::new());
    projector.register_region(AGENTS_REGION, store.snapshot());
    let sink = Arc::new(OpsSink::default());
    let base = projector.subscribe(AGENTS_REGION, "sub", "A", sink.clone());

    let barrier = Arc::new(Barrier::new(THREADS));
    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            let store = store.clone();
            let projector = projector.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                for i in 0..ITERS {
                    let id = format!("a{}", (t + i) % 5);
                    let item = format!("x{}", i % 3);
                    match (t + i) % 6 {
                        0 => store.set_status(&id, AgentConnectionState::Connected, None),
                        1 => store.save_definition(&id, definition(&item, None)),
                        2 => store.create_folder(&id, folder(&item)),
                        3 => store.reorder(i % 5, (i + t) % 5),
                        4 => store.delete_folder(&id, &item),
                        _ => store.set_sessions(&id, vec![session(&item)]),
                    }
                    publish_agents(&projector, &store);
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("worker thread");
    }

    let mut client = base.view.clone();
    for ops in sink.diffs.lock().unwrap().iter() {
        apply_ops(&mut client, ops).expect("diff applies cleanly");
    }
    assert_eq!(
        client,
        store.snapshot(),
        "subscriber converges on the store"
    );
    assert_eq!(
        projector.snapshot(AGENTS_REGION).view,
        store.snapshot(),
        "region converges on the store"
    );
}
