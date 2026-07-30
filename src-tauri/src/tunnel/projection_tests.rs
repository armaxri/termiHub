//! Tests for the SSH-tunnels projection pilot (#2150).
//!
//! Two layers:
//!
//! * [`tunnel_view_from`] — the pure view-model builder that production
//!   ([`build_tunnel_view`]) and every intent handler emit through — asserted
//!   directly for shape and keying.
//! * The projection contract for the tunnels domain — subscribe → snapshot,
//!   intent → single coalesced diff fanned to every subscriber, version
//!   monotonicity, config create/remove — driven through the real [`Projector`]
//!   and [`HandlerRegistry`]/[`Dispatcher`], against the real tunnel view shape.
//!   Reuses the Phase-1 substrate patterns (an in-memory sink + client cache);
//!   the real [`TunnelManager`]/`AppHandle` wiring is thin and integration-
//!   verified via a local `./scripts/dev.sh` run.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::*;
use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, IntentStatus, ProjectionError, ProjectionFrame,
    ProjectionSink, SnapshotFrame,
};
use crate::tunnel::config::{
    DynamicForwardConfig, LocalForwardConfig, TunnelConfig, TunnelState, TunnelStats, TunnelStatus,
    TunnelType,
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

fn local_tunnel(id: &str, name: &str) -> TunnelConfig {
    TunnelConfig {
        id: id.to_string(),
        name: name.to_string(),
        ssh_connection_id: "conn-1".to_string(),
        tunnel_type: TunnelType::Local(LocalForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: 5432,
            remote_host: "db.internal".to_string(),
            remote_port: 5432,
        }),
        host: crate::run_location::RunLocation::ThisComputer,
        auto_start: false,
        reconnect_on_disconnect: false,
    }
}

fn dynamic_tunnel(id: &str, name: &str) -> TunnelConfig {
    TunnelConfig {
        id: id.to_string(),
        name: name.to_string(),
        ssh_connection_id: "conn-1".to_string(),
        tunnel_type: TunnelType::Dynamic(DynamicForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: 1080,
        }),
        host: crate::run_location::RunLocation::ThisComputer,
        auto_start: false,
        reconnect_on_disconnect: false,
    }
}

fn state(id: &str, status: TunnelStatus) -> TunnelState {
    TunnelState {
        tunnel_id: id.to_string(),
        status,
        error: None,
        stats: TunnelStats::default(),
    }
}

// ── The pure view builder ────────────────────────────────────────────────────

#[test]
fn view_has_config_list_and_states_keyed_by_id() {
    let view = tunnel_view_from(
        vec![local_tunnel("t1", "db"), dynamic_tunnel("t2", "socks")],
        vec![
            state("t1", TunnelStatus::Connected),
            state("t2", TunnelStatus::Disconnected),
        ],
    );

    // Config list preserves order and the camelCase serde shape.
    assert_eq!(view["tunnels"].as_array().unwrap().len(), 2);
    assert_eq!(view["tunnels"][0]["id"], json!("t1"));
    assert_eq!(view["tunnels"][0]["sshConnectionId"], json!("conn-1"));
    assert_eq!(view["tunnels"][1]["tunnelType"]["type"], json!("dynamic"));

    // States are an object keyed by tunnel id (mirrors the frontend slice).
    assert_eq!(view["states"]["t1"]["status"], json!("connected"));
    assert_eq!(view["states"]["t2"]["status"], json!("disconnected"));
    assert_eq!(view["states"]["t1"]["tunnelId"], json!("t1"));
}

#[test]
fn view_error_field_rides_along_when_set() {
    let mut errored = state("t1", TunnelStatus::Error);
    errored.error = Some("connection refused".to_string());
    let view = tunnel_view_from(vec![local_tunnel("t1", "db")], vec![errored]);
    assert_eq!(view["states"]["t1"]["status"], json!("error"));
    assert_eq!(view["states"]["t1"]["error"], json!("connection refused"));
}

#[test]
fn empty_domain_is_an_empty_list_and_empty_map() {
    let view = tunnel_view_from(Vec::new(), Vec::new());
    assert_eq!(view["tunnels"], json!([]));
    assert_eq!(view["states"], json!({}));
}

// ── Substrate contract for the tunnels domain ────────────────────────────────

/// In-memory authoritative tunnel model, standing in for the real
/// [`TunnelManager`] so the projection contract can be exercised without a Tauri
/// `AppHandle`. Publishes exactly the production view shape via
/// [`tunnel_view_from`].
struct FakeTunnels {
    configs: Mutex<Vec<TunnelConfig>>,
    states: Mutex<Vec<TunnelState>>,
}

impl FakeTunnels {
    fn new() -> Self {
        Self {
            configs: Mutex::new(Vec::new()),
            states: Mutex::new(Vec::new()),
        }
    }

    fn view(&self) -> Value {
        tunnel_view_from(
            self.configs.lock().unwrap().clone(),
            self.states.lock().unwrap().clone(),
        )
    }

    fn upsert(&self, config: TunnelConfig) {
        let mut configs = self.configs.lock().unwrap();
        if let Some(existing) = configs.iter_mut().find(|c| c.id == config.id) {
            *existing = config;
        } else {
            let mut states = self.states.lock().unwrap();
            states.push(state(&config.id, TunnelStatus::Disconnected));
            configs.push(config);
        }
    }

    fn remove(&self, id: &str) {
        self.configs.lock().unwrap().retain(|c| c.id != id);
        self.states.lock().unwrap().retain(|s| s.tunnel_id != id);
    }

