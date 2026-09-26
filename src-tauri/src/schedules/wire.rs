//! Wire types of the scheduler (PROD-043) and the pure helpers that validate
//! editor input and fold window reports into a recorded result.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::config::{
    MissedRunPolicy, Schedule, ScheduleAction, ScheduleRule, ScheduleRunOutcome, ScheduleRunResult,
    ScheduleTargets,
};
use super::timing::validate_rule;
use crate::utils::errors::TerminalError;

/// Longest accepted schedule name, in characters.
pub const MAX_NAME_CHARS: usize = 120;

/// The payload of the `schedule-fire` event: run `action` on `targets`, then
/// report back with `token`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleFire {
    /// Correlates the windows' reports with this run.
    pub token: String,
    /// The schedule that fired.
    pub schedule_id: String,
    /// Its name (for the toast and logs).
    pub schedule_name: String,
    /// What to run.
    pub action: ScheduleAction,
    /// Where to run it.
    pub targets: ScheduleTargets,
    /// `true` when this is a catch-up for a missed slot.
    pub catch_up: bool,
}

/// One window's report of a fired run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowRunReport {
    /// How the run ended in that window (`skipped` = nothing ran there).
    pub outcome: ScheduleRunOutcome,
    /// Detail: the skip reason or the failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Terminals the run was started on in that window.
    #[serde(default)]
    pub targets_run: u32,
}

/// A schedule plus its live scheduling state, as the UI shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    /// The stored schedule.
    #[serde(flatten)]
    pub schedule: Schedule,
    /// RFC 3339 time of the next run (enabled schedules only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    /// Whether a fired run is still in flight.
    pub running: bool,
}

/// The whole scheduler state, as the UI shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerState {
    /// The global pause switch.
    pub paused: bool,
    /// Every schedule, in stored order.
    pub schedules: Vec<ScheduleView>,
}

/// The user-editable part of a schedule, sent by the editor.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInput {
    /// Existing id to update, or a fresh id for a new schedule (empty → one
    /// is generated).
    #[serde(default)]
    pub id: String,
    /// Name.
    pub name: String,
    /// What to run.
    pub action: ScheduleAction,
    /// Where to run it.
    pub targets: ScheduleTargets,
    /// When to run it.
    pub rule: ScheduleRule,
    /// Missed-run policy (default: skip).
    #[serde(default)]
    pub missed_runs: MissedRunPolicy,
}

/// What a tick decided.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TickResult {
    /// Runs to emit to the windows.
    pub fires: Vec<ScheduleFire>,
    /// Whether any schedule's visible state changed (emit `schedules-changed`).
    pub changed: bool,
}

pub(crate) fn err(msg: impl Into<String>) -> TerminalError {
    TerminalError::WorkflowError(msg.into())
}

pub(crate) fn validate_input(input: &ScheduleInput) -> Result<(), TerminalError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(err("Give the schedule a name"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(err(format!(
            "Schedule names are at most {MAX_NAME_CHARS} characters"
        )));
    }
    match &input.action {
        ScheduleAction::Workflow { workflow_id } if workflow_id.trim().is_empty() => {
            return Err(err("Pick a workflow to run"));
        }
        ScheduleAction::Macro { macro_id } if macro_id.trim().is_empty() => {
            return Err(err("Pick a macro to run"));
        }
        _ => {}
    }
    match &input.targets {
        ScheduleTargets::Connections { connection_ids }
            if connection_ids.iter().all(|c| c.trim().is_empty()) =>
        {
            return Err(err("Pick at least one saved connection to run on"));
        }
        ScheduleTargets::BroadcastGroup { group_id } if group_id.trim().is_empty() => {
            return Err(err("Pick a broadcast group to run on"));
        }
        _ => {}
    }
    validate_rule(&input.rule).map_err(err)
}

/// Fold the windows' reports into the run's recorded result.
pub(crate) fn aggregate(
    reports: &[WindowRunReport],
    catch_up: bool,
    at: DateTime<Utc>,
) -> ScheduleRunResult {
    let ran: Vec<&WindowRunReport> = reports
        .iter()
        .filter(|r| r.outcome != ScheduleRunOutcome::Skipped)
        .collect();
    let (outcome, message) = if ran.is_empty() {
        let mut reasons: Vec<String> = Vec::new();
        for r in reports {
            if let Some(m) = &r.message {
                if !reasons.contains(m) {
                    reasons.push(m.clone());
                }
            }
        }
        let message = if reasons.is_empty() {
            "No app window ran the schedule".to_string()
        } else {
            reasons.join("; ")
        };
        (ScheduleRunOutcome::Skipped, Some(message))
    } else {
        let targets: u32 = ran.iter().map(|r| r.targets_run).sum();
        let summary = format!(
            "Ran on {targets} terminal{}",
            if targets == 1 { "" } else { "s" }
        );
        let worst = |o: ScheduleRunOutcome| ran.iter().find(|r| r.outcome == o);
        if let Some(failed) = worst(ScheduleRunOutcome::Failed) {
            let detail = failed
                .message
                .clone()
                .unwrap_or_else(|| "a run failed".into());
            (
                ScheduleRunOutcome::Failed,
                Some(format!("{summary}: {detail}")),
            )
        } else if worst(ScheduleRunOutcome::Cancelled).is_some() {
            (
                ScheduleRunOutcome::Cancelled,
                Some(format!("{summary}: cancelled")),
            )
        } else {
            (ScheduleRunOutcome::Completed, Some(summary))
        }
    };
    ScheduleRunResult {
        at: at.to_rfc3339(),
        outcome,
        message,
        catch_up,
    }
}

pub(crate) fn skipped(
    at: DateTime<Utc>,
    message: impl Into<String>,
    catch_up: bool,
) -> ScheduleRunResult {
    ScheduleRunResult {
        at: at.to_rfc3339(),
        outcome: ScheduleRunOutcome::Skipped,
        message: Some(message.into()),
        catch_up,
    }
}
