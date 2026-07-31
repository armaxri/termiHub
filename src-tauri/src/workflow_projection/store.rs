//! The authoritative, client-scoped workflow-run state machine behind the
//! shadow `workflow-run@<clientId>` region (#2243, Phase 4 step 5c of #2139).
//!
//! Models the in-flight workflow run the frontend currently drives (`appStore`
//! `workflowRun` + `workflowRunOutput`, #1852 / #1865): a single active run per
//! client that advances step by step and settles on a terminal outcome, plus
//! the dismissible inline output panel a `run-local-process` step opens. This
//! module owns only the run **status** per client — not the workflow library
//! (already backend-backed via `workflowApi`), and not the step side-effects.
//!
//! # Client-scoped — Open Design Decision #4 / #6
//!
//! A run belongs to the client that launched it: that client picks the target
//! terminal, sees the progress toast, and owns the output panel. Only one run
//! is active per client (a fresh `runStarted` supersedes any prior run's
//! panel). It is a property of the launching client, not of shared
//! infrastructure, so the store keys everything by `clientId` and projects one
//! `workflow-run@<clientId>` region per client — mirroring `restore-cohort`,
//! `broadcast`, and `layout`.
//!
//! # Authoritative after the render + mutation cut (#2243)
//!
//! The shadow landed this store; the frontend render + mutation cut then made it
//! authoritative — the UI renders the run status from the projected region and
//! dispatches the `workflow.*` intents. The `appStore` run reducers are retained as
//! the parity-safe fallback (removal is a later step), so the local path still runs
//! and takes over on any dispatch failure.
//!
//! ## What stays frontend
//!
//! The step-execution side-effects stay frontend orchestration, keeping a clean
//! per-domain boundary between run *status* (this store) and run *effects*:
//!
//! - **The step seams.** Sending commands, replaying macros, and spawning /
//!   authorizing local processes (`workflowRunner`'s `send` / `runMacro` /
//!   `runLocalProcess` seams) are effects; the store learns of their progress
//!   only through `workflow.stepAdvanced` and the run's terminal intent.
//! - **The output panel's streamed content.** The store models the panel's
//!   *status* lifecycle — opened (`running`) → terminal (`completed` /
//!   `cancelled` / `failed`) → dismissed — because that is run status. The
//!   streamed stdout/stderr `lines`, the process `exitCode`, and the `timedOut`
//!   flag are per-process content the frontend keeps (they reuse the existing
//!   `subscribeLocalProcessOutput` stream, #1857 / #1865); the store carries
//!   only the panel's identity (workflow, program, args) and status.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The terminal outcome of a workflow run, mirroring the frontend
/// `WorkflowRunStatus` (#1865). `Running` is the non-terminal state the output
/// panel opens in; the other three are the run's settle outcomes.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunOutcome {
    /// Every step ran successfully.
    Completed,
    /// The run was cancelled before finishing.
    Cancelled,
    /// A step failed and stopped the run.
    Failed,
}

impl RunOutcome {
    /// The lowercase status string projected into the view (matches the
    /// frontend `WorkflowRunOutputStatus`).
    fn as_str(self) -> &'static str {
        match self {
            RunOutcome::Completed => "completed",
            RunOutcome::Cancelled => "cancelled",
            RunOutcome::Failed => "failed",
        }
    }
}

/// The in-flight run's step-progress metadata (`appStore` `WorkflowRunState`).
#[derive(Clone, Debug, PartialEq)]
struct WorkflowRun {
    workflow_id: String,
    workflow_name: String,
    tab_id: String,
    total: usize,
    completed: usize,
}

impl WorkflowRun {
    fn to_view(&self) -> Value {
        json!({
            "workflowId": self.workflow_id,
            "workflowName": self.workflow_name,
            "tabId": self.tab_id,
            "total": self.total,
            "completed": self.completed,
        })
    }
}

/// The inline run-output panel a `run-local-process` step opens (`appStore`
/// `WorkflowRunOutputState`). The store owns its *status* lifecycle; the
/// streamed lines / exit code / timeout stay frontend (see the module docs).
#[derive(Clone, Debug, PartialEq)]
struct WorkflowRunOutput {
    workflow_id: String,
    workflow_name: String,
    program: String,
    args: Vec<String>,
    /// `None` while the process runs; `Some(outcome)` once the run settles.
    outcome: Option<RunOutcome>,
    /// A human-readable failure reason, set only when `outcome == Failed`.
    error: Option<String>,
}

impl WorkflowRunOutput {
    fn to_view(&self) -> Value {
        let status = match self.outcome {
            None => "running",
            Some(o) => o.as_str(),
        };
        json!({
            "workflowId": self.workflow_id,
            "workflowName": self.workflow_name,
            "program": self.program,
            "args": self.args,
            "status": status,
            "error": self.error,
        })
    }
}

/// One client's workflow-run state.
#[derive(Clone, Debug, Default)]
struct ClientState {
    /// The active run, or `None` when nothing is running.
    run: Option<WorkflowRun>,
    /// The inline output panel, or `None` when no local process has opened one
    /// (or it was dismissed / superseded).
    output: Option<WorkflowRunOutput>,
}

impl ClientState {
    /// The complete render-ready view model for this client's region.
    fn to_view(&self) -> Value {
        json!({
            "run": self.run.as_ref().map(WorkflowRun::to_view),
            "output": self.output.as_ref().map(WorkflowRunOutput::to_view),
        })
    }
}

/// The shadow workflow-run authority. Owns one [`ClientState`] per attached
/// client, keyed by `clientId`; an unknown client is seeded lazily on first
/// touch. Each client projects its own `workflow-run@<clientId>` region.
pub struct WorkflowRunStore {
    clients: Mutex<HashMap<String, ClientState>>,
}