    fn set_status(&self, id: &str, status: TunnelStatus) {
        for s in self.states.lock().unwrap().iter_mut() {
            if s.tunnel_id == id {
                s.status = status.clone();
            }
        }
    }
}

/// An in-memory sink that records delivered frames and can be killed to simulate
/// a dead subscriber (mirrors the Phase-1 substrate test double).
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

/// Build a registry whose routes drive a [`FakeTunnels`] and publish the region,
/// exactly like the production [`register_tunnel_intents`] drives the real
/// manager. `start` here transitions synchronously to `connecting` (the real
/// handler spawns; the projection contract under test is identical either way).
fn registry_for(fake: Arc<FakeTunnels>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let f = fake.clone();
    registry.route("tunnel.create", move |intent, projector| {
        let config: TunnelConfig = serde_json::from_value(intent.payload.clone())
            .map_err(|e| ("bad_payload".to_string(), e.to_string()))?;
        f.upsert(config);
        Ok(publish_fake(&f, projector))
    });

    let f = fake.clone();
    registry.route("tunnel.remove", move |intent, projector| {
        let id = intent.payload["id"].as_str().unwrap().to_string();
        f.remove(&id);
        Ok(publish_fake(&f, projector))
    });

    let f = fake.clone();
    registry.route("tunnel.start", move |intent, projector| {
        let id = intent.payload["id"].as_str().unwrap().to_string();
        f.set_status(&id, TunnelStatus::Connecting);
        Ok(publish_fake(&f, projector))
    });

    let f = fake;
    registry.route("tunnel.stop", move |intent, projector| {
        let id = intent.payload["id"].as_str().unwrap().to_string();
        f.set_status(&id, TunnelStatus::Disconnected);
        Ok(publish_fake(&f, projector))
    });

    registry
}

fn publish_fake(fake: &FakeTunnels, projector: &Projector) -> Vec<ProducedRegion> {
    match projector.publish(TUNNELS_REGION, fake.view()) {
        Some(version) => vec![ProducedRegion {
            region: TUNNELS_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
    }
}

fn intent(kind: &str, payload: Value) -> Intent {
    Intent {
        intent_id: format!("01J-{kind}"),
        kind: kind.to_string(),
        payload,
        client_id: "A".to_string(),
    }
}

#[test]
fn subscribe_returns_the_seeded_snapshot_identically_to_every_subscriber() {
    let fake = Arc::new(FakeTunnels::new());
    fake.upsert(local_tunnel("t1", "db"));
    fake.set_status("t1", TunnelStatus::Connected);

    let projector = Arc::new(Projector::new());
    projector.register_region(TUNNELS_REGION, fake.view());

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap_a = projector.subscribe(TUNNELS_REGION, "sub-a", "A", sink_a);
    let snap_b = projector.subscribe(TUNNELS_REGION, "sub-b", "B", sink_b);

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.view["tunnels"][0]["id"], json!("t1"));
    assert_eq!(snap_a.view["states"]["t1"]["status"], json!("connected"));
}

#[test]
fn start_intent_produces_one_diff_fanned_to_two_subscribers() {
    let fake = Arc::new(FakeTunnels::new());
    fake.upsert(local_tunnel("t1", "db"));

    let projector = Arc::new(Projector::new());
    projector.register_region(TUNNELS_REGION, fake.view());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(fake.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(TUNNELS_REGION, "sub-a", "A", sink_a.clone());
    projector.subscribe(TUNNELS_REGION, "sub-b", "B", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent("tunnel.start", json!({ "id": "t1" })));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![ProducedRegion {
            region: TUNNELS_REGION.to_string(),
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
    assert_eq!(cache_a.view["states"]["t1"]["status"], json!("connecting"));
    assert_eq!(cache_a.view, fake.view(), "cache converges on authority");
}

#[test]
fn create_and_remove_intents_advance_the_config_list() {
    let fake = Arc::new(FakeTunnels::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(TUNNELS_REGION, fake.view());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(fake.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(TUNNELS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);
    assert_eq!(cache.view["tunnels"], json!([]));

    let config = serde_json::to_value(local_tunnel("t1", "db")).unwrap();
    let ack = dispatcher.dispatch(intent("tunnel.create", config));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let ack = dispatcher.dispatch(intent("tunnel.remove", json!({ "id": "t1" })));
    assert_eq!(ack.status, IntentStatus::Accepted);

    // Two diffs: add the config (v1), then remove it (v2).
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 2);
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 2);
    assert_eq!(cache.view["tunnels"], json!([]), "list is empty again");
    assert_eq!(cache.view, fake.view());
}

#[test]
fn a_dead_subscriber_is_reaped_and_others_keep_receiving() {
    let fake = Arc::new(FakeTunnels::new());
    fake.upsert(local_tunnel("t1", "db"));
    let projector = Arc::new(Projector::new());
    projector.register_region(TUNNELS_REGION, fake.view());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(fake.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(TUNNELS_REGION, "live", "A", live.clone());
    projector.subscribe(TUNNELS_REGION, "dead", "B", dead.clone());
    dead.alive.store(false, Ordering::SeqCst);

    dispatcher.dispatch(intent("tunnel.start", json!({ "id": "t1" })));
    assert_eq!(projector.subscriber_count(TUNNELS_REGION), 1, "dead reaped");
    assert_eq!(live.diffs().len(), 1, "live subscriber still receives");
}
