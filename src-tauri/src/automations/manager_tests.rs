//! Automation store CRUD tests (#5818, slice 2).

use std::fs;

use tempfile::TempDir;

use super::config::{Automation, AutomationLegacy, LegacySource};
use super::manager::AutomationManager;
use super::storage::StoreFile;

fn manager(dir: &TempDir) -> AutomationManager {
    AutomationManager::with_storage(StoreFile::in_dir(dir.path())).unwrap()
}

fn automation(id: &str, name: &str) -> Automation {
    serde_json::from_value(serde_json::json!({ "id": id, "name": name })).unwrap()
}

#[test]
fn save_get_list_delete_round_trip() {
    let dir = TempDir::new().unwrap();
    let mgr = manager(&dir);
    assert!(mgr.list().unwrap().is_empty());

    let saved = mgr.save(automation("a-1", "First")).unwrap();
    assert!(!saved.created_at.is_empty());
    assert_eq!(saved.created_at, saved.updated_at);
    mgr.save(automation("a-2", "Second")).unwrap();

    assert_eq!(mgr.get("a-2").unwrap().name, "Second");
    assert_eq!(mgr.list().unwrap().len(), 2);

    mgr.delete("a-1").unwrap();
    assert!(mgr.get("a-1").is_err());
    assert!(mgr.delete("a-1").is_err(), "deleting twice fails");

    // Persisted.
    let names: Vec<String> = manager(&dir)
        .list()
        .unwrap()
        .into_iter()
        .map(|a| a.name)
        .collect();
    assert_eq!(names, ["Second"]);
}

#[test]
fn update_keeps_created_at_and_provenance() {
    let dir = TempDir::new().unwrap();
    let mgr = manager(&dir);
    let mut first = automation("a-1", "Original");
    first.legacy = Some(AutomationLegacy {
        from: LegacySource::Macro,
        version: 1,
        extra: Default::default(),
    });
    let first = mgr.save(first).unwrap();

    let mut edited = automation("a-1", "Renamed");
    edited.created_at = "1999-01-01T00:00:00Z".into();
    let edited = mgr.save(edited).unwrap();

    assert_eq!(edited.created_at, first.created_at);
    assert_eq!(edited.legacy, first.legacy, "provenance survives an edit");
    assert_eq!(mgr.list().unwrap().len(), 1);
}

#[test]
fn an_empty_id_is_refused() {
    let dir = TempDir::new().unwrap();
    assert!(manager(&dir).save(automation(" ", "Nameless")).is_err());
}

#[test]
fn a_failed_save_leaves_memory_unchanged() {
    let dir = TempDir::new().unwrap();
    let mgr = manager(&dir);
    mgr.save(automation("a-1", "First")).unwrap();
    // A newer build wrote the file meanwhile: the save is refused.
    fs::write(
        dir.path().join("automations.json"),
        r#"{"version":"99","automations":[]}"#,
    )
    .unwrap();
    assert!(mgr.save(automation("a-2", "Second")).is_err());
    assert_eq!(mgr.list().unwrap().len(), 1);
}

fn remap(changes: &[(&str, &str)]) -> crate::connection::id_changes::ConnectionIdRemap {
    let changes: Vec<crate::connection::id_changes::ConnectionIdChange> = changes
        .iter()
        .map(|(o, n)| crate::connection::id_changes::ConnectionIdChange::new(*o, *n))
        .collect();
    crate::connection::id_changes::ConnectionIdRemap::new(&changes)
}

#[test]
fn connection_bound_triggers_follow_connection_id_changes() {
    let dir = TempDir::new().unwrap();
    let mgr = manager(&dir);
    let mut a = automation("a-1", "Deploy");
    a.triggers = serde_json::from_value(serde_json::json!([
        { "kind": "on-connect", "connectionIds": ["Work/a", "b", "x"] },
        { "kind": "hotkey", "binding": "Ctrl+Alt+H" },
        { "kind": "on-output-match", "connectionIds": ["Work/a"], "pattern": "ok" }
    ]))
    .unwrap();
    let saved = mgr.save(a).unwrap();

    assert!(mgr
        .follow_connection_id_changes(&remap(&[("Work/a", "b"), ("b", "c")]))
        .unwrap());

    let reloaded = manager(&dir).get("a-1").unwrap();
    assert_eq!(
        serde_json::to_value(&reloaded.triggers).unwrap(),
        serde_json::json!([
            { "kind": "on-connect", "connectionIds": ["b", "c", "x"] },
            { "kind": "hotkey", "binding": "Ctrl+Alt+H" },
            { "kind": "on-output-match", "connectionIds": ["b"], "pattern": "ok" }
        ])
    );
    assert_eq!(
        reloaded.updated_at, saved.updated_at,
        "following a rename is not an edit"
    );
    assert!(
        !mgr.follow_connection_id_changes(&remap(&[("zzz", "yyy")]))
            .unwrap(),
        "no matching trigger reports no change"
    );
}
