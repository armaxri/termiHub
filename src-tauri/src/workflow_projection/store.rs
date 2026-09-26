//! The authoritative, client-scoped workflow-run state machine behind the
//! `workflow-run@<clientId>` region (#2243, Phase 4 step 5c of #2139).
//!
//! Models the in-flight workflow run the frontend currently drives (`appStore`
//! `workflowRun` + `workflowRunOutput`, #1852 / #1865): the in-flight runs per
//! client (several at once since #3418, keyed by `runId`), each advancing step
//! by step and settling on a terminal outcome, plus
//! the dismissible inline output panel a `run-local-process` step opens. This
//! module owns only the run **status** per client — not the workflow library
//! (already backend-backed via `workflowApi`), and not the step side-effects.
//!
//! # Client-scoped — Open Design Decision #4 / #6
//!
//! A run belongs to the client that launched it: that client picks the target
//! terminal(s), sees the progress toast, and owns the output panel. Since #3418
//! a client may have several runs in flight at once (a "Run on…" fan-out runs
//! the workflow concurrently on several terminals), keyed by `runId`; a legacy
//! `runStarted` without a `runId` still supersedes every in-flight run. It is a property of the launching client, not of shared
//! infrastructure, so the store keys everything by `clientId` and projects one
//! `workflow-run@<clientId>` region per client — mirroring `restore-cohort`,
//! `broadcast`, and `layout`.
//!
//! # Authoritative — drives the live UI (#2243)
//!
//! The stateless-UI inversion is complete (#2283): this store is authoritative —
//! the UI renders the run status from the projected region and dispatches the
//! `workflow.*` intents. The former `appStore` run reducers and the
//! render/mutation-cut flags were removed; `appStore` holds no workflow-run slice
//! and the intents are the sole write path.
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

/// The id a run started without an explicit `runId` is keyed under (the
/// pre-#3418 single-run intents). A legacy start supersedes every run, so at
/// most one run ever carries it.
const LEGACY_RUN_ID: &str = "legacy";

/// One in-flight run's step-progress metadata (`appStore` `WorkflowRunState`),
/// keyed by its `run_id` (#3418: several runs may be in flight at once).
#[derive(Clone, Debug, PartialEq)]
struct WorkflowRun {
    run_id: String,
    workflow_id: String,
    workflow_name: String,
    tab_id: String,
    /// A human-readable label for the target (e.g. the terminal's title), so
    /// the per-target progress list can name each run. `None` when not given.
    label: Option<String>,
    total: usize,
    completed: usize,
}

impl WorkflowRun {
    fn to_view(&self) -> Value {
        json!({
            "runId": self.run_id,
            "workflowId": self.workflow_id,
            "workflowName": self.workflow_name,
            "tabId": self.tab_id,
            "label": self.label,
            "total": self.total,
            "completed": self.completed,
        })
    }
}

/// Everything `workflow.runStarted` carries (#3418 keyed shape).
#[derive(Clone, Debug, Default)]
pub struct RunStart {
    /// The run's id. `None` is the legacy single-run start: it supersedes every
    /// in-flight run and is keyed under an internal legacy id.
    pub run_id: Option<String>,
    /// The workflow being run.
    pub workflow_id: String,
    /// The workflow's name, for the progress indicator.
    pub workflow_name: String,
    /// The terminal tab the run targets.
    pub tab_id: String,
    /// An optional label naming the target in the per-target list.
    pub label: Option<String>,
    /// The workflow's step count.
    pub total: usize,
    /// Keep the current output panel instead of clearing it (a target of a
    /// concurrent fan-out must not wipe a sibling target's panel).
    pub preserve_output: bool,
}

/// The inline run-output panel a `run-local-process` step opens (`appStore`
/// `WorkflowRunOutputState`). The store owns its *status* lifecycle; the
/// streamed lines / exit code / timeout stay frontend (see the module docs).
#[derive(Clone, Debug, PartialEq)]
struct WorkflowRunOutput {
    /// The run whose local process opened the panel; `None` for a legacy
    /// (un-keyed) open, which any settling run stamps.
    run_id: Option<String>,
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
            "runId": self.run_id,
            "workflowId": self.workflow_id,
            "workflowName": self.workflow_name,
            "program": self.program,
            "args": self.args,
            "status": status,
            "error": self.error,
        })
    }

    fn stamp(&mut self, outcome: RunOutcome, error: Option<String>) {
        self.outcome = Some(outcome);
        self.error = if outcome == RunOutcome::Failed {
            error
        } else {
            None
        };
    }
}

