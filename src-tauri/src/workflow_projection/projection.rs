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
//!   "runs": [ { "runId": "…", "workflowId": "…", "workflowName": "…",
//!               "tabId": "…", "label": "…" | null,
//!               "total": N, "completed": N } ],
//!   "run": <the most recently started entry of `runs`> | null,
//!   "output": { "runId": "…" | null, "workflowId": "…", "workflowName": "…",
//!               "program": "…", "args": ["…"], "status": "running"
//!                 | "completed" | "cancelled" | "failed", "error": "…"? } | null
//! }
//! ```
//!
//! `runs` (#3418) lists every in-flight run in start order — a concurrent
//! "Run on…" fan-out has one per target. `run` is kept append-only for
//! single-run consumers.
//!
//! # Intents
//!
//! | kind                     | payload                                                    | effect                                          |
//! | ------------------------ | ---------------------------------------------------------- | ----------------------------------------------- |
//! | `workflow.runStarted`    | `{ runId?, workflowId, workflowName, tabId, label?, total, preserveOutput? }` | begin a run at `completed == 0`; clear panel unless `preserveOutput` |
//! | `workflow.stepAdvanced`  | `{ runId? \| (workflowId, tabId), completed }`             | update the matching run's progress               |
//! | `workflow.outputOpened`  | `{ runId?, workflowId, workflowName, program, args }`      | open the run-output panel in `running` status   |
//! | `workflow.runCompleted`  | `{ runId? }`                                               | settle the run as completed                     |
//! | `workflow.runCancelled`  | `{ runId? }`                                               | settle the run as cancelled                     |
//! | `workflow.runFailed`     | `{ runId?, error? }`                                       | settle the run as failed; stamp panel error     |
//! | `workflow.dismissOutput` | `{}`                                                       | dismiss the run-output panel                    |
//!
//! Without a `runId` every intent keeps the pre-#3418 single-run semantics: a
//! start supersedes every in-flight run, a settle settles all of them, and
//! progress matches by `workflowId` + `tabId`. With a `runId` the intent targets
//! that one run, so several runs progress and settle independently.
//!
//! `outputOpened` models the panel's *status* seam only: the streamed
//! stdout/stderr lines, the process exit code, and the timeout flag stay
//! frontend orchestration (see [`crate::workflow_projection::store`]), reusing
//! the existing `subscribeLocalProcessOutput` stream. The step side-effects
//! (send / macro / local-process execution) likewise stay frontend; the store
//! learns of progress only through these intents.
//!
//! # Authoritative — drives the live UI (#2243)
//!
//! Registered, fully served, and driving the live UI: the frontend subscribes to
//! `workflow-run@<clientId>`, renders the run status from it, and dispatches these
//! `workflow.*` intents so the store is authoritative. The former `appStore` run
//! reducers and the render/mutation-cut flags were removed (#2283). Per the
//! substrate contract the result of an intent is never returned inline — it always
//! arrives as a projection diff on the client's region.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::projection::{
    optional_str, required_str, required_usize, HandlerRegistry, Intent, ProducedRegion, Projector,
};
use crate::workflow_projection::store::{RunStart, WorkflowRunStore};

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

/// Every `workflow.*` intent kind the region serves (the routes
/// [`register_workflow_intents`] installs, each applied by
/// [`apply_workflow_intent`]).
pub const WORKFLOW_INTENT_KINDS: [&str; 7] = [
    "workflow.runStarted",
    "workflow.stepAdvanced",
    "workflow.outputOpened",
    "workflow.runCompleted",
    "workflow.runCancelled",
    "workflow.runFailed",
    "workflow.dismissOutput",
];

/// Register the `workflow.*` intents on a handler registry.
///
/// Each route resolves the managed [`WorkflowRunStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), mutates
/// the dispatching client's runs via [`intent.client_id`](Intent::client_id)
/// through [`apply_workflow_intent`], and publishes that client's region. All
/// transitions are pure/fast map edits, so they run inline on the dispatcher's
/// single writer.
pub fn register_workflow_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    for kind in WORKFLOW_INTENT_KINDS {
        let handle = app_handle.clone();
        registry.route(kind, move |intent, projector| {
            let store = store_of(&handle)?;
            apply_workflow_intent(&store, intent)?;
            Ok(publish_workflow_run(projector, &store, &intent.client_id))
        });
    }
}

/// Parse a `workflow.*` intent's payload and apply it to the store — the
/// shared parse → mutate half of every route (the tests drive the identical
/// path against an injected store). A malformed payload is rejected with
/// `bad_payload` and mutates nothing.
///
/// `runId` is optional on every run intent (#3418): present, the intent
/// targets that one run of several concurrent ones; absent, it keeps the
/// pre-#3418 single-run semantics (a start supersedes every run, a settle
/// settles every run, progress matches by `workflowId` + `tabId`).
pub fn apply_workflow_intent(
    store: &WorkflowRunStore,
    intent: &Intent,
) -> Result<(), (String, String)> {
    let client = intent.client_id.as_str();
    let run_id = optional_str(intent, "runId");
    match intent.kind.as_str() {
        "workflow.runStarted" => {
            let start = RunStart {
                run_id,
                workflow_id: required_str(intent, "workflowId")?,
                workflow_name: required_str(intent, "workflowName")?,
                tab_id: required_str(intent, "tabId")?,
                label: optional_str(intent, "label"),
                total: required_usize(intent, "total")?,
                preserve_output: intent
                    .payload
                    .get("preserveOutput")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            store.start_run(client, start);
        }
        "workflow.stepAdvanced" => {
            let completed = required_usize(intent, "completed")?;
            match run_id {
                Some(id) => store.run_step_advanced(client, &id, completed),
                None => {
                    let workflow_id = required_str(intent, "workflowId")?;
                    let tab_id = required_str(intent, "tabId")?;
                    store.step_advanced(client, &workflow_id, &tab_id, completed);
                }
            }
        }
        "workflow.outputOpened" => {
            let workflow_id = required_str(intent, "workflowId")?;
            let workflow_name = required_str(intent, "workflowName")?;
            let program = required_str(intent, "program")?;
            let args = optional_str_array(intent, "args")?;
            store.output_opened(
                client,
                run_id.as_deref(),
                &workflow_id,
                &workflow_name,
                &program,
                &args,
            );
        }
        "workflow.runCompleted" => store.run_completed(client, run_id.as_deref()),
        "workflow.runCancelled" => store.run_cancelled(client, run_id.as_deref()),
        "workflow.runFailed" => {
            store.run_failed(client, run_id.as_deref(), optional_str(intent, "error"));
        }
        "workflow.dismissOutput" => store.dismiss_output(client),
        other => {
            return Err((
                "unknown_intent".to_string(),
                format!("unsupported workflow intent '{other}'"),
            ))
        }
    }
    Ok(())
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

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
