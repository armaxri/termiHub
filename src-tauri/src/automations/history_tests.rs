//! Run-history model, merge, retention and manager tests (#5818, slice 2).

use std::collections::HashMap;
use std::fs;

use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use tempfile::TempDir;

use super::history::{
    from_macro_run, from_workflow_run, merge_runs, AutomationRun, AutomationRunHistoryStore,
    AutomationRunOrigin, AutomationRunStatus, MAX_AUTOMATION_RUNS, MAX_AUTOMATION_RUN_AGE_DAYS,
};
use super::history_manager::AutomationRunHistoryManager;
use super::migrate_runs::migrate_runs;
use super::storage::StoreFile;
use crate::macros::history::{MacroRun, MacroRunOrigin, MacroRunStatus};
use crate::workflows::history::{WorkflowRun, WorkflowRunStatus, WorkflowRunTrigger};

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-24T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn at(days_ago: i64, seconds: i64) -> String {
    (now() - Duration::days(days_ago) + Duration::seconds(seconds)).to_rfc3339()
}

fn macro_run(id: &str, started_at: &str) -> MacroRun {
    MacroRun {
        id: id.into(),
        macro_id: "macro-1".into(),
        macro_name: "List".into(),
        started_at: started_at.into(),
        ended_at: started_at.into(),
        status: MacroRunStatus::Error,
        steps_played: 1,
        total_steps: 2,
        target_count: 2,
        target_labels: vec!["a".into(), "b".into()],
        origin: MacroRunOrigin::WorkflowStep,
        error: Some("target closed".into()),
    }
}

fn workflow_run(id: &str, started_at: &str) -> WorkflowRun {
    WorkflowRun {
        id: id.into(),
        workflow_id: "workflow-1".into(),
        workflow_name: "Deploy".into(),
        started_at: started_at.into(),
        ended_at: started_at.into(),
        status: WorkflowRunStatus::Failed,
        steps_completed: 2,
        total: 5,
        failed_step_index: Some(2),
        error: Some("timed out".into()),
        continued_failures: Some(1),
        tab_id: Some("tab-1".into()),
        target_label: Some("db-1".into()),
        triggered_by: WorkflowRunTrigger::OnOutputMatch,
    }
}

fn run(id: &str, ended_at: &str) -> AutomationRun {
    from_workflow_run(&workflow_run(id, ended_at))
}

#[test]
fn a_macro_run_maps_error_and_workflow_step() {
    let ids = HashMap::from([("macro-1".to_string(), "automation-macro-1".to_string())]);
    let converted = from_macro_run(&macro_run("m", "2026-11-20T00:00:00Z"), &ids);
    assert_eq!(converted.automation_id, "automation-macro-1");
    assert_eq!(converted.status, AutomationRunStatus::Failed);
    assert_eq!(converted.origin, AutomationRunOrigin::RunByAutomation);
    assert_eq!(converted.steps_completed, 1);
    assert_eq!(converted.total, 2);
    assert_eq!(converted.target_count, Some(2));
    assert_eq!(converted.target_labels, ["a", "b"]);
    assert_eq!(
        converted.target_label, None,
        "two terminals, no single label"
    );
}

#[test]
fn a_workflow_run_keeps_every_field() {
    let converted = from_workflow_run(&workflow_run("w", "2026-11-20T00:00:00Z"));
    assert_eq!(converted.automation_id, "workflow-1");
    assert_eq!(converted.status, AutomationRunStatus::Failed);
    assert_eq!(converted.origin, AutomationRunOrigin::OnOutputMatch);
    assert_eq!(converted.failed_step_index, Some(2));
    assert_eq!(converted.continued_failures, Some(1));
    assert_eq!(converted.tab_id.as_deref(), Some("tab-1"));
    assert_eq!(converted.target_label.as_deref(), Some("db-1"));
}

#[test]
fn run_serializes_with_the_wire_names() {
    let value = serde_json::to_value(run("w", "2026-11-20T00:00:00Z")).unwrap();
    assert_eq!(value["automationId"], "workflow-1");
    assert_eq!(value["automationName"], "Deploy");
    assert_eq!(value["status"], "failed");
    assert_eq!(value["origin"], "on-output-match");
    assert!(value.get("targetLabels").is_none(), "empty list omitted");
    let origin = serde_json::to_value(AutomationRunOrigin::RunByAutomation).unwrap();
    assert_eq!(origin, "run-by-automation");
}

#[test]
fn merge_runs_is_a_stable_union_by_start_time() {
    let runs = merge_runs(
        &[macro_run("m1", &at(1, 0)), macro_run("m2", &at(3, 0))],
        &[workflow_run("w1", &at(2, 0)), workflow_run("w2", &at(1, 0))],
        &HashMap::new(),
        now(),
    );
    let ids: Vec<&str> = runs.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        ["m2", "w1", "m1", "w2"],
        "oldest first, macros first on a tie"
    );
}

