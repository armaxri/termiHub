//! Projection-contract tests for the shared `agents` region (#2226), reusing the
//! substrate harness (#2164): an in-memory [`ProjectionSink`] and a client cache
//! that applies diffs. The routes here drive a real [`AgentsStore`] directly (the
//! production `register_agent_intents` resolves the same store from the Tauri
//! `AppHandle`; that thin wiring is integration-verified via a local
//! `./scripts/dev.sh` run) through the identical parse → mutate → publish path.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with monotonic
//! versions, rejection paths advance nothing, a no-op intent advances nothing, a
//! dead subscriber is reaped, and the client cache converges on the store's
//! authority across a full agent lifecycle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::Manager;

use crate::agents_projection::projection::{fold_agent_transition, publish_agents, AGENTS_REGION};
use crate::agents_projection::store::{
    AgentConnectionState, AgentDefinition, AgentFolder, AgentSession, AgentsStore, SavedAgentSeed,
};
use crate::commands::projection::ProjectionState;
use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, ProjectionError,
    ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// A store with a couple of agents already configured, so a subscriber sees a
/// populated baseline.
fn seeded_store() -> Arc<AgentsStore> {
    let store = Arc::new(AgentsStore::new());
    store.add("a1", "Agent One", json!({ "host": "h1" }), json!({}));
    store.add("a2", "Agent Two", json!({ "host": "h2" }), json!({}));
    store.set_status(
        "a2",
        crate::agents_projection::store::AgentConnectionState::Connected,
        None,
    );
    store
}

