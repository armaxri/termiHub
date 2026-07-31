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

use crate::agents_projection::projection::{publish_agents, AGENTS_REGION};
use crate::agents_projection::store::{AgentDefinition, AgentFolder, AgentSession, AgentsStore};
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