#[test]
fn merge_runs_applies_the_age_and_count_caps() {
    let old = workflow_run("old", &at(MAX_AUTOMATION_RUN_AGE_DAYS + 1, 0));
    let odd = workflow_run("odd", "not-a-timestamp");
    let recent: Vec<MacroRun> = (0..MAX_AUTOMATION_RUNS + 3)
        .map(|i| macro_run(&format!("m{i}"), &at(1, i as i64)))
        .collect();
    let mut workflows = vec![old];
    workflows.push(odd);
    let runs = merge_runs(&recent, &workflows, &HashMap::new(), now());

    assert_eq!(runs.len(), MAX_AUTOMATION_RUNS);
    assert!(runs.iter().all(|r| r.id != "old"), "older than 90 days");
    assert!(
        runs.iter().all(|r| r.id != "odd"),
        "an unparsable start sorts oldest and goes first under the cap"
    );
    assert_eq!(
        runs.last().unwrap().id,
        format!("m{}", MAX_AUTOMATION_RUNS + 2)
    );
}

#[test]
fn manager_records_newest_first_and_caps() {
    let dir = TempDir::new().unwrap();
    let manager = AutomationRunHistoryManager::with_storage(StoreFile::in_dir(dir.path())).unwrap();
    for i in 0..(MAX_AUTOMATION_RUNS + 2) {
        manager
            .record_at(run(&format!("r{i}"), &at(0, -(1000 - i as i64))), now())
            .unwrap();
    }
    let listed = manager.list().unwrap();
    assert_eq!(listed.len(), MAX_AUTOMATION_RUNS);
    assert_eq!(listed[0].id, format!("r{}", MAX_AUTOMATION_RUNS + 1));

    let expired = run("expired", &at(MAX_AUTOMATION_RUN_AGE_DAYS + 1, 0));
    let listed = manager.record_at(expired, now()).unwrap();
    assert!(listed.iter().all(|r| r.id != "expired"));

    assert!(manager.clear().unwrap().is_empty());
    let reloaded =
        AutomationRunHistoryManager::with_storage(StoreFile::in_dir(dir.path())).unwrap();
    assert!(reloaded.list().unwrap().is_empty());
}

#[test]
fn manager_bounds_free_text() {
    let dir = TempDir::new().unwrap();
    let manager = AutomationRunHistoryManager::with_storage(StoreFile::in_dir(dir.path())).unwrap();
    let long = "x".repeat(500);
    let big = AutomationRun {
        automation_name: long.clone(),
        error: Some(long.clone()),
        target_labels: (0..30).map(|_| long.clone()).collect(),
        ..run("big", &at(0, 0))
    };
    let listed = manager.record_at(big, now()).unwrap();
    assert_eq!(listed[0].target_labels.len(), 10);
    assert_eq!(listed[0].automation_name.chars().count(), 200);
}

fn write_runs(dir: &std::path::Path, name: &str, runs: serde_json::Value) {
    fs::write(
        dir.join(name),
        json!({ "version": "1", "runs": runs }).to_string(),
    )
    .unwrap();
}

fn load_runs(dir: &std::path::Path) -> AutomationRunHistoryStore {
    StoreFile::<AutomationRunHistoryStore>::in_dir(dir)
        .load_with_recovery()
        .unwrap()
        .data
}

#[test]
fn run_reconcile_adds_only_runs_the_older_build_wrote() {
    let dir = TempDir::new().unwrap();
    let first = serde_json::to_value(vec![workflow_run("w1", &at(2, 0))]).unwrap();
    write_runs(dir.path(), "runs.json", first);
    assert!(
        migrate_runs(dir.path(), &HashMap::new(), now())
            .unwrap()
            .created
    );
    assert!(dir
        .path()
        .join(format!("runs.json{}", super::legacy::BAK_SUFFIX))
        .exists());

    // The user clears the new history; an older build then records a run.
    let manager = AutomationRunHistoryManager::with_storage(StoreFile::in_dir(dir.path())).unwrap();
    manager.clear().unwrap();
    let both = serde_json::to_value(vec![
        workflow_run("w1", &at(2, 0)),
        workflow_run("w2", &at(1, 0)),
    ])
    .unwrap();
    write_runs(dir.path(), "runs.json", both);

    let report = migrate_runs(dir.path(), &HashMap::new(), now()).unwrap();
    assert_eq!(report.merged, 1);
    let ids: Vec<String> = load_runs(dir.path())
        .runs
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, ["w2"], "the cleared run does not come back");

    // Idempotent.
    let report = migrate_runs(dir.path(), &HashMap::new(), now()).unwrap();
    assert_eq!(report.merged, 0);
}

#[test]
fn run_history_newer_file_is_left_untouched() {
    let dir = TempDir::new().unwrap();
    let newer = r#"{"version":"99","runs":[]}"#;
    fs::write(dir.path().join("automation-runs.json"), newer).unwrap();
    write_runs(
        dir.path(),
        "runs.json",
        serde_json::to_value(vec![workflow_run("w1", &at(2, 0))]).unwrap(),
    );
    migrate_runs(dir.path(), &HashMap::new(), now()).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("automation-runs.json")).unwrap(),
        newer
    );
}