/// The production `agent.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_agent_intents` runs. Each closure mirrors the production route so
/// the test drives real logic, not a stand-in.
fn registry_for(store: Arc<AgentsStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("agent.add", move |intent, projector| {
        s.add(
            &required_str(intent, "id")?,
            &required_str(intent, "name")?,
            intent.payload.get("config").cloned().unwrap_or(Value::Null),
            intent
                .payload
                .get("agentSettings")
                .cloned()
                .unwrap_or(Value::Null),
        );
        Ok(publish_agents(projector, &s))
    });
    let s = store.clone();
    registry.route("agent.status", move |intent, projector| {
        let state = serde_json::from_value(
            intent
                .payload
                .get("state")
                .cloned()
                .ok_or_else(|| ("bad_payload".to_string(), "missing 'state'".to_string()))?,
        )
        .map_err(|e| ("bad_payload".to_string(), format!("invalid state: {e}")))?;
        s.set_status(
            &required_str(intent, "id")?,
            state,
            intent
                .payload
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
        Ok(publish_agents(projector, &s))
    });
    let s = store.clone();
    registry.route("agent.refresh", move |intent, projector| {
        let sessions: Vec<AgentSession> = parse_list(intent, "sessions")?;
        let definitions: Vec<AgentDefinition> = parse_list(intent, "definitions")?;
        let folders: Vec<AgentFolder> = parse_list(intent, "folders")?;
        s.refresh(&required_str(intent, "id")?, sessions, definitions, folders);
        Ok(publish_agents(projector, &s))
    });
    let s = store.clone();
    registry.route("agent.disconnect", move |intent, projector| {
        s.disconnect(&required_str(intent, "id")?);
        Ok(publish_agents(projector, &s))
    });
    let s = store.clone();
    registry.route("agent.remove", move |intent, projector| {
        s.remove(&required_str(intent, "id")?);
        Ok(publish_agents(projector, &s))
    });
    let s = store;
    registry.route("agent.replace", move |intent, projector| {
        let agents =
            serde_json::from_value(intent.payload.get("agents").cloned().unwrap_or(json!([])))
                .map_err(|e| ("bad_payload".to_string(), format!("invalid agents: {e}")))?;
        let sessions =
            serde_json::from_value(intent.payload.get("sessions").cloned().unwrap_or(json!({})))
                .map_err(|e| ("bad_payload".to_string(), format!("invalid sessions: {e}")))?;
        let definitions = serde_json::from_value(
            intent
                .payload
                .get("definitions")
                .cloned()
                .unwrap_or(json!({})),
        )
        .map_err(|e| {
            (
                "bad_payload".to_string(),
                format!("invalid definitions: {e}"),
            )
        })?;
        let folders =
            serde_json::from_value(intent.payload.get("folders").cloned().unwrap_or(json!({})))
                .map_err(|e| ("bad_payload".to_string(), format!("invalid folders: {e}")))?;
        s.replace(agents, sessions, definitions, folders);
        Ok(publish_agents(projector, &s))
    });

    registry
}

/// The route-side `id` parse — the one rejection path shared by every route.
fn required_str(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

fn parse_list<T: serde::de::DeserializeOwned>(
    intent: &Intent,
    key: &str,
) -> Result<Vec<T>, (String, String)> {
    let value = intent
        .payload
        .get(key)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))?;
    serde_json::from_value(value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid {key}: {e}")))
}

/// An in-memory sink recording delivered frames; can be killed to simulate a
/// dead subscriber (mirrors the substrate/tunnel/session test double).
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

fn intent(kind: &str, payload: Value) -> Intent {
    Intent {
        intent_id: format!("01J-{kind}"),
        kind: kind.to_string(),
        payload,
        client_id: "client-1".to_string(),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn subscribe_returns_the_seeded_snapshot_identically_to_every_subscriber() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(AGENTS_REGION, store.snapshot());

    let snap_a = projector.subscribe(AGENTS_REGION, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(AGENTS_REGION, "sub-b", "B", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "agents");
    assert_eq!(snap_a.view["agents"][0]["id"], json!("a1"));
    assert_eq!(
        snap_a.view["agents"][0]["connectionState"],
        json!("disconnected")
    );
    assert_eq!(
        snap_a.view["agents"][1]["connectionState"],
        json!("connected")
    );
}

#[test]
fn an_agent_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(AGENTS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(AGENTS_REGION, "sub-a", "A", sink_a.clone());
    projector.subscribe(AGENTS_REGION, "sub-b", "B", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "agent.status",
        json!({ "id": "a1", "state": "connecting" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![crate::projection::ProducedRegion {
            region: AGENTS_REGION.to_string(),
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
        store.snapshot(),
        "cache converges on authority"
    );
    assert_eq!(
        cache_a.view["agents"][0]["connectionState"],
        json!("connecting")
    );
}

#[test]
fn a_full_agent_lifecycle_advances_monotonically_and_converges() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(AGENTS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(AGENTS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // a3: add → connecting → connected → refresh (sessions/defs/folders) →
    // disconnect → remove. Each accepted intent that changes the view = one diff.
    for kind_payload in [
        (
            "agent.add",
            json!({ "id": "a3", "name": "Three", "config": { "host": "h3" }, "agentSettings": {} }),
        ),
        ("agent.status", json!({ "id": "a3", "state": "connecting" })),
        ("agent.status", json!({ "id": "a3", "state": "connected" })),
        (
            "agent.refresh",
            json!({
                "id": "a3",
                "sessions": [{ "sessionId": "s1", "title": "t", "type": "shell", "status": "running", "attached": true }],
                "definitions": [{ "id": "d1", "name": "def", "sessionType": "shell", "config": {}, "persistent": false, "folderId": null }],
                "folders": [{ "id": "f1", "name": "F", "parentId": null, "isExpanded": true }]
            }),
        ),
        ("agent.disconnect", json!({ "id": "a3" })),
        ("agent.remove", json!({ "id": "a3" })),
    ] {
        let ack = dispatcher.dispatch(intent(kind_payload.0, kind_payload.1));
        assert_eq!(
            ack.status,
            IntentStatus::Accepted,
            "{} accepted",
            kind_payload.0
        );
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 6, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 6);
    assert_eq!(cache.view, store.snapshot(), "cache converges on authority");
    // a3 is gone again; the seeded agents remain.
    let ids: Vec<&str> = cache.view["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["a1", "a2"]);
}

#[test]
fn an_intent_missing_the_id_is_rejected_without_advancing() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(AGENTS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(AGENTS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent("agent.status", json!({ "state": "connected" })));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(AGENTS_REGION), Some(0));
}

#[test]
fn a_no_op_intent_advances_nothing() {
    // `status → connected` on an already-connected agent leaves the view
    // unchanged, so the projector coalesces it to no diff and no version bump.
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(AGENTS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(AGENTS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent(
        "agent.status",
        json!({ "id": "a2", "state": "connected" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(AGENTS_REGION), Some(0));
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(AGENTS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(AGENTS_REGION, "live", "A", live.clone());
    projector.subscribe(AGENTS_REGION, "dead", "B", dead.clone());
    assert_eq!(projector.subscriber_count(AGENTS_REGION), 2);

    dead.alive.store(false, Ordering::SeqCst);
    dispatcher.dispatch(intent(
        "agent.status",
        json!({ "id": "a1", "state": "connecting" }),
    ));

    assert_eq!(
        live.diffs().len(),
        1,
        "the live subscriber still gets the diff"
    );
    assert_eq!(
        projector.subscriber_count(AGENTS_REGION),
        1,
        "the dead subscriber was reaped"
    );
}

#[test]
fn replace_mirrors_a_whole_snapshot_in_one_diff_and_converges() {
    // The render-cut mirror (#2226): an `agent.replace` carrying `appStore`'s
    // whole agents slice converges the region on it in a single coalesced diff.
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(AGENTS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(AGENTS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "agent.replace",
        json!({
            "agents": [{
                "id": "a1",
                "name": "Only",
                "config": { "host": "h1" },
                "agentSettings": {},
                "isExpanded": true,
                "connectionState": "connected"
            }],
            "sessions": { "a1": [{ "sessionId": "s1", "title": "t", "type": "shell", "status": "running", "attached": true }] },
            "definitions": { "a1": [{ "id": "d1", "name": "def", "sessionType": "shell", "config": {}, "persistent": false, "folderId": null }] },
            "folders": { "a1": [{ "id": "f1", "name": "F", "parentId": null, "isExpanded": true }] }
        }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one coalesced diff for the whole replace");
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view,
        store.snapshot(),
        "cache converges on the mirror"
    );
    assert_eq!(cache.view["agents"].as_array().unwrap().len(), 1);
    assert_eq!(cache.view["agents"][0]["name"], json!("Only"));
    assert!(store.get("a2").is_none(), "replace dropped the prior agent");
}

// ── Server-authority fold (#2388, prerequisite for #2226) ─────────────────────
//
// These drive the *production* `fold_agent_transition` end to end against a
// `tauri::test::mock_app()` with the same managed state `lib.rs::setup()` wires:
// an `Arc<AgentsStore>` and a `ProjectionState`. They prove the store is fed
// **server-side** — the instant the agent manager emits a state change or an
// agent-RPC command returns a CRUD outcome — with no `agent.*` client dispatch,
// and that the fold reproduces the client route's store transition exactly
// (parity) and stays idempotent alongside the still-present client mirror.

/// A definition RPC record → the store shape it folds into.
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

/// A live connection-status transition folded server-side (the `agent-state-change`
/// emission point) updates the shared store and fans the `agents` region diff out
/// — without any client `agent.status` dispatch.
#[test]
fn server_side_status_fold_updates_store_and_region_without_client_dispatch() {
    let app = tauri::test::mock_app();

    // The agent entry is created client-side (it carries the UI config/settings the
    // backend does not receive); the server folds the live status into it.
    let store = Arc::new(AgentsStore::new());
    store.add("a1", "One", json!({ "host": "h1" }), json!({}));
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(AGENTS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(AGENTS_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    // Server folds the transition at the source — no `agent.status` intent runs.
    fold_agent_transition(app.handle(), |s| {
        s.set_status("a1", AgentConnectionState::Connected, None)
    });

    // The store is authoritative server-side.
    assert_eq!(
        store.get("a1").map(|a| a.connection_state),
        Some(AgentConnectionState::Connected)
    );

    // Exactly one region diff fanned out; the client cache converges with no round-trip.
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side fold");
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view["agents"][0]["connectionState"],
        json!("connected")
    );
}

/// The server-side status fold reproduces the client `agent.status` route's store
/// transition exactly — identical snapshots, so the (additive) client mirror and
/// the fold never drift and `set_status` is idempotent across both.
#[test]
fn server_side_status_fold_matches_the_client_agent_status_route() {
    // (a) Server-side fold: the store method the fold applies at the source.
    let server = seeded_store();
    server.set_status(
        "a1",
        AgentConnectionState::Reconnecting,
        Some("boom".into()),
    );

    // (b) Client route: the `agent.status` intent through the production registry.
    let client = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(AGENTS_REGION, client.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(client.clone())));
    let ack = dispatcher.dispatch(intent(
        "agent.status",
        json!({ "id": "a1", "state": "reconnecting", "error": "boom" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    assert_eq!(
        server.snapshot(),
        client.snapshot(),
        "the server fold reproduces the client route's transition exactly"
    );
}

/// A definition CRUD outcome folded server-side upserts into the shared store and
/// publishes the region diff, and re-folding the identical outcome is a no-op (no
/// double count when the additive client `agent.saveDefinition` mirror also runs).
#[test]
fn server_side_definition_fold_upserts_and_is_idempotent() {
    let app = tauri::test::mock_app();
    let store = Arc::new(AgentsStore::new());
    store.add("a1", "One", json!({ "host": "h1" }), json!({}));
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(AGENTS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(AGENTS_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    // Server folds a `save_agent_definition` outcome at the source.
    fold_agent_transition(app.handle(), |s| {
        s.save_definition("a1", definition("d1", None))
    });
    // The (still-present) client `agent.saveDefinition` mirror folds the same id.
    fold_agent_transition(app.handle(), |s| {
        s.save_definition("a1", definition("d1", None))
    });

    assert_eq!(
        store.definitions_of("a1").len(),
        1,
        "upsert — no double count across the fold and the client mirror"
    );
    // One diff (the first fold); the identical second fold advances nothing.
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "the idempotent re-fold produced no diff");
    cache.apply(&diffs[0]);
    assert_eq!(cache.view["definitions"]["a1"][0]["id"], json!("d1"));
}

/// A `create_agent_folder` outcome folded server-side adds the folder and — because
/// `create_folder` upserts by id — running the identical fold again (the additive
/// client `agent.createFolder` mirror) neither duplicates the folder nor emits a
/// second diff.
#[test]
fn server_side_create_folder_fold_converges_without_duplicate() {
    let app = tauri::test::mock_app();
    let store = Arc::new(AgentsStore::new());
    store.add("a1", "One", json!({ "host": "h1" }), json!({}));
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(AGENTS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projection
        .projector
        .subscribe(AGENTS_REGION, "sub", "C", sink.clone());
    app.manage(projection);

    fold_agent_transition(app.handle(), |s| s.create_folder("a1", folder("f1")));
    fold_agent_transition(app.handle(), |s| s.create_folder("a1", folder("f1")));

    assert_eq!(
        store.folders_of("a1").len(),
        1,
        "the folder is not duplicated"
    );
    assert_eq!(
        sink.diffs().len(),
        1,
        "only the first fold advanced the region"
    );
}

/// A `close_agent_session` outcome folded server-side drops the session from the
/// shared store and publishes the region diff.
#[test]
fn server_side_close_session_fold_drops_the_session() {
    let app = tauri::test::mock_app();
    let store = Arc::new(AgentsStore::new());
    store.add("a1", "One", json!({ "host": "h1" }), json!({}));
    store.set_sessions("a1", vec![session("s1"), session("s2")]);
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(AGENTS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projection
        .projector
        .subscribe(AGENTS_REGION, "sub", "C", sink.clone());
    app.manage(projection);

    fold_agent_transition(app.handle(), |s| s.remove_session("a1", "s1"));

    let remaining: Vec<String> = store.snapshot()["sessions"]["a1"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["sessionId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(remaining, vec!["s2".to_string()]);
    assert_eq!(sink.diffs().len(), 1);
}

/// The fold is a best-effort no-op when no store / projection state is managed
/// (e.g. a headless harness that never ran `setup()`) — it must not panic.
#[test]
fn server_side_fold_is_a_noop_without_managed_state() {
    let app = tauri::test::mock_app();
    // Nothing managed — reaching the assert without panicking is the contract.
    fold_agent_transition(app.handle(), |s| {
        s.set_status("a1", AgentConnectionState::Connected, None)
    });
}

// ── Server-owned list-membership fold (#2403, prerequisite for #2226) ──────────
//
// These drive `reflect_saved_agents` through the production `fold_agent_transition`
// end to end against a `mock_app()` — the exact store+publish path
// `fold_agents_from_manager` / `seed_agents_from_manager` run once they have read
// the `ConnectionManager` agent list. They prove the region carries full
// list-membership fed from the backend (entry creation for an unknown id, a whole
// list load, and a boot/reload reflecting the persisted list) **without any client
// `agent.add` dispatch**. The thin manager-reading wiring is integration-verified
// via a local `./scripts/dev.sh` run (same as the #2388 folds).

/// A persisted-list seed carrying only the backend-owned fields.
fn seed(id: &str, name: &str, host: &str) -> SavedAgentSeed {
    SavedAgentSeed {
        id: id.to_string(),
        name: name.to_string(),
        config: json!({ "host": host }),
        agent_settings: json!({}),
    }
}

/// A list-load fold creates the whole persisted agent list in the region — with no
/// client `agent.add` — and fans one diff out to every subscriber.
#[test]
fn server_side_list_load_fold_creates_membership_without_client_dispatch() {
    let app = tauri::test::mock_app();
    // The store starts empty — the analog of a boot before any client seed.
    let store = Arc::new(AgentsStore::new());
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(AGENTS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(AGENTS_REGION, "sub", "C", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    // Server folds the persisted agent list at the source — no `agent.add` runs.
    fold_agent_transition(app.handle(), |s| {
        s.reflect_saved_agents(vec![seed("a1", "One", "h1"), seed("a2", "Two", "h2")])
    });

    // The store is authoritative for list-membership server-side.
    assert_eq!(store.agent_ids(), vec!["a1", "a2"]);

    // Exactly one region diff; the client cache converges with no round-trip.
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side list load");
    cache.apply(&diffs[0]);
    assert_eq!(cache.view["agents"][0]["id"], json!("a1"));
    assert_eq!(cache.view["agents"][1]["id"], json!("a2"));
    assert_eq!(
        cache.view["agents"][0]["connectionState"],
        json!("disconnected")
    );
}

/// An entry-creation fold for an id **not** already in the store creates it — the
/// gap #2388's per-field folds (all no-ops for an unknown id) left open.
#[test]
fn server_side_fold_creates_an_unknown_agent_entry() {
    let app = tauri::test::mock_app();
    let store = Arc::new(AgentsStore::new());
    store.add("a1", "One", json!({ "host": "h1" }), json!({}));
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(AGENTS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projection
        .projector
        .subscribe(AGENTS_REGION, "sub", "C", sink.clone());
    app.manage(projection);

    // A newly-added agent's identity enters the region via the persisted list —
    // the a2 id was never dispatched client-side.
    fold_agent_transition(app.handle(), |s| {
        s.reflect_saved_agents(vec![seed("a1", "One", "h1"), seed("a2", "Two", "h2")])
    });

    assert_eq!(store.agent_ids(), vec!["a1", "a2"]);
    assert_eq!(sink.diffs().len(), 1, "the new entry advanced the region");
}

/// The boot/reload fold reflects the persisted list while **preserving** the live
/// status the store owns for a surviving agent (a reload must not reset an
/// in-flight connection).
#[test]
fn server_side_list_fold_preserves_live_status_on_reload() {
    let app = tauri::test::mock_app();
    let store = Arc::new(AgentsStore::new());
    store.add("a1", "One", json!({ "host": "h1" }), json!({}));
    store.set_status("a1", AgentConnectionState::Connected, None);
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(AGENTS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    projection
        .projector
        .subscribe(AGENTS_REGION, "sub", "C", sink.clone());
    app.manage(projection);

    // A reload reflects the persisted list; a1 survives (renamed) + a2 is added.
    fold_agent_transition(app.handle(), |s| {
        s.reflect_saved_agents(vec![
            seed("a1", "One Renamed", "h1"),
            seed("a2", "Two", "h2"),
        ])
    });

    let a1 = store.get("a1").expect("a1 survives the reload");
    assert_eq!(a1.name, "One Renamed");
    assert_eq!(
        a1.connection_state,
        AgentConnectionState::Connected,
        "the reload preserves the in-flight connection state"
    );
    assert_eq!(store.agent_ids(), vec!["a1", "a2"]);
}
