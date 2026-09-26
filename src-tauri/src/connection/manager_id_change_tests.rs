//! A saved connection's id follows its folder chain and name, so renames and
//! moves change it. The manager reports every persisted change (#3569) — and
//! the file-browser bookmarks keyed by the id follow it.

use std::path::Path;
use std::sync::{Arc, Mutex};

use super::*;
use crate::credential::null::NullStore;
use crate::files::bookmarks_manager::{connection_scope, FileBookmarkManager};
use crate::terminal::backend::ConnectionConfig;

type Recorded = Arc<Mutex<Vec<ConnectionIdChange>>>;

/// A manager whose id changes are recorded (sorted per notification).
fn recording_manager(dir: &Path) -> (ConnectionManager, Recorded) {
    let mgr = ConnectionManager::new_for_test(dir, Arc::new(NullStore)).unwrap();
    let recorded: Recorded = Arc::default();
    let sink = recorded.clone();
    mgr.set_id_change_listener(Arc::new(move |changes| {
        let mut batch = changes.to_vec();
        batch.sort_by(|a, b| a.old_id.cmp(&b.old_id));
        sink.lock().unwrap().extend(batch);
    }));
    (mgr, recorded)
}

fn take(recorded: &Recorded) -> Vec<ConnectionIdChange> {
    std::mem::take(&mut *recorded.lock().unwrap())
}

fn change(old: &str, new: &str) -> ConnectionIdChange {
    ConnectionIdChange::new(old, new)
}

fn conn(id: &str, name: &str, folder_id: Option<&str>) -> SavedConnection {
    SavedConnection {
        icon: None,
        id: id.to_string(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "local".to_string(),
            settings: serde_json::json!({"shell": "bash"}),
        },
        folder_id: folder_id.map(String::from),
        terminal_options: None,
        source_file: None,
    }
}

fn folder(id: &str, name: &str, parent_id: Option<&str>) -> ConnectionFolder {
    ConnectionFolder {
        id: id.to_string(),
        name: name.to_string(),
        parent_id: parent_id.map(String::from),
        is_expanded: true,
    }
}

#[test]
fn renaming_a_connection_reports_its_id_change() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = recording_manager(dir.path());
    mgr.save_connection(conn("a", "a", None)).unwrap();
    take(&recorded);

    assert_eq!(mgr.save_connection(conn("a", "b", None)).unwrap(), "b");
    assert_eq!(take(&recorded), vec![change("a", "b")]);

    // Saving without an id change reports nothing.
    mgr.save_connection(conn("b", "b", None)).unwrap();
    assert!(take(&recorded).is_empty());
}

#[test]
fn moving_a_connection_into_a_folder_reports_its_id_change() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = recording_manager(dir.path());
    mgr.save_folder(folder("F", "F", None)).unwrap();
    mgr.save_connection(conn("a", "a", None)).unwrap();
    take(&recorded);

    mgr.save_connection(conn("a", "a", Some("F"))).unwrap();
    assert_eq!(take(&recorded), vec![change("a", "F/a")]);
}

#[test]
fn renaming_a_folder_reports_every_descendant_connection() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = recording_manager(dir.path());
    mgr.save_folder(folder("Work", "Work", None)).unwrap();
    mgr.save_folder(folder("Work/Db", "Db", Some("Work")))
        .unwrap();
    mgr.save_connection(conn("x", "x", Some("Work"))).unwrap();
    mgr.save_connection(conn("y", "y", Some("Work/Db")))
        .unwrap();
    mgr.save_connection(conn("z", "z", None)).unwrap();
    take(&recorded);

    mgr.save_folder(folder("Work", "Job", None)).unwrap();
    assert_eq!(
        take(&recorded),
        vec![change("Work/Db/y", "Job/Db/y"), change("Work/x", "Job/x")]
    );
    let ids: Vec<String> = mgr
        .get_all()
        .unwrap()
        .connections
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert!(ids.contains(&"Job/Db/y".to_string()) && ids.contains(&"Job/x".to_string()));
}