impl Default for WorkflowRunStore {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkflowRunStore {
    /// A store with no clients yet. Regions are seeded lazily per `clientId`.
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// The current render-ready view model for a client (seeding it if
    /// unknown): `{ run, output }`.
    ///
    /// Pure with respect to run state (never mutates beyond lazy seeding of an
    /// empty client), so the projector can safely diff two consecutive
    /// snapshots.
    pub fn snapshot(&self, client_id: &str) -> Value {
        self.lock()
            .entry(client_id.to_string())
            .or_default()
            .to_view()
    }

    /// `workflow.runStarted` — begin a run against a target terminal. Sets the
    /// active run at `completed == 0` and clears any prior run's output panel
    /// (mirroring `appStore`, which nulls `workflowRunOutput` on a fresh run —
    /// the panel is recreated lazily only if this run spawns a local process).
    /// A fresh run supersedes any run still recorded as active.
    pub fn run_started(
        &self,
        client_id: &str,
        workflow_id: &str,
        workflow_name: &str,
        tab_id: &str,
        total: usize,
    ) {
        let mut clients = self.lock();
        let state = clients.entry(client_id.to_string()).or_default();
        state.run = Some(WorkflowRun {
            workflow_id: workflow_id.to_string(),
            workflow_name: workflow_name.to_string(),
            tab_id: tab_id.to_string(),
            total,
            completed: 0,
        });
        state.output = None;
    }

    /// `workflow.stepAdvanced` — record run progress. Updates `completed` only
    /// when the active run still matches the reported `workflow_id` and
    /// `tab_id` (mirroring `appStore`'s `onProgress` guard, which ignores
    /// progress from a run a newer `runStarted` has replaced). A no-op when no
    /// run is active or the ids do not match.
    pub fn step_advanced(
        &self,
        client_id: &str,
        workflow_id: &str,
        tab_id: &str,
        completed: usize,
    ) {
        let mut clients = self.lock();
        let Some(state) = clients.get_mut(client_id) else {
            return;
        };
        let Some(run) = state.run.as_mut() else {
            return;
        };
        if run.workflow_id == workflow_id && run.tab_id == tab_id {
            run.completed = completed;
        }
    }

    /// `workflow.outputOpened` — open the inline run-output panel a
    /// `run-local-process` step spawns, in the non-terminal `running` status
    /// (mirroring `appStore`, which sets `workflowRunOutput` with
    /// `status: "running"` when a local process starts). A fresh spawn owns the
    /// panel: it replaces any prior panel's identity and resets its status. The
    /// streamed lines / exit code / timeout stay frontend (see module docs).
    ///
    /// Modeled here because the panel's *status* is run status; the run's
    /// terminal intent later stamps [`RunOutcome`] onto it, and `dismissOutput`
    /// clears it.
    pub fn output_opened(
        &self,
        client_id: &str,
        workflow_id: &str,
        workflow_name: &str,
        program: &str,
        args: &[String],
    ) {
        let mut clients = self.lock();
        let state = clients.entry(client_id.to_string()).or_default();
        state.output = Some(WorkflowRunOutput {
            workflow_id: workflow_id.to_string(),
            workflow_name: workflow_name.to_string(),
            program: program.to_string(),
            args: args.to_vec(),
            outcome: None,
            error: None,
        });
    }

    /// `workflow.runCompleted` — settle the active run as completed.
    pub fn run_completed(&self, client_id: &str) {
        self.finish_run(client_id, RunOutcome::Completed, None);
    }

    /// `workflow.runCancelled` — settle the active run as cancelled.
    pub fn run_cancelled(&self, client_id: &str) {
        self.finish_run(client_id, RunOutcome::Cancelled, None);
    }

    /// `workflow.runFailed` — settle the active run as failed, recording the
    /// failure reason (stamped onto the output panel when one is open).
    pub fn run_failed(&self, client_id: &str, error: Option<String>) {
        self.finish_run(client_id, RunOutcome::Failed, error);
    }

    /// Settle the active run with a terminal outcome: clear the run and stamp
    /// the outcome (and any error) onto the output panel when one is open —
    /// mirroring `appStore`, which nulls `workflowRun` and stamps
    /// `workflowRunOutput.status` in the same update, but only for the run still
    /// current. Idempotent when no run is active: a stray terminal intent
    /// leaves the panel's status untouched (the panel keeps its prior status).
    fn finish_run(&self, client_id: &str, outcome: RunOutcome, error: Option<String>) {
        let mut clients = self.lock();
        let Some(state) = clients.get_mut(client_id) else {
            return;
        };
        // No active run → nothing to settle; leave the output panel as-is,
        // matching appStore's `activeWorkflowRun === handle` guard.
        if state.run.take().is_none() {
            return;
        }
        if let Some(output) = state.output.as_mut() {
            output.outcome = Some(outcome);
            output.error = if outcome == RunOutcome::Failed {
                error
            } else {
                None
            };
        }
    }

    /// `workflow.dismissOutput` — dismiss the inline output panel (mirroring
    /// `appStore.dismissWorkflowRunOutput`). A no-op when no panel is open.
    pub fn dismiss_output(&self, client_id: &str) {
        let mut clients = self.lock();
        if let Some(state) = clients.get_mut(client_id) {
            state.output = None;
        }
    }

    /// Read a client's active-run tallies (test/diagnostics helper):
    /// `(total, completed)`.
    #[cfg(test)]
    pub fn run_progress(&self, client_id: &str) -> Option<(usize, usize)> {
        self.lock()
            .get(client_id)
            .and_then(|s| s.run.as_ref())
            .map(|r| (r.total, r.completed))
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, ClientState>> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.clients.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
