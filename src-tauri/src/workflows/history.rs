use serde::{Deserialize, Serialize};

/// The terminal state a workflow run ended in. Mirrors the frontend
/// `WorkflowRunStatus` (and the runner's own `"completed" | "cancelled" |
/// "failed"` union) so the persisted record matches the run outcome over the
/// wire.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowRunStatus {
    /// Every step ran to completion.
    Completed,
    /// The run was cancelled before all steps finished.
    Cancelled,
    /// A step failed and the run stopped.
    Failed,
}

/// What launched the run. Mirrors the frontend `WorkflowRunTrigger`; the
/// variant names are the same kebab-case strings the trigger union uses.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowRunTrigger {
    /// Run from the palette, the Workflow sidebar, or a toolbar button.
    Manual,
    /// Fired by an on-connect trigger when a bound connection's session opened.
    OnConnect,
    /// Fired by a user-assigned keybinding.
    Hotkey,
}

/// A single persisted, **metadata-only** record of a finished workflow run
/// (PROD-0046). Deliberately does not store the run's terminal output — only the
/// outcome, timing, and provenance needed to browse recent runs.
///
/// The tag-less enums serialize as plain strings and every struct field is
/// camelCase, so the JSON shape matches the TypeScript `WorkflowRun` type
/// exactly (mirroring [`crate::workflows::config::Workflow`]'s serde
/// conventions).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    /// Unique identifier for this run record.
    pub id: String,
    /// The id of the workflow that was run.
    pub workflow_id: String,
    /// The workflow's name at run time (denormalized so history survives a
    /// later rename or deletion of the workflow).
    pub workflow_name: String,
    /// RFC 3339 timestamp of when the run started.
    pub started_at: String,
    /// RFC 3339 timestamp of when the run reached its terminal state.
    pub ended_at: String,
    /// The terminal state the run ended in.
    pub status: WorkflowRunStatus,
    /// Number of steps that completed successfully before the run ended.
    pub steps_completed: u32,
    /// Total number of steps in the workflow.
    pub total: u32,
    /// For a failed run: the 0-based index of the step that failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_step_index: Option<u32>,
    /// For a failed run: a human-readable failure reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Number of step failures tolerated via `continueOnError` (PROD-045).
    /// Omitted when none were tolerated, so older records round-trip unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued_failures: Option<u32>,
    /// The terminal tab the run targeted, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// What launched the run.
    pub triggered_by: WorkflowRunTrigger,
}

/// Top-level schema for the `runs.json` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRunHistoryStore {
    /// Schema version, read on load and gated by the migration layer.
    pub version: String,
    /// All recorded runs, oldest first (append order). Displayed newest-first.
    pub runs: Vec<WorkflowRun>,
    /// Unknown top-level keys, captured verbatim so an older app preserves
    /// fields a newer version added rather than dropping them on save (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for WorkflowRunHistoryStore {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            runs: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl crate::utils::migrate::VersionedStore for WorkflowRunHistoryStore {
    const STORE_NAME: &'static str = "runs.json";
    const CURRENT_VERSION: u32 = 1;

    /// Per-entry salvage (PER-004): drop only the individually-corrupt run
    /// records instead of resetting the whole browsable history.
    fn salvage(raw: &str, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, WorkflowRun>(raw, file_name, "runs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_run(id: &str) -> WorkflowRun {
        WorkflowRun {
            id: id.to_string(),
            workflow_id: "wf-1".to_string(),
            workflow_name: "Prod login".to_string(),
            started_at: "2026-09-20T00:00:00Z".to_string(),
            ended_at: "2026-09-20T00:00:05Z".to_string(),
            status: WorkflowRunStatus::Completed,
            steps_completed: 3,
            total: 3,
            failed_step_index: None,
            error: None,
            continued_failures: None,
            tab_id: Some("tab-1".to_string()),
            triggered_by: WorkflowRunTrigger::Manual,
        }
    }

    #[test]
    fn store_default_is_empty() {
        let store = WorkflowRunHistoryStore::default();
        assert_eq!(store.version, "1");
        assert!(store.runs.is_empty());
    }

    #[test]
    fn run_serializes_with_camel_case_keys_and_string_enums() {
        let run = sample_run("run-1");
        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("\"workflowId\":\"wf-1\""));
        assert!(json.contains("\"workflowName\":\"Prod login\""));
        assert!(json.contains("\"startedAt\""));
        assert!(json.contains("\"endedAt\""));
        assert!(json.contains("\"stepsCompleted\":3"));
        assert!(json.contains("\"status\":\"completed\""));
        assert!(json.contains("\"triggeredBy\":\"manual\""));
        assert!(json.contains("\"tabId\":\"tab-1\""));
        // Absent optionals are omitted.
        assert!(!json.contains("failedStepIndex"));
        assert!(!json.contains("\"error\""));

        let parsed: WorkflowRun = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, run);
    }

    #[test]
    fn failed_run_round_trips_with_index_and_error() {
        let run = WorkflowRun {
            status: WorkflowRunStatus::Failed,
            steps_completed: 1,
            failed_step_index: Some(1),
            error: Some("step blew up".to_string()),
            triggered_by: WorkflowRunTrigger::OnConnect,
            ..sample_run("run-fail")
        };
        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("\"status\":\"failed\""));
        assert!(json.contains("\"failedStepIndex\":1"));
        assert!(json.contains("\"triggeredBy\":\"on-connect\""));
        let parsed: WorkflowRun = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, run);
    }

    #[test]
    fn continued_failures_round_trip_and_are_omitted_when_absent() {
        let run = WorkflowRun {
            continued_failures: Some(2),
            ..sample_run("run-soft")
        };
        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("\"continuedFailures\":2"));
        let parsed: WorkflowRun = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, run);

        let plain = serde_json::to_string(&sample_run("run-plain")).unwrap();
        assert!(!plain.contains("continuedFailures"));
    }

    #[test]
    fn all_status_and_trigger_kinds_round_trip() {
        for status in [
            WorkflowRunStatus::Completed,
            WorkflowRunStatus::Cancelled,
            WorkflowRunStatus::Failed,
        ] {
            let json = serde_json::to_string(&status).unwrap();
            let parsed: WorkflowRunStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, status);
        }
        for trigger in [
            WorkflowRunTrigger::Manual,
            WorkflowRunTrigger::OnConnect,
            WorkflowRunTrigger::Hotkey,
        ] {
            let json = serde_json::to_string(&trigger).unwrap();
            let parsed: WorkflowRunTrigger = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, trigger);
        }
        assert_eq!(
            serde_json::to_string(&WorkflowRunTrigger::Hotkey).unwrap(),
            "\"hotkey\""
        );
    }

    #[test]
    fn run_defaults_absent_optionals_on_parse() {
        // A minimal record (no optionals) parses with them defaulted to None.
        let raw = r#"{
            "id": "r",
            "workflowId": "wf",
            "workflowName": "n",
            "startedAt": "2026-09-20T00:00:00Z",
            "endedAt": "2026-09-20T00:00:01Z",
            "status": "cancelled",
            "stepsCompleted": 0,
            "total": 2,
            "triggeredBy": "hotkey"
        }"#;
        let run: WorkflowRun = serde_json::from_str(raw).unwrap();
        assert_eq!(run.status, WorkflowRunStatus::Cancelled);
        assert_eq!(run.failed_step_index, None);
        assert_eq!(run.error, None);
        assert_eq!(run.tab_id, None);
        assert_eq!(run.triggered_by, WorkflowRunTrigger::Hotkey);
    }
}
