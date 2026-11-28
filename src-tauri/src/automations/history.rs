//! The automation run-history model and the pure legacy run converters
//! (#5818, slice 2).
//!
//! An [`AutomationRun`] is the workflow run record plus the two fields only
//! macro playbacks had (`targetCount`, `targetLabels`). Status keeps the wire
//! values `completed` / `cancelled` / `failed` (a macro `error` becomes
//! `failed`), and the origin joins the workflow trigger kinds with the macro
//! origins (`workflow-step` becomes `run-by-automation`).

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::macros::history::{MacroRun, MacroRunOrigin, MacroRunStatus};
use crate::workflows::history::{WorkflowRun, WorkflowRunStatus, WorkflowRunTrigger};

/// The most-recent runs retained on disk.
pub const MAX_AUTOMATION_RUNS: usize = 200;

/// Runs that ended longer ago than this many days are dropped.
pub const MAX_AUTOMATION_RUN_AGE_DAYS: i64 = 90;

/// The terminal state a run ended in.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "kebab-case")]
pub enum AutomationRunStatus {
    /// Every step ran to completion.
    Completed,
    /// The run was cancelled before all steps finished.
    Cancelled,
    /// A step failed (or the target stopped accepting input) and the run
    /// stopped.
    Failed,
}

/// What launched the run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "kebab-case")]
pub enum AutomationRunOrigin {
    /// Run from the sidebar, a toolbar button or a dialog.
    Manual,
    /// Run from the command palette.
    Palette,
    /// Fired by a hotkey trigger.
    Hotkey,
    /// Fired by an on-connect trigger.
    OnConnect,
    /// Fired by an on-disconnect trigger.
    OnDisconnect,
    /// Fired by an on-output-match trigger.
    OnOutputMatch,
    /// Fired by a schedule.
    Scheduled,
    /// Run by another automation's `run-automation` step.
    RunByAutomation,
}

/// One persisted, metadata-only record of a finished run on one terminal.
/// Never stores the typed input or the terminal output.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    /// Unique identifier for this run record (legacy run ids are kept, so
    /// schedule history links keep resolving).
    pub id: String,
    /// The id of the automation that ran.
    pub automation_id: String,
    /// The automation's name at run time.
    pub automation_name: String,
    /// RFC 3339 timestamp of when the run started.
    pub started_at: String,
    /// RFC 3339 timestamp of when the run reached its terminal state.
    pub ended_at: String,
    /// The terminal state the run ended in.
    pub status: AutomationRunStatus,
    /// Steps that completed before the run ended.
    pub steps_completed: u32,
    /// Total number of steps.
    pub total: u32,
    /// For a failed run: the 0-based index of the step that failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub failed_step_index: Option<u32>,
    /// For a cancelled or failed run: a human-readable reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub error: Option<String>,
    /// Step failures tolerated via `continueOnError`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub continued_failures: Option<u32>,
    /// The terminal tab the run targeted, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub tab_id: Option<String>,
    /// Display label (tab title) of the terminal the run targeted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub target_label: Option<String>,
    /// Number of terminals a migrated macro playback typed into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub target_count: Option<u32>,
    /// Labels of the terminals a migrated macro playback typed into.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<String>>", optional))]
    pub target_labels: Vec<String>,
    /// What launched the run.
    pub origin: AutomationRunOrigin,
    /// For a run another automation started: the id of that automation's run,
    /// so the history can link to it (#6183).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub started_by_run_id: Option<String>,
    /// For a run another automation started: that automation's name at run time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub started_by_name: Option<String>,
}

/// What the migration last saw of one legacy run-history file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRunsRecord {
    /// SHA-256 (hex) of the file's bytes; empty when the file was absent.
    #[serde(default)]
    pub sha256: String,
    /// The run ids the file held at that time (already merged).
    #[serde(default)]
    pub run_ids: Vec<String>,
}

/// Top-level schema for `automation-runs.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunHistoryStore {
    /// Schema version, read on load and gated by the migration layer.
    pub version: String,
    /// All recorded runs, oldest first (append order).
    pub runs: Vec<AutomationRun>,
    /// What the boot migration last merged from each legacy run file, keyed
    /// by file name (`macro-runs.json`, `runs.json`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub migrated_from: BTreeMap<String, LegacyRunsRecord>,
    /// Unknown top-level keys, preserved verbatim (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl AutomationRunHistoryStore {
    /// The schema version this build reads and writes.
    pub const CURRENT_VERSION: u32 = 1;
    /// The store's file name in the config directory.
    pub const FILE_NAME: &'static str = "automation-runs.json";
}

