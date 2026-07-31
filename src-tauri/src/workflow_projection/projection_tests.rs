//! Projection-contract tests for the client-scoped `workflow-run@<clientId>`
//! region (#2243), reusing the substrate harness (#2164): an in-memory
//! [`ProjectionSink`] and a client cache that applies diffs. The routes here
//! drive a real [`WorkflowRunStore`] directly (the production
//! `register_workflow_intents` resolves the same store from the Tauri
//! `AppHandle`; that thin wiring is integration-verified via a local
//! `./scripts/dev.sh` run) through the identical parse → mutate → publish path.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with
//! monotonic versions, client-scoped isolation, rejection paths advance
//! nothing, a no-op intent coalesces to nothing, a dead subscriber is reaped,
//! and the client cache converges on the store's authority across a full run.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, ProjectionError,
    ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};
use crate::workflow_projection::projection::{publish_workflow_run, workflow_run_region};
use crate::workflow_projection::store::WorkflowRunStore;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// The production `workflow.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_workflow_intents` runs.
fn registry_for(store: Arc<WorkflowRunStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("workflow.runStarted", move |intent, projector| {
        let workflow_id = req_str(intent, "workflowId")?;
        let workflow_name = req_str(intent, "workflowName")?;
        let tab_id = req_str(intent, "tabId")?;
        let total = req_usize(intent, "total")?;
        s.run_started(
            &intent.client_id,
            &workflow_id,
            &workflow_name,
            &tab_id,
            total,
        );
        Ok(publish_workflow_run(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("workflow.stepAdvanced", move |intent, projector| {
        let workflow_id = req_str(intent, "workflowId")?;
        let tab_id = req_str(intent, "tabId")?;
        let completed = req_usize(intent, "completed")?;
        s.step_advanced(&intent.client_id, &workflow_id, &tab_id, completed);
        Ok(publish_workflow_run(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("workflow.outputOpened", move |intent, projector| {
        let workflow_id = req_str(intent, "workflowId")?;
        let workflow_name = req_str(intent, "workflowName")?;
        let program = req_str(intent, "program")?;
        let args: Vec<String> = intent
            .payload
            .get("args")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        s.output_opened(
            &intent.client_id,
            &workflow_id,
            &workflow_name,
            &program,
            &args,
        );
        Ok(publish_workflow_run(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("workflow.runCompleted", move |intent, projector| {
        s.run_completed(&intent.client_id);
        Ok(publish_workflow_run(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("workflow.runCancelled", move |intent, projector| {
        s.run_cancelled(&intent.client_id);
        Ok(publish_workflow_run(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("workflow.runFailed", move |intent, projector| {
        let error = intent
            .payload
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string);
        s.run_failed(&intent.client_id, error);
        Ok(publish_workflow_run(projector, &s, &intent.client_id))
    });

    let s = store;
    registry.route("workflow.dismissOutput", move |intent, projector| {
        s.dismiss_output(&intent.client_id);
        Ok(publish_workflow_run(projector, &s, &intent.client_id))
    });

    registry
}

fn req_str(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

fn req_usize(intent: &Intent, key: &str) -> Result<usize, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

/// An in-memory sink recording delivered frames; can be killed to simulate a
/// dead subscriber (mirrors the substrate/tunnel/layout test double).
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
fn subscribe_returns_the_empty_baseline_identically_to_every_subscriber() {
    let store = Arc::new(WorkflowRunStore::new());
    let region = workflow_run_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));

    let snap_a = projector.subscribe(&region, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(&region, "sub-b", "A", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "workflow-run@A");
    assert_eq!(snap_a.view["run"], Value::Null);
    assert_eq!(snap_a.view["output"], Value::Null);
}

#[test]
fn a_run_started_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = Arc::new(WorkflowRunStore::new());
    let region = workflow_run_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub-a", "A", sink_a.clone());
    projector.subscribe(&region, "sub-b", "A", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "workflow.runStarted",
        "A",
        json!({ "workflowId": "wf-1", "workflowName": "Deploy", "tabId": "t1", "total": 3 }),
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

    cache_a.apply(&diffs_a[0]);
    assert_eq!(cache_a.view, store.snapshot("A"), "cache converges");
    assert_eq!(cache_a.view["run"]["total"], json!(3));
    assert_eq!(cache_a.view["run"]["completed"], json!(0));
}

#[test]
fn a_full_run_advances_monotonically_and_converges() {
    let store = Arc::new(WorkflowRunStore::new());
    let region = workflow_run_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // start(2) → open panel → step 1 → step 2 → fail (settles the run).
    for (kind, payload) in [
        (
            "workflow.runStarted",
            json!({ "workflowId": "wf-1", "workflowName": "Deploy", "tabId": "t1", "total": 2 }),
        ),
        (
            "workflow.outputOpened",
            json!({ "workflowId": "wf-1", "workflowName": "Deploy", "program": "make", "args": ["build"] }),
        ),
        (
            "workflow.stepAdvanced",
            json!({ "workflowId": "wf-1", "tabId": "t1", "completed": 1 }),
        ),
        ("workflow.runFailed", json!({ "error": "exit 1" })),
    ] {
        let ack = dispatcher.dispatch(intent(kind, "A", payload));
        assert_eq!(ack.status, IntentStatus::Accepted, "{kind} accepted");
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 4, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 4);
    assert_eq!(
        cache.view,
        store.snapshot("A"),
        "cache converges on authority"
    );
    assert_eq!(cache.view["run"], Value::Null);
    assert_eq!(cache.view["output"]["status"], json!("failed"));
    assert_eq!(cache.view["output"]["error"], json!("exit 1"));
    assert_eq!(cache.view["output"]["program"], json!("make"));
}

#[test]
fn a_run_is_isolated_to_its_client_region() {
    let store = Arc::new(WorkflowRunStore::new());
    let region_a = workflow_run_region("A");
    let region_b = workflow_run_region("B");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region_a, store.snapshot("A"));
    projector.register_region(&region_b, store.snapshot("B"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    projector.subscribe(&region_a, "sa", "A", sink_a.clone());
    projector.subscribe(&region_b, "sb", "B", sink_b.clone());

    dispatcher.dispatch(intent(
        "workflow.runStarted",
        "A",
        json!({ "workflowId": "wf-1", "workflowName": "Deploy", "tabId": "t1", "total": 1 }),
    ));

    assert_eq!(sink_a.diffs().len(), 1, "A's region advanced");
    assert_eq!(sink_b.diffs().len(), 0, "B's region untouched");
    assert_eq!(projector.region_version(&region_b), Some(0));
}

#[test]
fn an_intent_missing_required_fields_is_rejected_without_advancing() {
    let store = Arc::new(WorkflowRunStore::new());
    let region = workflow_run_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    // Missing `total`.
    let ack = dispatcher.dispatch(intent(
        "workflow.runStarted",
        "A",
        json!({ "workflowId": "wf-1", "workflowName": "Deploy", "tabId": "t1" }),
    ));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn a_no_op_step_advance_advances_nothing() {
    // Advancing with no active run leaves the view unchanged, so the projector
    // coalesces it to no diff and no version bump.
    let store = Arc::new(WorkflowRunStore::new());
    let region = workflow_run_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent(
        "workflow.stepAdvanced",
        "A",
        json!({ "workflowId": "ghost", "tabId": "t1", "completed": 1 }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = Arc::new(WorkflowRunStore::new());
    let region = workflow_run_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(&region, "live", "A", live.clone());
    projector.subscribe(&region, "dead", "A", dead.clone());
    assert_eq!(projector.subscriber_count(&region), 2);

    dead.alive.store(false, Ordering::SeqCst);
    dispatcher.dispatch(intent(
        "workflow.runStarted",
        "A",
        json!({ "workflowId": "wf-1", "workflowName": "Deploy", "tabId": "t1", "total": 1 }),
    ));

    assert_eq!(
        live.diffs().len(),
        1,
        "the live subscriber still gets the diff"
    );
    assert_eq!(
        projector.subscriber_count(&region),
        1,
        "the dead subscriber was reaped"
    );
}
