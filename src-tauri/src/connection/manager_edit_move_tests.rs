//! Saving an edit that also changes a connection's storage file writes it
//! exactly once, into the target file, with the edited fields (#3590).

use std::path::Path;
use std::sync::{Arc, Mutex};

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use crate::credential::null::NullStore;
use crate::terminal::backend::ConnectionConfig;

const PW: CredentialType = CredentialType::Password;

type Recorded = Arc<Mutex<Vec<Vec<ConnectionIdChange>>>>;

/// A manager whose id-change listener records each notification as a batch.
fn manager(dir: &Path, store: Arc<dyn CredentialStore>) -> (ConnectionManager, Recorded) {
    let mgr = ConnectionManager::new_for_test(dir, store).unwrap();
    let recorded: Recorded = Arc::default();
    let sink = recorded.clone();
    mgr.set_id_change_listener(Arc::new(move |changes| {
        sink.lock().unwrap().push(changes.to_vec());
    }));
    (mgr, recorded)
}

fn take(recorded: &Recorded) -> Vec<Vec<ConnectionIdChange>> {
    std::mem::take(&mut *recorded.lock().unwrap())
}

fn ssh(id: &str, name: &str, host: &str) -> SavedConnection {
    SavedConnection {
        icon: None,
        id: id.to_string(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: serde_json::json!({"host": host, "username": "u", "authMethod": "password"}),
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

fn main_connections(mgr: &ConnectionManager) -> Vec<SavedConnection> {
    mgr.get_all().unwrap().connections
}

fn file_connections(path: &str) -> Vec<SavedConnection> {
    let store = read_external_store(path).unwrap();
    flatten_tree(&store.children, None).0
}

fn external_path(dir: &Path, name: &str) -> String {
    dir.join(name).to_str().unwrap().to_string()
}

fn host(c: &SavedConnection) -> &str {
    c.config.settings["host"].as_str().unwrap()
}

#[test]
fn an_edit_moved_from_the_main_store_lands_once_in_the_target_file() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = manager(dir.path(), Arc::new(NullStore));
    mgr.save_connection(ssh("n", "n", "old")).unwrap();
    take(&recorded);
    let file = external_path(dir.path(), "shared.json");

    let mut edited = ssh("n", "n", "new");
    edited.source_file = Some(file.clone());
    let saved = mgr.save_connection_to_file(edited, None).unwrap();

    let in_file = file_connections(&file);
    assert_eq!(in_file.len(), 1, "{in_file:?}");
    assert_eq!(in_file[0].id, "n");
    assert_eq!(host(&in_file[0]), "new");
    assert!(main_connections(&mgr).is_empty());
    assert_eq!(saved.id, "n");
    assert_eq!(saved.source_file.as_deref(), Some(file.as_str()));
    assert!(take(&recorded).is_empty());
}

#[test]
fn an_edit_moved_from_an_external_file_lands_once_in_the_main_store() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _recorded) = manager(dir.path(), Arc::new(NullStore));
    let file = external_path(dir.path(), "shared.json");
    let mut original = ssh("n", "n", "old");
    original.source_file = Some(file.clone());
    mgr.save_connection_routed(original).unwrap();

    let saved = mgr
        .save_connection_to_file(ssh("n", "n", "new"), Some(&file))
        .unwrap();

    let in_main = main_connections(&mgr);
    assert_eq!(in_main.len(), 1, "{in_main:?}");
    assert_eq!(host(&in_main[0]), "new");
    assert!(file_connections(&file).is_empty());
    assert_eq!(saved.source_file, None);
}