impl Default for AutomationRunHistoryStore {
    fn default() -> Self {
        Self {
            version: Self::CURRENT_VERSION.to_string(),
            runs: Vec::new(),
            migrated_from: BTreeMap::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl crate::utils::migrate::VersionedStore for AutomationRunHistoryStore {
    const STORE_NAME: &'static str = AutomationRunHistoryStore::FILE_NAME;
    const CURRENT_VERSION: u32 = AutomationRunHistoryStore::CURRENT_VERSION;

    fn salvage(value: serde_json::Value, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, AutomationRun>(value, file_name, "runs")
    }
}

/// Convert one macro playback record. `macro_ids` maps a legacy macro id to
/// the id of the automation it became (only ids that changed need an entry).
pub fn from_macro_run(run: &MacroRun, macro_ids: &HashMap<String, String>) -> AutomationRun {
    AutomationRun {
        id: run.id.clone(),
        automation_id: macro_ids
            .get(&run.macro_id)
            .cloned()
            .unwrap_or_else(|| run.macro_id.clone()),
        automation_name: run.macro_name.clone(),
        started_at: run.started_at.clone(),
        ended_at: run.ended_at.clone(),
        status: match run.status {
            MacroRunStatus::Completed => AutomationRunStatus::Completed,
            MacroRunStatus::Cancelled => AutomationRunStatus::Cancelled,
            MacroRunStatus::Error => AutomationRunStatus::Failed,
        },
        steps_completed: run.steps_played,
        total: run.total_steps,
        failed_step_index: None,
        error: run.error.clone(),
        continued_failures: None,
        tab_id: None,
        target_label: (run.target_labels.len() == 1).then(|| run.target_labels[0].clone()),
        target_count: Some(run.target_count),
        target_labels: run.target_labels.clone(),
        origin: match run.origin {
            MacroRunOrigin::Manual => AutomationRunOrigin::Manual,
            MacroRunOrigin::Palette => AutomationRunOrigin::Palette,
            MacroRunOrigin::WorkflowStep => AutomationRunOrigin::RunByAutomation,
            MacroRunOrigin::Scheduled => AutomationRunOrigin::Scheduled,
        },
        started_by_run_id: None,
        started_by_name: None,
    }
}

/// Convert one workflow run record. Workflow ids never change in the
/// conversion (workflows claim their ids first), so no map is needed.
pub fn from_workflow_run(run: &WorkflowRun) -> AutomationRun {
    AutomationRun {
        id: run.id.clone(),
        automation_id: run.workflow_id.clone(),
        automation_name: run.workflow_name.clone(),
        started_at: run.started_at.clone(),
        ended_at: run.ended_at.clone(),
        status: match run.status {
            WorkflowRunStatus::Completed => AutomationRunStatus::Completed,
            WorkflowRunStatus::Cancelled => AutomationRunStatus::Cancelled,
            WorkflowRunStatus::Failed => AutomationRunStatus::Failed,
        },
        steps_completed: run.steps_completed,
        total: run.total,
        failed_step_index: run.failed_step_index,
        error: run.error.clone(),
        continued_failures: run.continued_failures,
        tab_id: run.tab_id.clone(),
        target_label: run.target_label.clone(),
        target_count: None,
        target_labels: Vec::new(),
        origin: match run.triggered_by {
            WorkflowRunTrigger::Manual => AutomationRunOrigin::Manual,
            WorkflowRunTrigger::OnConnect => AutomationRunOrigin::OnConnect,
            WorkflowRunTrigger::Hotkey => AutomationRunOrigin::Hotkey,
            WorkflowRunTrigger::Scheduled => AutomationRunOrigin::Scheduled,
            WorkflowRunTrigger::OnDisconnect => AutomationRunOrigin::OnDisconnect,
            WorkflowRunTrigger::OnOutputMatch => AutomationRunOrigin::OnOutputMatch,
        },
        started_by_run_id: None,
        started_by_name: None,
    }
}

/// Union both legacy histories into one, oldest first: a stable merge by
/// `startedAt` (macro records before workflow records on a tie), then the
/// retention rules of [`apply_retention`].
pub fn merge_runs(
    macro_runs: &[MacroRun],
    workflow_runs: &[WorkflowRun],
    macro_ids: &HashMap<String, String>,
    now: DateTime<Utc>,
) -> Vec<AutomationRun> {
    let mut runs: Vec<AutomationRun> = macro_runs
        .iter()
        .map(|r| from_macro_run(r, macro_ids))
        .chain(workflow_runs.iter().map(from_workflow_run))
        .collect();
    sort_oldest_first(&mut runs);
    apply_retention(&mut runs, now);
    runs
}

/// Stable sort by `startedAt`. A timestamp that does not parse sorts as the
/// oldest, so it is the first to go when the count cap applies.
pub fn sort_oldest_first(runs: &mut [AutomationRun]) {
    runs.sort_by_key(|r| parse_time(&r.started_at));
}

/// Drop runs that ended more than [`MAX_AUTOMATION_RUN_AGE_DAYS`] before
/// `now` (a record whose `endedAt` does not parse is kept), then keep only
/// the newest [`MAX_AUTOMATION_RUNS`]. `runs` must be oldest first.
pub fn apply_retention(runs: &mut Vec<AutomationRun>, now: DateTime<Utc>) {
    let cutoff = now - Duration::days(MAX_AUTOMATION_RUN_AGE_DAYS);
    runs.retain(|r| parse_time(&r.ended_at).is_none_or(|ended| ended >= cutoff));
    if runs.len() > MAX_AUTOMATION_RUNS {
        let overflow = runs.len() - MAX_AUTOMATION_RUNS;
        runs.drain(0..overflow);
    }
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}
