//! Worked in-memory harness for the projection substrate (#2149).
//!
//! Proves the full loop against a synthetic SSH-tunnels region (the parent
//! concept's Phase-2 pilot domain) without any Tauri dependency:
//!
//! * subscribe → snapshot baseline, identical for every subscriber;
//! * dispatch(intent) → a single diff fanned out to two subscribers, both
//!   caches converging on the authoritative view;
//! * a forced version gap → `resync` → re-baseline, with no stale diff applied.
//!
//! It also unit-tests the diff/apply helpers, the versioning invariants,
//! subscriber lifecycle, and the envelope serde shapes that mirror the
//! TypeScript types.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::*;

// ── Test doubles ────────────────────────────────────────────────────────────

/// An in-memory [`ProjectionSink`] that records delivered frames and can be
/// "killed" to simulate a closed channel / dead socket.
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

    fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
    }

    /// Every diff this sink received, in delivery order.
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
            return Err(ProjectionError::SinkClosed("test sink killed".into()));
        }
        self.frames.lock().unwrap().push(frame.clone());
        Ok(())
    }
}

/// A simulated client-side cache: holds `{ version, view }`, applies ordered
/// diffs, detects gaps, and re-baselines from a snapshot. Mirrors the
/// TypeScript `ProjectionClient`.
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

    /// Apply a diff iff it fits (`base_version == version`); otherwise report a
    /// gap without mutating the cache.
    fn apply(&mut self, diff: &DiffFrame) -> Result<(), Gap> {
        if diff.base_version != self.version {
            return Err(Gap);
        }
        apply_ops(&mut self.view, &diff.ops).expect("diff applies cleanly");
        self.version = diff.version;
        Ok(())
    }

    fn rebaseline(&mut self, s: &SnapshotFrame) {
        self.version = s.version;
        self.view = s.view.clone();
    }
}

/// A detected version gap: the incoming diff did not fit the cache.
#[derive(Debug, PartialEq, Eq)]
struct Gap;

/// Synthetic authoritative tunnel store — the substrate's worked domain.
struct TunnelStore {
    view: Mutex<Value>,
}

impl TunnelStore {
    fn new() -> Self {
        Self {
            view: Mutex::new(json!({
                "tunnels": [
                    { "id": "t1", "label": "db → localhost:5432", "kind": "local",
                      "status": "connected", "bind": "127.0.0.1:5432" },
                    { "id": "t2", "label": "socks", "kind": "dynamic",
                      "status": "stopped", "bind": "127.0.0.1:1080" }
                ]
            })),
        }
    }

    fn set_status(&self, id: &str, status: &str) {
        let mut view = self.view.lock().unwrap();
        if let Some(tunnels) = view["tunnels"].as_array_mut() {
            for t in tunnels {
                if t["id"] == json!(id) {
                    t["status"] = json!(status);
                }
            }
        }
    }
}

impl ProjectedStore for TunnelStore {
    fn region_id(&self) -> &str {
        "tunnels"
    }
    fn snapshot(&self) -> Value {
        self.view.lock().unwrap().clone()
    }
}

/// Intent handler for the tunnel region: `tunnel.start` moves a tunnel to
/// `connecting` and publishes the region.
struct TunnelHandler {
    store: Arc<TunnelStore>,
}