#[test]
fn deleting_a_folder_reports_its_rehomed_connections() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = recording_manager(dir.path());
    mgr.save_folder(folder("F", "F", None)).unwrap();
    mgr.save_folder(folder("F/G", "G", Some("F"))).unwrap();
    mgr.save_connection(conn("a", "a", Some("F"))).unwrap();
    mgr.save_connection(conn("b", "b", Some("F/G"))).unwrap();
    take(&recorded);

    mgr.delete_folder("F").unwrap();
    assert_eq!(
        take(&recorded),
        vec![change("F/G/b", "G/b"), change("F/a", "a")]
    );
}

#[test]
fn a_sibling_renamed_by_deduplication_is_reported_too() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = recording_manager(dir.path());
    mgr.save_connection(conn("a", "a", None)).unwrap();
    mgr.save_connection(conn("b", "b", None)).unwrap();
    take(&recorded);

    // `a` takes the name `b`; being first, it keeps it and the old `b` yields.
    mgr.save_connection(conn("a", "b", None)).unwrap();
    assert_eq!(
        take(&recorded),
        vec![change("a", "b"), change("b", "b (1)")]
    );
}

#[test]
fn renaming_a_connection_in_an_external_file_reports_its_id_change() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = recording_manager(dir.path());
    let file = dir.path().join("shared.json");
    let file = file.to_str().unwrap().to_string();
    let mut external = conn("x", "x", None);
    external.source_file = Some(file.clone());
    mgr.save_connection_routed(external.clone()).unwrap();
    take(&recorded);

    external.name = "y".to_string();
    mgr.save_connection_routed(external).unwrap();
    assert_eq!(take(&recorded), vec![change("x", "y")]);
}

#[test]
fn moving_a_connection_between_files_keeps_its_id() {
    // Both files place a root connection at the same path, so a move between
    // them keeps the id and reports nothing.
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = recording_manager(dir.path());
    let file = dir.path().join("shared.json");
    let file = file.to_str().unwrap().to_string();
    save_external_file(
        &file,
        "shared",
        vec![],
        vec![conn("n", "n", None)],
        &NullStore,
    )
    .unwrap();

    mgr.move_connection_to_file("n", Some(&file), None).unwrap();
    mgr.move_connection_to_file("n", None, Some(file)).unwrap();
    assert!(take(&recorded).is_empty());
}

#[test]
fn a_shared_credential_reference_survives_an_id_change() {
    // A named-credential reference (#3557) points at the credential's own id,
    // not the connection's, so a rename leaves it untouched.
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _recorded) = recording_manager(dir.path());
    let mut c = conn("a", "a", None);
    c.config = ConnectionConfig {
        type_id: "ssh".to_string(),
        settings: serde_json::json!({
            "host": "h", "username": "u", "authMethod": "password", "credentialRef": "cred-1"
        }),
    };
    mgr.save_connection(c.clone()).unwrap();
    c.name = "b".to_string();
    mgr.save_connection(c).unwrap();

    let all = mgr.get_all().unwrap();
    let renamed = all.connections.iter().find(|c| c.id == "b").unwrap();
    assert_eq!(renamed.config.settings["credentialRef"], "cred-1");
}

#[test]
fn bookmarks_follow_a_folder_rename_and_merge_without_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap();
    let bookmarks = Arc::new(FileBookmarkManager::new_for_test(dir.path()).unwrap());
    let follower = bookmarks.clone();
    mgr.set_id_change_listener(Arc::new(move |changes| {
        follower.follow_connection_id_changes(changes);
    }));

    mgr.save_folder(folder("Work", "Work", None)).unwrap();
    mgr.save_connection(conn("x", "x", Some("Work"))).unwrap();
    bookmarks
        .add(&connection_scope("Work/x"), "/srv", None)
        .unwrap();
    bookmarks
        .add(&connection_scope("Work/x"), "/var/log", None)
        .unwrap();
    // A stale list already under the new id shares one path.
    bookmarks
        .add(&connection_scope("Job/x"), "/srv", None)
        .unwrap();

    mgr.save_folder(folder("Work", "Job", None)).unwrap();

    let reloaded = FileBookmarkManager::new_for_test(dir.path()).unwrap();
    assert!(reloaded
        .list(Some(&connection_scope("Work/x")))
        .unwrap()
        .is_empty());
    let paths: Vec<String> = reloaded
        .list(Some(&connection_scope("Job/x")))
        .unwrap()
        .into_iter()
        .map(|b| b.path)
        .collect();
    assert_eq!(paths, vec!["/srv", "/var/log"]);
}
