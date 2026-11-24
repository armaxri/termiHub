//! Boot migration and reconcile tests over a temp config dir (#5818, slice 2).

use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tempfile::TempDir;

use super::config::{AutomationStep, LegacySource};
use super::legacy::{sha256_hex, BAK_SUFFIX};
use super::manager::AutomationManager;
use super::migrate::{merge_warning, run_boot_migration, CONFLICT_SUFFIX};
use super::storage::StoreFile;
use super::store::AutomationStore;

const COLLISION_MACROS: &str = include_str!("testdata/macros_collision.json");
const COLLISION_WORKFLOWS: &str = include_str!("testdata/workflows_collision.json");

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-24T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn write_json(dir: &Path, name: &str, value: &Value) {
    fs::write(dir.join(name), serde_json::to_string_pretty(value).unwrap()).unwrap();
}

fn macro_entry(id: &str, name: &str, data: &str, updated_at: &str) -> Value {
    json!({
        "id": id, "name": name, "tags": [],
        "steps": [{ "data": data, "delayMs": 5 }],
        "createdAt": "2026-01-01T00:00:00Z", "updatedAt": updated_at
    })
}

fn workflow_entry(id: &str, name: &str, command: &str, updated_at: &str) -> Value {
    json!({
        "id": id, "name": name, "tags": [],
        "steps": [{ "kind": "send-command", "command": command }],
        "triggers": [{ "kind": "manual" }],
        "createdAt": "2026-01-01T00:00:00Z", "updatedAt": updated_at
    })
}

fn write_macros(dir: &Path, macros: Vec<Value>) {
    write_json(
        dir,
        "macros.json",
        &json!({ "version": "1", "macros": macros }),
    );
}

fn write_workflows(dir: &Path, workflows: Vec<Value>) {
    write_json(
        dir,
        "workflows.json",
        &json!({ "version": "3", "workflows": workflows }),
    );
}

/// A profile with one macro and one workflow, as an older build left it.
fn seed(dir: &Path) {
    write_macros(
        dir,
        vec![macro_entry(
            "macro-1",
            "List",
            "ls\r",
            "2026-02-01T00:00:00Z",
        )],
    );
    write_workflows(
        dir,
        vec![workflow_entry(
            "workflow-1",
            "Deploy",
            "make deploy",
            "2026-02-01T00:00:00Z",
        )],
    );
}

fn load(dir: &Path) -> AutomationStore {
    StoreFile::<AutomationStore>::in_dir(dir)
        .load_with_recovery()
        .unwrap()
        .data
}

fn names(store: &AutomationStore) -> Vec<String> {
    let mut names: Vec<String> = store.automations.iter().map(|a| a.name.clone()).collect();
    names.sort();
    names
}

#[test]
fn first_run_converts_both_libraries_and_records_source_hashes() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    let macros_before = fs::read(dir.path().join("macros.json")).unwrap();
    let workflows_before = fs::read(dir.path().join("workflows.json")).unwrap();

    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert!(report.library.created);
    assert!(report.runs.created);

    let store = load(dir.path());
    assert_eq!(names(&store), ["Deploy", "List"]);
    let list = store
        .automations
        .iter()
        .find(|a| a.id == "macro-1")
        .unwrap();
    assert!(matches!(
        &list.steps[..],
        [AutomationStep::TypeKeys { chunks, .. }] if chunks[0].data == "ls\r"
    ));
    let deploy = store
        .automations
        .iter()
        .find(|a| a.id == "workflow-1")
        .unwrap();
    assert!(deploy.triggers.is_empty(), "manual trigger dropped");

    let provenance = store.migrated_from.unwrap();
    let macros = provenance.macros.unwrap();
    assert_eq!(macros.sha256, sha256_hex(&macros_before));
    assert_eq!(macros.version, 1);
    assert_eq!(macros.entries.len(), 1);
    let workflows = provenance.workflows.unwrap();
    assert_eq!(workflows.sha256, sha256_hex(&workflows_before));
    assert_eq!(workflows.version, 3);

    // The legacy files are never written.
    assert_eq!(
        fs::read(dir.path().join("macros.json")).unwrap(),
        macros_before
    );
    assert_eq!(
        fs::read(dir.path().join("workflows.json")).unwrap(),
        workflows_before
    );
}

