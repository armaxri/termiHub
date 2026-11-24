//! Tests of the schedules v2 → v3 migration (#5818, slice 10).

use std::fs;

use serde_json::{json, Value};
use tempfile::TempDir;

use super::*;
use crate::automations::migrate::run_boot_migration;
use crate::schedules::config::{ScheduleAction, ScheduleStore};
use crate::schedules::storage::ScheduleStorage;
use crate::utils::migrate::guard_not_newer;

fn schedule(id: &str, action: Value) -> Value {
    json!({"id": id, "name": id, "action": action,
        "targets": {"kind": "connections", "connectionIds": ["c"]},
        "rule": {"kind": "interval", "everyMinutes": 5}})
}

fn macro_action(id: &str) -> Value {
    json!({"kind": "macro", "macroId": id})
}

fn workflow_action(id: &str) -> Value {
    json!({"kind": "workflow", "workflowId": id})
}

fn write(dir: &TempDir, name: &str, value: &Value) {
    fs::write(dir.path().join(name), value.to_string()).unwrap();
}

fn read(dir: &TempDir, name: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(dir.path().join(name)).unwrap()).unwrap()
}

fn macro_entry(id: &str) -> Value {
    json!({"id": id, "name": format!("macro {id}"), "tags": [],
        "steps": [{"data": "ls\r", "delayMs": 0}],
        "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"})
}

fn workflow_entry(id: &str) -> Value {
    json!({"id": id, "name": format!("workflow {id}"), "tags": [],
        "steps": [{"kind": "send-command", "command": "uptime"}],
        "triggers": [{"kind": "manual"}],
        "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"})
}

/// A config dir with both legacy libraries and a v2 `schedules.json`.
fn legacy_dir(macros: &[&str], workflows: &[&str], schedules: Vec<Value>) -> TempDir {
    let dir = TempDir::new().unwrap();
    let macros: Vec<Value> = macros.iter().map(|id| macro_entry(id)).collect();
    let workflows: Vec<Value> = workflows.iter().map(|id| workflow_entry(id)).collect();
    write(
        &dir,
        "macros.json",
        &json!({"version": "1", "macros": macros}),
    );
    write(
        &dir,
        "workflows.json",
        &json!({"version": "3", "workflows": workflows}),
    );
    write(
        &dir,
        SCHEDULES_FILE,
        &json!({"version": "2", "paused": true, "schedules": schedules, "futureKey": 7}),
    );
    dir
}

fn automation_id_of(store: &ScheduleStore, schedule: &str) -> String {
    let s = store.schedules.iter().find(|s| s.id == schedule).unwrap();
    s.action.automation_id().to_string()
}

fn load(dir: &TempDir) -> ScheduleStore {
    let loaded = ScheduleStorage::new_test(dir.path())
        .load_with_recovery()
        .unwrap();
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    loaded.data
}

#[test]
fn a_v2_file_with_both_action_kinds_migrates_keeping_the_ids() {
    let dir = legacy_dir(
        &["macro-1"],
        &["workflow-1"],
        vec![
            schedule("s-macro", macro_action("macro-1")),
            schedule("s-workflow", workflow_action("workflow-1")),
        ],
    );
    let report = run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    assert_eq!(report.schedules.migrated_from, Some(2));

    let on_disk = read(&dir, SCHEDULES_FILE);
    assert_eq!(on_disk["version"], "3");
    assert_eq!(on_disk["paused"], true);
    assert_eq!(on_disk["futureKey"], 7, "unknown keys survive");
    assert_eq!(
        on_disk["schedules"][0]["action"],
        json!({"kind": "automation", "automationId": "macro-1"})
    );
    let store = load(&dir);
    assert_eq!(automation_id_of(&store, "s-macro"), "macro-1");
    assert_eq!(automation_id_of(&store, "s-workflow"), "workflow-1");
}