/// One client's workflow-run state.
#[derive(Clone, Debug, Default)]
struct ClientState {
    /// The in-flight runs, in start order (#3418). Empty when nothing runs.
    runs: Vec<WorkflowRun>,
    /// The inline output panel, or `None` when no local process has opened one
    /// (or it was dismissed / superseded).
    output: Option<WorkflowRunOutput>,
}

impl ClientState {
    /// The complete render-ready view model for this client's region.
    ///
    /// `runs` is the keyed list of every in-flight run (#3418). `run` is kept
    /// for back-compat with single-run consumers: the most recently started
    /// in-flight run, or `null`.
    fn to_view(&self) -> Value {
        json!({
            "run": self.runs.last().map(WorkflowRun::to_view),
            "runs": self.runs.iter().map(WorkflowRun::to_view).collect::<Vec<_>>(),
            "output": self.output.as_ref().map(WorkflowRunOutput::to_view),
        })
    }
}

/// The workflow-run authority. Owns one [`ClientState`] per attached
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
    /// unknown): `{ run, runs, output }`.
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

    /// Legacy single-run `workflow.runStarted` (no `runId`): supersedes every
    /// in-flight run and clears the output panel. See [`Self::start_run`].
    pub fn run_started(
        &self,
        client_id: &str,
        workflow_id: &str,
        workflow_name: &str,
        tab_id: &str,
        total: usize,
    ) {
        self.start_run(
            client_id,
            RunStart {
                run_id: None,
                workflow_id: workflow_id.to_string(),
                workflow_name: workflow_name.to_string(),
                tab_id: tab_id.to_string(),
                label: None,
                total,
                preserve_output: false,
            },
        );
    }

    /// `workflow.runStarted` — begin a run against a target terminal at
    /// `completed == 0`.
    ///
    /// - **Keyed** (`run_id` set, #3418): the run joins the in-flight set
    ///   alongside any others; restarting an id already in flight replaces it
    ///   in place.
    /// - **Legacy** (no `run_id`): a fresh run supersedes every in-flight run
    ///   (the pre-#3418 single-run contract).
    ///
    /// Unless `preserve_output` is set, the prior output panel is cleared
    /// (mirroring `appStore`, which nulls `workflowRunOutput` on a fresh run —
    /// the panel is recreated lazily only if this run spawns a local process).
    pub fn start_run(&self, client_id: &str, start: RunStart) {
        let mut clients = self.lock();
        let state = clients.entry(client_id.to_string()).or_default();
        let legacy = start.run_id.is_none();
        let run = WorkflowRun {
            run_id: start.run_id.unwrap_or_else(|| LEGACY_RUN_ID.to_string()),
            workflow_id: start.workflow_id,
            workflow_name: start.workflow_name,
            tab_id: start.tab_id,
            label: start.label,
            total: start.total,
            completed: 0,
        };
        if legacy {
            state.runs.clear();
            state.runs.push(run);
        } else if let Some(existing) = state.runs.iter_mut().find(|r| r.run_id == run.run_id) {
            *existing = run;
        } else {
            state.runs.push(run);
        }
        if !start.preserve_output {
            state.output = None;
        }
    }

    /// Legacy `workflow.stepAdvanced` (no `runId`): update `completed` on every
    /// in-flight run matching `workflow_id` and `tab_id` (mirroring `appStore`'s
    /// `onProgress` guard, which ignores progress from a run a newer
    /// `runStarted` has replaced). A no-op when nothing matches.
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
        for run in state
            .runs
            .iter_mut()
            .filter(|r| r.workflow_id == workflow_id && r.tab_id == tab_id)
        {
            run.completed = completed;
        }
    }

    /// Keyed `workflow.stepAdvanced` (#3418): update `completed` on the run
    /// `run_id`. A no-op when that run is not in flight (already settled or
    /// superseded).
    pub fn run_step_advanced(&self, client_id: &str, run_id: &str, completed: usize) {
        let mut clients = self.lock();
        let Some(state) = clients.get_mut(client_id) else {
            return;
        };
        if let Some(run) = state.runs.iter_mut().find(|r| r.run_id == run_id) {
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
    /// `run_id` names the run that owns the panel (#3418), so only that run's
    /// settle stamps its outcome; `None` is the legacy un-keyed open.
    pub fn output_opened(
        &self,
        client_id: &str,
        run_id: Option<&str>,
        workflow_id: &str,
        workflow_name: &str,
        program: &str,
        args: &[String],
    ) {
        let mut clients = self.lock();
        let state = clients.entry(client_id.to_string()).or_default();
        state.output = Some(WorkflowRunOutput {
            run_id: run_id.map(str::to_string),
            workflow_id: workflow_id.to_string(),
            workflow_name: workflow_name.to_string(),
            program: program.to_string(),
            args: args.to_vec(),
            outcome: None,
            error: None,
        });
    }

    /// `workflow.runCompleted` — settle a run (or, with no `run_id`, every
    /// in-flight run) as completed.
    pub fn run_completed(&self, client_id: &str, run_id: Option<&str>) {
        self.finish_run(client_id, run_id, RunOutcome::Completed, None);
    }

    /// `workflow.runCancelled` — settle a run (or every run) as cancelled.
    pub fn run_cancelled(&self, client_id: &str, run_id: Option<&str>) {
        self.finish_run(client_id, run_id, RunOutcome::Cancelled, None);
    }

    /// `workflow.runFailed` — settle a run (or every run) as failed, recording
    /// the failure reason (stamped onto the output panel when it owns one).
    pub fn run_failed(&self, client_id: &str, run_id: Option<&str>, error: Option<String>) {
        self.finish_run(client_id, run_id, RunOutcome::Failed, error);
    }

    /// Settle with a terminal outcome: remove the run `run_id` (or, legacy, every
    /// in-flight run) and stamp the outcome onto the output panel when the
    /// settled run owns it (or the panel is an un-keyed legacy one) — mirroring
    /// `appStore`, which nulls `workflowRun` and stamps `workflowRunOutput.status`
    /// in the same update, but only for the run still current. Idempotent when
    /// the run is not in flight: a stray terminal intent leaves the panel's
    /// status untouched.
    fn finish_run(
        &self,
        client_id: &str,
        run_id: Option<&str>,
        outcome: RunOutcome,
        error: Option<String>,
    ) {
        let mut clients = self.lock();
        let Some(state) = clients.get_mut(client_id) else {
            return;
        };
        let settled: Vec<String> = match run_id {
            Some(id) => {
                let before = state.runs.len();
                state.runs.retain(|r| r.run_id != id);
                if state.runs.len() == before {
                    Vec::new()
                } else {
                    vec![id.to_string()]
                }
            }
            None => state.runs.drain(..).map(|r| r.run_id).collect(),
        };
        // Nothing settled → leave the output panel as-is, matching appStore's
        // `activeWorkflowRun === handle` guard.
        if settled.is_empty() {
            return;
        }
        if let Some(output) = state.output.as_mut() {
            let owned = match output.run_id.as_deref() {
                None => true,
                Some(owner) => settled.iter().any(|id| id == owner),
            };
            if owned {
                output.stamp(outcome, error);
            }
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

    /// Read a client's most recently started run's tallies (test/diagnostics
    /// helper): `(total, completed)`.
    #[cfg(test)]
    pub fn run_progress(&self, client_id: &str) -> Option<(usize, usize)> {
        self.lock()
            .get(client_id)
            .and_then(|s| s.runs.last())
            .map(|r| (r.total, r.completed))
    }

    /// Read one keyed run's tallies (test helper): `(total, completed)`.
    #[cfg(test)]
    pub fn keyed_run_progress(&self, client_id: &str, run_id: &str) -> Option<(usize, usize)> {
        self.lock()
            .get(client_id)
            .and_then(|s| s.runs.iter().find(|r| r.run_id == run_id))
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
