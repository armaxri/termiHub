//! Workflow-run projection: the client-scoped `workflow-run@<clientId>` region
//! and the `workflow.*` intents (#2243, part of #2206 / #2152 / #2139).
//!
//! Exposes the authoritative [`WorkflowRunStore`] to each attached client as
//! its own versioned, multi-subscriber projection region and turns the run
//! transitions the frontend currently drives into [`Intent`]s — mirroring the
//! client-scoped `restore-cohort` ([`crate::restore_cohort_projection`]) and
//! `broadcast` ([`crate::broadcast_projection`]) siblings and the reference
//! substrate registration pattern ([`crate::projection`]).
//!
//! # The `workflow-run@<clientId>` region
//!
//! **Client-scoped** (Open Design Decision #4 / #6: a workflow run is an
//! orchestration overlay owned by the launching client, not shared
//! infrastructure — like `restore-cohort` and `layout`). Each client gets its
//! own region, seeded lazily and mutated via `intent.client_id`. The view
//! model:
//!
//! ```json
//! {
//!   "run": { "workflowId": "…", "workflowName": "…", "tabId": "…",
//!            "total": N, "completed": N } | null,
//!   "output": { "workflowId": "…", "workflowName": "…", "program": "…",
//!               "args": ["…"], "status": "running" | "completed"
//!                 | "cancelled" | "failed", "error": "…"? } | null
//! }
//! ```
//!
//! # Intents
//!
//! | kind                     | payload                                                    | effect                                          |
//! | ------------------------ | ---------------------------------------------------------- | ----------------------------------------------- |
//! | `workflow.runStarted`    | `{ workflowId, workflowName, tabId, total }`               | begin a run at `completed == 0`; clear panel    |
//! | `workflow.stepAdvanced`  | `{ workflowId, tabId, completed }`                         | update progress if the ids match the active run |
//! | `workflow.outputOpened`  | `{ workflowId, workflowName, program, args }`              | open the run-output panel in `running` status   |
//! | `workflow.runCompleted`  | `{}`                                                       | settle the run as completed                     |
//! | `workflow.runCancelled`  | `{}`                                                       | settle the run as cancelled                     |
//! | `workflow.runFailed`     | `{ error? }`                                               | settle the run as failed; stamp panel error     |
//! | `workflow.dismissOutput` | `{}`                                                       | dismiss the run-output panel                    |
//!
//! `outputOpened` models the panel's *status* seam only: the streamed
//! stdout/stderr lines, the process exit code, and the timeout flag stay
//! frontend orchestration (see [`crate::workflow_projection::store`]), reusing
//! the existing `subscribeLocalProcessOutput` stream. The step side-effects
//! (send / macro / local-process execution) likewise stay frontend; the store
//! learns of progress only through these intents.
//!
//! # Shadow mode
//!
//! Registered and fully served, but **not** driving the live UI: no frontend
//! subscribes to `workflow-run@<clientId>` or dispatches `workflow.*` yet, so
//! these intents mutate only the shadow store and project to regions nobody
//! renders. The `appStore` run reducers, progress toast, and output panel
//! remain authoritative. Per the substrate contract the result of an intent is
//! never returned inline — it always arrives as a projection diff on the
//! client's region.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};
use crate::workflow_projection::store::WorkflowRunStore;

/// The projection region id for a client's workflow run
/// (`workflow-run@<clientId>`).
pub fn workflow_run_region(client_id: &str) -> String {
    format!("workflow-run@{client_id}")
}

/// Publish a client's `workflow-run` region from the store, fanning a diff out
/// to every subscriber and returning the advanced region for the intent ack
/// (empty when the view did not change).
pub fn publish_workflow_run(
    projector: &Projector,
    store: &WorkflowRunStore,
    client_id: &str,
) -> Vec<ProducedRegion> {
    let region = workflow_run_region(client_id);
    match projector.publish(&region, store.snapshot(client_id)) {
        Some(version) => vec![ProducedRegion { region, version }],
        None => Vec::new(),
    }
}

/// Register the `workflow.*` intents on a handler registry.
///
/// Each route resolves the managed [`WorkflowRunStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), mutates
/// the dispatching client's run via [`intent.client_id`](Intent::client_id),
/// and publishes that client's region. All transitions are pure/fast map edits,
/// so they run inline on the dispatcher's single writer.
pub fn register_workflow_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("workflow.runStarted", move |intent, projector| {
        let store = store_of(&handle)?;
        let workflow_id = required_str(intent, "workflowId")?;
        let workflow_name = required_str(intent, "workflowName")?;
        let tab_id = required_str(intent, "tabId")?;
        let total = required_usize(intent, "total")?;
        store.run_started(
            &intent.client_id,
            &workflow_id,
            &workflow_name,
            &tab_id,
            total,
        );
        Ok(publish_workflow_run(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("workflow.stepAdvanced", move |intent, projector| {
        let store = store_of(&handle)?;
        let workflow_id = required_str(intent, "workflowId")?;
        let tab_id = required_str(intent, "tabId")?;
        let completed = required_usize(intent, "completed")?;
        store.step_advanced(&intent.client_id, &workflow_id, &tab_id, completed);
        Ok(publish_workflow_run(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("workflow.outputOpened", move |intent, projector| {
        let store = store_of(&handle)?;
        let workflow_id = required_str(intent, "workflowId")?;
        let workflow_name = required_str(intent, "workflowName")?;
        let program = required_str(intent, "program")?;
        let args = optional_str_array(intent, "args")?;
        store.output_opened(
            &intent.client_id,
            &workflow_id,
            &workflow_name,
            &program,
            &args,
        );
        Ok(publish_workflow_run(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("workflow.runCompleted", move |intent, projector| {
        let store = store_of(&handle)?;
        store.run_completed(&intent.client_id);
        Ok(publish_workflow_run(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("workflow.runCancelled", move |intent, projector| {
        let store = store_of(&handle)?;
        store.run_cancelled(&intent.client_id);
        Ok(publish_workflow_run(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("workflow.runFailed", move |intent, projector| {
        let store = store_of(&handle)?;
        let error = optional_str(intent, "error");
        store.run_failed(&intent.client_id, error);
        Ok(publish_workflow_run(projector, &store, &intent.client_id))
    });

    let handle = app_handle;
    registry.route("workflow.dismissOutput", move |intent, projector| {
        let store = store_of(&handle)?;
        store.dismiss_output(&intent.client_id);
        Ok(publish_workflow_run(projector, &store, &intent.client_id))
    });
}

/// Resolve the managed workflow-run store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<WorkflowRunStore>, (String, String)> {
    app_handle
        .try_state::<Arc<WorkflowRunStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "workflow-run store is not initialized".to_string(),
            )
        })
}

/// Extract a required string field from an intent payload.
fn required_str(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

/// Extract a required non-negative integer field.
fn required_usize(intent: &Intent, key: &str) -> Result<usize, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

/// Extract an optional array-of-strings field (e.g. `args`), defaulting to an
/// empty vec when absent. Rejects a present-but-malformed value.
fn optional_str_array(intent: &Intent, key: &str) -> Result<Vec<String>, (String, String)> {
    let Some(value) = intent.payload.get(key) else {
        return Ok(Vec::new());
    };
    let arr = value
        .as_array()
        .ok_or_else(|| ("bad_payload".to_string(), format!("invalid '{key}'")))?;
    arr.iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| ("bad_payload".to_string(), format!("invalid '{key}' entry")))
        })
        .collect()
}

/// Extract an optional string field (e.g. a failure reason); absent → `None`.
fn optional_str(intent: &Intent, key: &str) -> Option<String> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