#[test]
fn a_macro_whose_id_a_workflow_took_follows_its_new_id() {
    // Workflows claim their ids first: the macro "shared" is re-ided.
    let dir = legacy_dir(
        &["shared"],
        &["shared"],
        vec![
            schedule("s-macro", macro_action("shared")),
            schedule("s-workflow", workflow_action("shared")),
        ],
    );
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    let automations = read(&dir, "automations.json");
    let remap = &automations["idRemaps"][0];
    assert_eq!(remap["oldId"], "shared");
    let new_id = remap["newId"].as_str().unwrap().to_string();
    assert_ne!(new_id, "shared");

    let store = load(&dir);
    assert_eq!(automation_id_of(&store, "s-macro"), new_id);
    assert_eq!(automation_id_of(&store, "s-workflow"), "shared");
}

#[test]
fn a_duplicate_macro_id_keeps_resolving_to_the_first_macro() {
    let dir = legacy_dir(
        &["dup", "dup"],
        &[],
        vec![schedule("s", macro_action("dup"))],
    );
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    assert_eq!(automation_id_of(&load(&dir), "s"), "dup");
}

#[test]
fn unknown_ids_keep_failing_and_never_run_the_other_kind() {
    let dir = legacy_dir(
        &["only-macro"],
        &["only-workflow"],
        vec![
            // Deleted macro whose id is a workflow now: must not run it.
            schedule("s-macro-gone", macro_action("only-workflow")),
            // Deleted workflow whose id is a macro now: must not run it.
            schedule("s-workflow-gone", workflow_action("only-macro")),
            // Deleted everywhere: stays as it is.
            schedule("s-nowhere", macro_action("deleted")),
        ],
    );
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    let store = load(&dir);
    assert_eq!(
        automation_id_of(&store, "s-macro-gone"),
        "missing-macro-only-workflow"
    );
    assert_eq!(
        automation_id_of(&store, "s-workflow-gone"),
        "missing-workflow-only-macro"
    );
    assert_eq!(automation_id_of(&store, "s-nowhere"), "deleted");
    let automations = read(&dir, "automations.json");
    let ids: Vec<&str> = automations["automations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a["id"].as_str())
        .collect();
    for s in &store.schedules {
        if s.id != "s-macro-gone" && s.id != "s-workflow-gone" {
            continue;
        }
        assert!(!ids.contains(&s.action.automation_id()));
    }
}

#[test]
fn attempt_run_ids_merge_into_run_ids() {
    let mut s = schedule("s", workflow_action("w"));
    s["lastResult"] = json!({"at": "t2", "outcome": "completed", "workflowRunIds": ["r2"]});
    s["history"] = json!([
        {"at": "t2", "outcome": "completed", "workflowRunIds": ["r2"]},
        {"at": "t1", "outcome": "completed", "macroRunIds": ["m1"], "workflowRunIds": ["m1", "r1"]},
        {"at": "t0", "outcome": "skipped", "message": "why"}
    ]);
    let dir = legacy_dir(&[], &["w"], vec![s]);
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    let on_disk = read(&dir, SCHEDULES_FILE);
    let schedule = &on_disk["schedules"][0];
    assert_eq!(schedule["lastResult"]["runIds"], json!(["r2"]));
    assert_eq!(schedule["history"][1]["runIds"], json!(["m1", "r1"]));
    assert!(schedule["history"][1].get("macroRunIds").is_none());
    assert!(schedule["history"][1].get("workflowRunIds").is_none());
    assert!(schedule["history"][2].get("runIds").is_none());
    let store = load(&dir);
    assert_eq!(store.schedules[0].history[1].run_ids, vec!["m1", "r1"]);
}

#[test]
fn the_v2_file_is_backed_up_once_and_a_rerun_changes_nothing() {
    let dir = legacy_dir(&["m"], &[], vec![schedule("s", macro_action("m"))]);
    let original = fs::read_to_string(dir.path().join(SCHEDULES_FILE)).unwrap();
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    let bak = dir.path().join("schedules.json.pre-automations.bak");
    assert_eq!(fs::read_to_string(&bak).unwrap(), original);
    let migrated = fs::read_to_string(dir.path().join(SCHEDULES_FILE)).unwrap();

    let again = run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    assert_eq!(again.schedules.migrated_from, None);
    assert_eq!(
        fs::read_to_string(dir.path().join(SCHEDULES_FILE)).unwrap(),
        migrated
    );
    assert_eq!(fs::read_to_string(&bak).unwrap(), original);
}

#[test]
fn a_v1_file_migrates_through_v2_to_v3() {
    let mut s = schedule("s", macro_action("m"));
    s["lastResult"] = json!({"at": "t", "outcome": "completed", "macroRunIds": ["mr"]});
    let dir = legacy_dir(&["m"], &[], vec![s]);
    write(
        &dir,
        SCHEDULES_FILE,
        &json!({"version": "1", "schedules": [read(&dir, SCHEDULES_FILE)["schedules"][0]]}),
    );
    let report = run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    assert_eq!(report.schedules.migrated_from, Some(1));
    let store = load(&dir);
    assert_eq!(store.schedules[0].history.len(), 1, "v1 → v2 seeds history");
    assert_eq!(store.schedules[0].history[0].run_ids, vec!["mr"]);
}

#[test]
fn newer_and_corrupt_schedule_files_are_left_alone() {
    for raw in [r#"{"version":"99","schedules":[]}"#, "{ not json"] {
        let dir = legacy_dir(&[], &[], Vec::new());
        fs::write(dir.path().join(SCHEDULES_FILE), raw).unwrap();
        run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(SCHEDULES_FILE)).unwrap(),
            raw
        );
        assert!(!dir
            .path()
            .join("schedules.json.pre-automations.bak")
            .exists());
    }
}