impl IntentHandler for TunnelHandler {
    fn handle(
        &self,
        intent: &Intent,
        projector: &Projector,
    ) -> Result<Vec<ProducedRegion>, (String, String)> {
        match intent.kind.as_str() {
            "tunnel.start" => {
                let id = intent.payload["id"]
                    .as_str()
                    .ok_or_else(|| ("bad_payload".to_string(), "missing tunnel id".to_string()))?;
                self.store.set_status(id, "connecting");
                let produced = match projector.publish_store(&*self.store) {
                    Some(version) => vec![ProducedRegion {
                        region: "tunnels".to_string(),
                        version,
                    }],
                    None => vec![],
                };
                Ok(produced)
            }
            other => Err((
                "unknown_intent".to_string(),
                format!("tunnel handler cannot handle '{other}'"),
            )),
        }
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

// ── The worked full-loop scenario ───────────────────────────────────────────

#[test]
fn full_loop_subscribe_dispatch_fanout_and_forced_gap_resync() {
    let projector = Arc::new(Projector::new());
    let store = Arc::new(TunnelStore::new());
    projector.register_region("tunnels", store.snapshot());
    let dispatcher = Dispatcher::new(
        projector.clone(),
        Arc::new(TunnelHandler {
            store: store.clone(),
        }),
    );

    // 1 · Attach two subscribers (desktop A + browser B). Both get the same
    //     baseline snapshot at version 0.
    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap_a = projector.subscribe("tunnels", "sub-a", "A", sink_a.clone());
    let snap_b = projector.subscribe("tunnels", "sub-b", "B", sink_b.clone());
    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "late joiner gets an identical baseline");
    assert_eq!(projector.subscriber_count("tunnels"), 2);
    let mut cache_a = ClientCache::from_snapshot(&snap_a);
    let mut cache_b = ClientCache::from_snapshot(&snap_b);

    // 2 · A dispatches tunnel.start(t2). The ack is a receipt naming the region
    //     it advanced; the *result* arrives as a diff.
    let ack = dispatcher.dispatch(intent("tunnel.start", json!({ "id": "t2" })));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![ProducedRegion {
            region: "tunnels".into(),
            version: 1
        }])
    );

    // 3 · One diff (base 0 → version 1) is fanned out to BOTH subscribers.
    let diff_a = sink_a.diffs();
    let diff_b = sink_b.diffs();
    assert_eq!(diff_a.len(), 1);
    assert_eq!(diff_b.len(), 1);
    assert_eq!(diff_a[0], diff_b[0], "identical diff to every subscriber");
    assert_eq!(diff_a[0].base_version, 0);
    assert_eq!(diff_a[0].version, 1);

    // Both caches apply it and converge on the authoritative view.
    cache_a.apply(&diff_a[0]).unwrap();
    cache_b.apply(&diff_b[0]).unwrap();
    assert_eq!(cache_a.view, cache_b.view);
    assert_eq!(cache_a.view, store.snapshot());
    assert_eq!(
        cache_a.view.pointer("/tunnels/1/status").unwrap(),
        &json!("connecting")
    );

    // 4 · B goes away (backgrounded). Backend advances twice while B is gone:
    //     real completion t2→connected (v2) and then A stops t1 (v3).
    sink_b.kill();
    store.set_status("t2", "connected");
    assert_eq!(projector.publish_store(&*store), Some(2));
    store.set_status("t1", "stopped");
    assert_eq!(projector.publish_store(&*store), Some(3));

    // B's dead sink was reaped on the emit path; A still receives everything.
    assert_eq!(projector.subscriber_count("tunnels"), 1);
    let diff_a = sink_a.diffs();
    assert_eq!(diff_a.len(), 3);
    cache_a.apply(&diff_a[1]).unwrap();
    cache_a.apply(&diff_a[2]).unwrap();
    assert_eq!(cache_a.version, 3);

    // 5 · B reconnects. It is still at version 1; the only frame it now sees is
    //     the latest diff (base 2), which does NOT fit — a forced gap.
    let latest = diff_a.last().unwrap();
    assert_eq!(cache_b.version, 1);
    assert_eq!(cache_b.apply(latest), Err(Gap), "gap detected, not applied");

    // B resyncs from its known version; backend is ahead, so it re-baselines
    // from a fresh snapshot and reconverges — never having applied a stale diff.
    let snap = projector
        .resync("tunnels", Some(cache_b.version))
        .expect("region advanced, snapshot returned");
    assert_eq!(snap.version, 3);
    cache_b.rebaseline(&snap);
    assert_eq!(cache_b.version, 3);
    assert_eq!(cache_b.view, cache_a.view);
    assert_eq!(cache_b.view, store.snapshot());

    // A current client asking to resync is told there is nothing to send.
    assert!(projector.resync("tunnels", Some(3)).is_none());
}