#[test]
fn an_edit_moved_between_external_files_lands_once_in_the_target() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _recorded) = manager(dir.path(), Arc::new(NullStore));
    let from = external_path(dir.path(), "a.json");
    let to = external_path(dir.path(), "b.json");
    let mut original = ssh("n", "n", "old");
    original.source_file = Some(from.clone());
    mgr.save_connection_routed(original).unwrap();

    let mut edited = ssh("n", "n", "new");
    edited.source_file = Some(to.clone());
    mgr.save_connection_to_file(edited, Some(&from)).unwrap();

    let in_target = file_connections(&to);
    assert_eq!(in_target.len(), 1, "{in_target:?}");
    assert_eq!(host(&in_target[0]), "new");
    assert!(file_connections(&from).is_empty());
}

#[test]
fn a_rename_during_the_move_reports_one_id_change_and_moves_the_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("n", PW, "N")]));
    let (mgr, recorded) = manager(dir.path(), store.clone());
    mgr.save_connection(ssh("n", "n", "h")).unwrap();
    take(&recorded);
    let file = external_path(dir.path(), "shared.json");

    let mut edited = ssh("n", "m", "h");
    edited.source_file = Some(file.clone());
    let saved = mgr.save_connection_to_file(edited, None).unwrap();

    assert_eq!(saved.id, "m");
    let ids: Vec<String> = file_connections(&file).into_iter().map(|c| c.id).collect();
    assert_eq!(ids, vec!["m"]);
    assert_eq!(
        take(&recorded),
        vec![vec![ConnectionIdChange::new("n", "m")]]
    );
    assert_eq!(store.value("m", PW).as_deref(), Some("N"));
    assert_eq!(store.value("n", PW), None);
}

#[test]
fn an_edit_onto_a_same_named_target_connection_keeps_both_once() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _recorded) = manager(dir.path(), Arc::new(NullStore));
    mgr.save_connection(ssh("n", "n", "moved")).unwrap();
    let file = external_path(dir.path(), "shared.json");
    let mut resident = ssh("n", "n", "resident");
    resident.source_file = Some(file.clone());
    mgr.save_connection_routed(resident).unwrap();

    let mut edited = ssh("n", "n", "moved-edited");
    edited.source_file = Some(file.clone());
    let saved = mgr.save_connection_to_file(edited, None).unwrap();

    let mut in_file = file_connections(&file);
    in_file.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(in_file.len(), 2, "{in_file:?}");
    assert_eq!(host(&in_file[0]), "resident");
    assert_eq!(in_file[1].id, "n (1)");
    assert_eq!(host(&in_file[1]), "moved-edited");
    assert_eq!(saved.id, "n (1)");
}

#[test]
fn an_edit_that_cannot_be_written_leaves_the_source_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _recorded) = manager(dir.path(), Arc::new(NullStore));
    mgr.save_connection(ssh("n", "n", "old")).unwrap();
    let unwritable = external_path(&dir.path().join("missing-dir"), "x.json");

    let mut edited = ssh("n", "n", "new");
    edited.source_file = Some(unwritable);
    assert!(mgr.save_connection_to_file(edited, None).is_err());

    let in_main = main_connections(&mgr);
    assert_eq!(in_main.len(), 1);
    assert_eq!(host(&in_main[0]), "old");
}

#[test]
fn an_edit_of_a_missing_connection_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _recorded) = manager(dir.path(), Arc::new(NullStore));
    let file = external_path(dir.path(), "shared.json");

    let mut edited = ssh("ghost", "ghost", "h");
    edited.source_file = Some(file.clone());
    assert!(mgr.save_connection_to_file(edited, None).is_err());
    assert!(!Path::new(&file).exists());
}

#[test]
fn an_edit_that_keeps_its_file_is_a_plain_save() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _recorded) = manager(dir.path(), Arc::new(NullStore));
    mgr.save_connection(ssh("n", "n", "old")).unwrap();

    let saved = mgr
        .save_connection_to_file(ssh("n", "m", "new"), None)
        .unwrap();

    let in_main = main_connections(&mgr);
    assert_eq!(in_main.len(), 1);
    assert_eq!(in_main[0].id, "m");
    assert_eq!(host(&in_main[0]), "new");
    assert_eq!(saved.id, "m");
}