#[test]
fn without_a_readable_automation_store_the_file_waits() {
    let dir = TempDir::new().unwrap();
    write(
        &dir,
        SCHEDULES_FILE,
        &json!({"version": "2", "schedules": [schedule("s", macro_action("m"))]}),
    );
    assert_eq!(migrate_schedules(dir.path()).unwrap().migrated_from, None);
    assert_eq!(read(&dir, SCHEDULES_FILE)["version"], "2");
}

#[test]
fn the_in_memory_migration_keeps_every_id() {
    // A restored backup goes through the versioned-store gate only.
    let raw = json!({"version": "2", "schedules": [
        schedule("a", macro_action("m")),
        schedule("b", workflow_action("w"))]})
    .to_string();
    let crate::utils::migrate::LoadOutcome::Loaded { data, .. } =
        crate::utils::migrate::load_versioned::<ScheduleStore>(&raw)
    else {
        panic!("a v2 file loads");
    };
    assert_eq!(data.version, "3");
    assert_eq!(
        data.schedules[0].action,
        ScheduleAction::Automation {
            automation_id: "m".into()
        }
    );
    assert_eq!(data.schedules[1].action.automation_id(), "w");
}

#[test]
fn a_v2_build_refuses_to_overwrite_the_v3_file() {
    let dir = legacy_dir(&["m"], &[], vec![schedule("s", macro_action("m"))]);
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    let before = fs::read_to_string(dir.path().join(SCHEDULES_FILE)).unwrap();
    let err = guard_not_newer(&dir.path().join(SCHEDULES_FILE), "schedules.json", 2).unwrap_err();
    assert!(err.to_string().contains("newer version"));
    assert_eq!(
        fs::read_to_string(dir.path().join(SCHEDULES_FILE)).unwrap(),
        before
    );
}

#[test]
fn a_store_without_provenance_falls_back_to_the_id_remaps() {
    let store: AutomationStore = serde_json::from_value(json!({
        "version": "1",
        "automations": [],
        "idRemaps": [
            {"source": "macro", "oldId": "x", "newId": "automation-x"},
            {"source": "macro", "oldId": "x", "newId": "automation-x-2"}
        ]
    }))
    .unwrap();
    let ids = AutomationIdMap::from_store(&store);
    assert_eq!(ids.resolve(LegacySource::Macro, "x"), "automation-x");
    assert_eq!(ids.resolve(LegacySource::Workflow, "x"), "x");
}