// ── Diff / apply helpers ────────────────────────────────────────────────────

#[test]
fn compute_ops_then_apply_roundtrips() {
    let old = json!({ "a": 1, "list": [ { "s": "x" } ], "gone": true });
    let new = json!({ "a": 2, "list": [ { "s": "x" }, { "s": "y" } ] });
    let ops = compute_ops(&old, &new);
    assert!(!ops.is_empty());
    let mut applied = old.clone();
    apply_ops(&mut applied, &ops).unwrap();
    assert_eq!(applied, new);
}

#[test]
fn compute_ops_is_empty_for_identical_views() {
    let v = json!({ "a": [1, 2, 3] });
    assert!(compute_ops(&v, &v).is_empty());
}

#[test]
fn semantic_op_is_rejected_by_the_applier() {
    let ops = vec![DiffOp::Semantic {
        name: "tunnelStatusChanged".into(),
        data: json!({ "id": "t2", "status": "connecting" }),
    }];
    let mut view = json!({});
    let err = apply_ops(&mut view, &ops).unwrap_err();
    assert!(matches!(err, ProjectionError::UnsupportedSemanticOp(_)));
}

// ── Versioning & lifecycle ──────────────────────────────────────────────────

#[test]
fn publish_without_change_is_a_noop() {
    let projector = Projector::new();
    projector.register_region("r", json!({ "x": 1 }));
    assert_eq!(projector.region_version("r"), Some(0));
    assert_eq!(projector.publish("r", json!({ "x": 1 })), None);
    assert_eq!(projector.region_version("r"), Some(0), "version unchanged");
}

#[test]
fn each_change_advances_version_by_exactly_one() {
    let projector = Projector::new();
    projector.register_region("r", json!({ "n": 0 }));
    assert_eq!(projector.publish("r", json!({ "n": 1 })), Some(1));
    assert_eq!(projector.publish("r", json!({ "n": 2 })), Some(2));
    assert_eq!(projector.publish("r", json!({ "n": 3 })), Some(3));
}

#[test]
fn unsubscribe_stops_delivery_and_is_idempotent() {
    let projector = Projector::new();
    projector.register_region("r", json!({ "n": 0 }));
    let sink = Arc::new(VecSink::new());
    projector.subscribe("r", "sub-1", "A", sink.clone());
    projector.publish("r", json!({ "n": 1 }));
    assert_eq!(sink.diffs().len(), 1);

    projector.unsubscribe("r", "sub-1");
    projector.unsubscribe("r", "sub-1"); // idempotent
    assert_eq!(projector.subscriber_count("r"), 0);
    projector.publish("r", json!({ "n": 2 }));
    assert_eq!(sink.diffs().len(), 1, "no frames after unsubscribe");
}

#[test]
fn unsubscribe_client_detaches_all_of_a_clients_subscriptions() {
    let projector = Projector::new();
    projector.register_region("r", json!({ "n": 0 }));
    // One client with two subscriptions (e.g. two windows), plus another client.
    projector.subscribe("r", "sub-1", "A", Arc::new(VecSink::new()));
    projector.subscribe("r", "sub-2", "A", Arc::new(VecSink::new()));
    let other = Arc::new(VecSink::new());
    projector.subscribe("r", "sub-3", "B", other.clone());
    assert_eq!(projector.subscriber_count("r"), 3);

    projector.unsubscribe_client("r", "A");
    projector.unsubscribe_client("r", "A"); // idempotent
    assert_eq!(projector.subscriber_count("r"), 1);

    projector.publish("r", json!({ "n": 1 }));
    assert_eq!(other.diffs().len(), 1, "client B still receives");
}

#[test]
fn resubscribe_with_same_id_replaces_the_sink() {
    let projector = Projector::new();
    projector.register_region("r", json!({ "n": 0 }));
    let first = Arc::new(VecSink::new());
    let second = Arc::new(VecSink::new());
    projector.subscribe("r", "sub-1", "A", first.clone());
    projector.subscribe("r", "sub-1", "A", second.clone());
    assert_eq!(projector.subscriber_count("r"), 1);
    projector.publish("r", json!({ "n": 1 }));
    assert_eq!(first.diffs().len(), 0);
    assert_eq!(second.diffs().len(), 1);
}