#[test]
fn first_run_copies_each_legacy_file_once() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    let macros = fs::read(dir.path().join("macros.json")).unwrap();
    // An earlier copy (from an interrupted earlier attempt) is never replaced.
    let workflows_bak = dir.path().join(format!("workflows.json{BAK_SUFFIX}"));
    fs::write(&workflows_bak, "earlier copy").unwrap();

    run_boot_migration(dir.path(), now()).unwrap();

    let macros_bak = dir.path().join(format!("macros.json{BAK_SUFFIX}"));
    assert_eq!(fs::read(&macros_bak).unwrap(), macros);
    assert_eq!(fs::read_to_string(&workflows_bak).unwrap(), "earlier copy");
    assert!(
        !dir.path()
            .join(format!("macro-runs.json{BAK_SUFFIX}"))
            .exists(),
        "no copy of a file that does not exist"
    );

    // A later edit to the legacy file does not refresh the copy.
    write_macros(dir.path(), vec![]);
    run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(fs::read(&macros_bak).unwrap(), macros);
}

#[test]
fn rerun_is_idempotent() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    run_boot_migration(dir.path(), now()).unwrap();
    let automations = fs::read(dir.path().join("automations.json")).unwrap();
    let runs = fs::read(dir.path().join("automation-runs.json")).unwrap();

    for _ in 0..2 {
        let report = run_boot_migration(dir.path(), now()).unwrap();
        assert!(!report.library.created);
        assert_eq!(report.library.merged, 0);
        assert!(merge_warning(&report.library).is_none());
    }
    assert_eq!(
        fs::read(dir.path().join("automations.json")).unwrap(),
        automations
    );
    assert_eq!(
        fs::read(dir.path().join("automation-runs.json")).unwrap(),
        runs
    );
}

#[test]
fn edits_made_by_an_older_build_are_merged_back() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    run_boot_migration(dir.path(), now()).unwrap();

    // The older build edits the macro and adds a workflow.
    write_macros(
        dir.path(),
        vec![macro_entry(
            "macro-1",
            "List all",
            "ls -la\r",
            "2026-03-01T00:00:00Z",
        )],
    );
    write_workflows(
        dir.path(),
        vec![
            workflow_entry(
                "workflow-1",
                "Deploy",
                "make deploy",
                "2026-02-01T00:00:00Z",
            ),
            workflow_entry(
                "workflow-2",
                "Backup",
                "make backup",
                "2026-03-01T00:00:00Z",
            ),
        ],
    );
    let macros_after = fs::read(dir.path().join("macros.json")).unwrap();

    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(report.library.merged, 2);
    assert_eq!(report.library.conflicts, 0);
    let warning = merge_warning(&report.library).unwrap();
    assert!(warning.message.contains("merged 2 changes"), "{warning:?}");

    let store = load(dir.path());
    assert_eq!(names(&store), ["Backup", "Deploy", "List all"]);
    let list = store
        .automations
        .iter()
        .find(|a| a.id == "macro-1")
        .unwrap();
    assert_eq!(list.updated_at, "2026-03-01T00:00:00Z");
    assert_eq!(
        store.migrated_from.unwrap().macros.unwrap().sha256,
        sha256_hex(&macros_after),
        "the hash follows the merged file"
    );

    // Nothing more to merge on the next start.
    let again = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(again.library.merged, 0);
}

#[test]
fn an_entry_changed_on_both_sides_is_kept_as_a_copy() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    run_boot_migration(dir.path(), now()).unwrap();

    // The new build edits the automation…
    let manager = AutomationManager::with_storage(StoreFile::in_dir(dir.path())).unwrap();
    let mut list = manager.get("macro-1").unwrap();
    list.name = "List (new build)".into();
    manager.save(list).unwrap();
    // …and an older build edits the same macro.
    write_macros(
        dir.path(),
        vec![macro_entry(
            "macro-1",
            "List (old build)",
            "ls -1\r",
            "2026-03-01T00:00:00Z",
        )],
    );

    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(report.library.merged, 1);
    assert_eq!(report.library.conflicts, 1);
    assert!(merge_warning(&report.library)
        .unwrap()
        .message
        .contains("kept as a copy"));

    let store = load(dir.path());
    assert_eq!(
        names(&store),
        [
            "Deploy".to_string(),
            "List (new build)".to_string(),
            format!("List (old build){CONFLICT_SUFFIX}"),
        ]
    );
    let copy = store
        .automations
        .iter()
        .find(|a| a.name.ends_with(CONFLICT_SUFFIX))
        .unwrap();
    assert_eq!(copy.id, "automation-macro-1");

    // A further old-build edit now follows the copy, not the original.
    write_macros(
        dir.path(),
        vec![macro_entry(
            "macro-1",
            "List (old build, again)",
            "ls -1\r",
            "2026-04-01T00:00:00Z",
        )],
    );
    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!((report.library.merged, report.library.conflicts), (1, 0));
    let store = load(dir.path());
    assert_eq!(store.automations.len(), 3);
    assert!(store
        .automations
        .iter()
        .any(|a| a.id == "automation-macro-1" && a.name == "List (old build, again)"));
}

#[test]
fn a_hash_change_without_entry_changes_merges_nothing() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    run_boot_migration(dir.path(), now()).unwrap();

    // Same content, different formatting: the file hash moves, no entry does.
    let raw = fs::read_to_string(dir.path().join("macros.json")).unwrap();
    let compact: Value = serde_json::from_str(&raw).unwrap();
    fs::write(dir.path().join("macros.json"), compact.to_string()).unwrap();

    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(report.library.merged, 0);
    let store = load(dir.path());
    assert_eq!(
        store.migrated_from.unwrap().macros.unwrap().sha256,
        sha256_hex(compact.to_string().as_bytes())
    );
}

#[test]
fn deletions_are_never_followed_or_undone() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    run_boot_migration(dir.path(), now()).unwrap();

    // The new build deletes the workflow; the older build deletes the macro
    // and adds another one (so the file hash moves).
    let manager = AutomationManager::with_storage(StoreFile::in_dir(dir.path())).unwrap();
    manager.delete("workflow-1").unwrap();
    write_macros(
        dir.path(),
        vec![macro_entry(
            "macro-2",
            "Top",
            "top\r",
            "2026-03-01T00:00:00Z",
        )],
    );

    run_boot_migration(dir.path(), now()).unwrap();
    // The old build's deletion of macro-1 is not followed, and the untouched
    // workflow the new build deleted does not come back.
    assert_eq!(names(&load(dir.path())), ["List", "Top"]);
}

#[test]
fn an_added_legacy_entry_with_a_taken_id_gets_a_fresh_id() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    run_boot_migration(dir.path(), now()).unwrap();

    // An older build adds a macro whose id the workflow already has.
    write_macros(
        dir.path(),
        vec![
            macro_entry("macro-1", "List", "ls\r", "2026-02-01T00:00:00Z"),
            macro_entry("workflow-1", "Clash", "x", "2026-03-01T00:00:00Z"),
        ],
    );
    run_boot_migration(dir.path(), now()).unwrap();

    let store = load(dir.path());
    let clash = store
        .automations
        .iter()
        .find(|a| a.name == "Clash")
        .unwrap();
    assert_eq!(clash.id, "automation-workflow-1");
    assert_eq!(clash.legacy.as_ref().unwrap().from, LegacySource::Macro);
}