// ── Dispatch / ack ──────────────────────────────────────────────────────────

#[test]
fn unknown_intent_is_rejected_by_the_empty_registry() {
    let projector = Arc::new(Projector::new());
    let dispatcher = Dispatcher::new(projector, Arc::new(HandlerRegistry::new()));
    let ack = dispatcher.dispatch(intent("nope.doIt", json!({})));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "unknown_intent");
    assert!(ack.produced.is_none());
}

#[test]
fn registry_routes_by_exact_kind() {
    let projector = Arc::new(Projector::new());
    projector.register_region("r", json!({ "hit": false }));
    let mut registry = HandlerRegistry::new();
    registry.route("thing.do", |_intent, proj| {
        let v = proj.publish("r", json!({ "hit": true })).unwrap_or(0);
        Ok(vec![ProducedRegion {
            region: "r".into(),
            version: v,
        }])
    });
    let dispatcher = Dispatcher::new(projector, Arc::new(registry));
    let ack = dispatcher.dispatch(intent("thing.do", json!({})));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced.unwrap()[0].version, 1);
}

#[test]
fn handler_rejection_becomes_a_rejected_ack() {
    let projector = Arc::new(Projector::new());
    let store = Arc::new(TunnelStore::new());
    let dispatcher = Dispatcher::new(projector, Arc::new(TunnelHandler { store }));
    let ack = dispatcher.dispatch(intent("tunnel.start", json!({}))); // no id
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
}

// ── Envelope serde shapes (must mirror the TypeScript types) ─────────────────

#[test]
fn intent_serialises_with_camelcase_keys() {
    let v = serde_json::to_value(intent("tunnel.start", json!({ "id": "t2" }))).unwrap();
    assert_eq!(v["intentId"], json!("01J-tunnel.start"));
    assert_eq!(v["kind"], json!("tunnel.start"));
    assert_eq!(v["clientId"], json!("A"));
    assert_eq!(v["payload"], json!({ "id": "t2" }));
}

#[test]
fn ack_omits_absent_fields() {
    let accepted = serde_json::to_value(IntentAck::accepted("i1", vec![])).unwrap();
    assert_eq!(accepted["status"], json!("accepted"));
    assert!(accepted.get("error").is_none());
    assert_eq!(accepted["produced"], json!([]));

    let rejected = serde_json::to_value(IntentAck::rejected("i1", "code", "msg")).unwrap();
    assert_eq!(rejected["status"], json!("rejected"));
    assert_eq!(
        rejected["error"],
        json!({ "code": "code", "message": "msg" })
    );
    assert!(rejected.get("produced").is_none());
}

#[test]
fn projection_frame_is_tagged_by_kind() {
    let snap = ProjectionFrame::Snapshot(SnapshotFrame {
        region: "tunnels".into(),
        version: 41,
        view: json!({ "tunnels": [] }),
    });
    let v = serde_json::to_value(&snap).unwrap();
    assert_eq!(v["kind"], json!("snapshot"));
    assert_eq!(v["region"], json!("tunnels"));
    assert_eq!(v["version"], json!(41));

    let diff = ProjectionFrame::Diff(DiffFrame {
        region: "tunnels".into(),
        base_version: 41,
        version: 42,
        ops: vec![DiffOp::Replace {
            path: "/tunnels/1/status".into(),
            value: json!("connecting"),
        }],
    });
    let v = serde_json::to_value(&diff).unwrap();
    assert_eq!(v["kind"], json!("diff"));
    assert_eq!(v["baseVersion"], json!(41));
    assert_eq!(
        v["ops"][0],
        json!({ "op": "replace", "path": "/tunnels/1/status", "value": "connecting" })
    );

    // Round-trips back to the same frame.
    assert_eq!(serde_json::from_value::<ProjectionFrame>(v).unwrap(), diff);
}