#[test]
fn changed_ids_are_recorded_and_followed_by_run_history() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("macros.json"), COLLISION_MACROS).unwrap();
    fs::write(dir.path().join("workflows.json"), COLLISION_WORKFLOWS).unwrap();
    write_json(
        dir.path(),
        "macro-runs.json",
        &json!({ "version": "1", "runs": [{
            "id": "mrun-1", "macroId": "shared", "macroName": "Macro with a workflow's id",
            "startedAt": "2026-11-20T00:00:00Z", "endedAt": "2026-11-20T00:00:01Z",
            "status": "error", "stepsPlayed": 0, "totalSteps": 1, "targetCount": 1,
            "origin": "workflow-step"
        }]}),
    );

    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(
        report.library.macro_ids.get("shared").map(String::as_str),
        Some("automation-shared-2")
    );

    let store = load(dir.path());
    let remap = store
        .id_remaps
        .iter()
        .find(|r| r.old_id == "shared")
        .expect("the changed id is recorded for the schedules rewrite");
    assert_eq!(remap.source, LegacySource::Macro);
    assert_eq!(remap.new_id, "automation-shared-2");

    let runs = StoreFile::<super::history::AutomationRunHistoryStore>::in_dir(dir.path())
        .load_with_recovery()
        .unwrap()
        .data;
    assert_eq!(runs.runs.len(), 1);
    assert_eq!(runs.runs[0].automation_id, "automation-shared-2");
}

#[test]
fn a_newer_automations_file_is_left_untouched() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    let newer = r#"{"version":"99","automations":{"restructured":true}}"#;
    fs::write(dir.path().join("automations.json"), newer).unwrap();

    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert!(!report.library.created);
    assert_eq!(
        fs::read_to_string(dir.path().join("automations.json")).unwrap(),
        newer
    );
}

#[test]
fn a_newer_legacy_file_is_skipped_and_merged_once_readable() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    let newer = r#"{"version":"99","macros":{"restructured":true}}"#;
    fs::write(dir.path().join("macros.json"), newer).unwrap();

    run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(names(&load(dir.path())), ["Deploy"]);
    assert_eq!(
        fs::read_to_string(dir.path().join("macros.json")).unwrap(),
        newer,
        "never written"
    );

    // The user goes back to a build whose macros.json this build reads.
    seed(dir.path());
    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(report.library.merged, 1);
    assert_eq!(names(&load(dir.path())), ["Deploy", "List"]);
}

#[test]
fn a_store_without_provenance_adopts_the_legacy_files() {
    let dir = TempDir::new().unwrap();
    seed(dir.path());
    // As a backup restore leaves it: no migratedFrom block.
    StoreFile::<AutomationStore>::in_dir(dir.path())
        .save(&AutomationStore::default())
        .unwrap();

    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(report.library.merged, 0);
    let store = load(dir.path());
    assert!(store.automations.is_empty());
    assert!(store.migrated_from.is_some(), "the baseline is recorded");

    // Later old-build edits are merged against that baseline.
    write_macros(
        dir.path(),
        vec![macro_entry(
            "macro-1",
            "List",
            "ls -la\r",
            "2026-03-01T00:00:00Z",
        )],
    );
    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(report.library.merged, 1);
    assert_eq!(names(&load(dir.path())), ["List"]);
}

#[test]
fn a_profile_without_legacy_files_migrates_to_empty_stores() {
    let dir = TempDir::new().unwrap();
    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert!(report.library.created);
    assert!(load(dir.path()).automations.is_empty());

    // A legacy file an older build creates later is merged in.
    seed(dir.path());
    let report = run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(report.library.merged, 2);
}

#[test]
fn a_corrupt_legacy_entry_is_salvaged_in_memory_only() {
    let dir = TempDir::new().unwrap();
    let raw = json!({ "version": "1", "macros": [
        macro_entry("macro-1", "List", "ls\r", "2026-02-01T00:00:00Z"),
        "not a macro"
    ]})
    .to_string();
    fs::write(dir.path().join("macros.json"), &raw).unwrap();

    run_boot_migration(dir.path(), now()).unwrap();
    assert_eq!(names(&load(dir.path())), ["List"]);
    assert_eq!(
        fs::read_to_string(dir.path().join("macros.json")).unwrap(),
        raw
    );
    assert!(!dir.path().join("macros.json.bak").exists());
}
