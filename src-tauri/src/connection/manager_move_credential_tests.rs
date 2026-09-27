//! Moving connections between files never loses them (#3577), and stored
//! credentials follow every persisted id change (#3578).

use std::path::Path;
use std::sync::{Arc, Mutex};

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use crate::credential::null::NullStore;
use crate::terminal::backend::ConnectionConfig;

const PW: CredentialType = CredentialType::Password;

type Recorded = Arc<Mutex<Vec<ConnectionIdChange>>>;

fn manager(dir: &Path, store: Arc<dyn CredentialStore>) -> (ConnectionManager, Recorded) {
    let mgr = ConnectionManager::new_for_test(dir, store).unwrap();
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

fn ssh(id: &str, name: &str, folder_id: Option<&str>) -> SavedConnection {
    SavedConnection {
        icon: None,
        id: id.to_string(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: serde_json::json!({"host": "h", "username": "u", "authMethod": "password"}),
        },
        folder_id: folder_id.map(String::from),
        terminal_options: None,
        source_file: None,
    }
}

/// `c` with a typed password it saves.
fn with_password(mut c: SavedConnection, password: &str) -> SavedConnection {
    c.config.settings["password"] = serde_json::json!(password);
    c.config.settings["savePassword"] = serde_json::json!(true);
    c
}

fn local(id: &str, name: &str, folder_id: Option<&str>) -> SavedConnection {
    let mut c = ssh(id, name, folder_id);
    c.config = ConnectionConfig {
        type_id: "local".to_string(),
        settings: serde_json::json!({"shell": "bash"}),
    };
    c
}

fn folder(id: &str, name: &str, parent_id: Option<&str>) -> ConnectionFolder {
    ConnectionFolder {
        id: id.to_string(),
        name: name.to_string(),
        parent_id: parent_id.map(String::from),
        is_expanded: true,
    }
}

fn main_ids(mgr: &ConnectionManager) -> Vec<String> {
    let mut ids: Vec<String> = mgr
        .get_all()
        .unwrap()
        .connections
        .into_iter()
        .map(|c| c.id)
        .collect();
    ids.sort();
    ids
}

/// Ids in an external file, as the file itself places them.
fn file_ids(path: &str) -> Vec<String> {
    let store = read_external_store(path).unwrap();
    let (conns, _) = flatten_tree(&store.children, None);
    let mut ids: Vec<String> = conns.into_iter().map(|c| c.id).collect();
    ids.sort();
    ids
}

fn external_path(dir: &Path, name: &str) -> String {
    dir.join(name).to_str().unwrap().to_string()
}

fn change(old: &str, new: &str) -> ConnectionIdChange {
    ConnectionIdChange::new(old, new)
}

// ── #3577: moves between files ─────────────────────────────────────────────

#[test]
fn moving_a_foldered_external_connection_into_the_main_store_keeps_it() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = manager(dir.path(), Arc::new(NullStore));
    let file = external_path(dir.path(), "shared.json");
    save_external_file(
        &file,
        "shared",
        vec![folder("X", "X", None)],
        vec![local("X/n", "n", Some("X"))],
        &NullStore,
    )
    .unwrap();

    let moved = mgr
        .move_connection_to_file("X/n", Some(&file), None)
        .unwrap();

    // The main store has no folder `X`, so the connection lands at its root.
    assert_eq!(main_ids(&mgr), vec!["n"]);
    assert!(file_ids(&file).is_empty());
    assert_eq!(moved.id, "n");
    assert_eq!(moved.folder_id, None);
    assert_eq!(take(&recorded), vec![change("X/n", "n")]);
}

#[test]
fn moving_a_foldered_main_connection_into_an_external_file_keeps_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = manager(dir.path(), Arc::new(NullStore));
    mgr.save_folder(folder("F", "F", None)).unwrap();
    mgr.save_folder(folder("F/G", "G", Some("F"))).unwrap();
    mgr.save_connection(local("a", "a", Some("F/G"))).unwrap();
    take(&recorded);
    let file = external_path(dir.path(), "shared.json");

    mgr.move_connection_to_file("F/G/a", None, Some(file.clone()))
        .unwrap();

    // The file gets the connection's folder chain, so the id is unchanged.
    assert!(main_ids(&mgr).is_empty());
    assert_eq!(file_ids(&file), vec!["F/G/a"]);
    assert!(take(&recorded).is_empty());
}

#[test]
fn a_move_that_cannot_be_written_leaves_the_source_intact() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _recorded) = manager(dir.path(), Arc::new(NullStore));
    mgr.save_connection(local("a", "a", None)).unwrap();
    let unwritable = external_path(&dir.path().join("missing-dir"), "x.json");

    assert!(mgr
        .move_connection_to_file("a", None, Some(unwritable))
        .is_err());
    assert_eq!(main_ids(&mgr), vec!["a"]);
}

#[test]
fn moving_onto_a_same_named_connection_keeps_both() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, recorded) = manager(dir.path(), Arc::new(NullStore));
    mgr.save_connection(local("n", "n", None)).unwrap();
    take(&recorded);
    let file = external_path(dir.path(), "shared.json");
    save_external_file(
        &file,
        "shared",
        vec![],
        vec![local("n", "n", None)],
        &NullStore,
    )
    .unwrap();

    let moved = mgr.move_connection_to_file("n", Some(&file), None).unwrap();

    assert_eq!(main_ids(&mgr), vec!["n", "n (1)"]);
    assert_eq!(moved.id, "n (1)");
    assert_eq!(take(&recorded), vec![change("n", "n (1)")]);
}

#[test]
fn saving_an_external_connection_into_a_folder_the_file_lacks_keeps_it() {
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _recorded) = manager(dir.path(), Arc::new(NullStore));
    let file = external_path(dir.path(), "shared.json");
    let mut c = local("x", "x", None);
    c.source_file = Some(file.clone());
    mgr.save_connection_routed(c.clone()).unwrap();

    // A folder id the file does not have (e.g. deleted meanwhile).
    c.folder_id = Some("Gone".to_string());
    mgr.save_connection_routed(c).unwrap();
    assert_eq!(file_ids(&file), vec!["x"]);
}

// ── #3578: credentials follow every id change ──────────────────────────────

#[test]
fn a_dedup_renamed_sibling_keeps_its_own_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("a", PW, "A"), ("b", PW, "B")]));
    let (mgr, _recorded) = manager(dir.path(), store.clone());
    mgr.save_connection(ssh("a", "a", None)).unwrap();
    mgr.save_connection(ssh("b", "b", None)).unwrap();

    // `a` takes the name `b`; the old `b` becomes `b (1)`.
    mgr.save_connection(ssh("a", "b", None)).unwrap();

    assert_eq!(store.value("a", PW), None);
    assert_eq!(store.value("b", PW).as_deref(), Some("A"));
    assert_eq!(store.value("b (1)", PW).as_deref(), Some("B"));
}

#[test]
fn renaming_an_external_connection_migrates_its_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let (mgr, _recorded) = manager(dir.path(), store.clone());
    let file = external_path(dir.path(), "shared.json");
    let mut c = with_password(ssh("x", "x", None), "X");
    c.source_file = Some(file.clone());
    mgr.save_connection_routed(c.clone()).unwrap();

    c.name = "y".to_string();
    c.config
        .settings
        .as_object_mut()
        .unwrap()
        .remove("password");
    mgr.save_connection_routed(c).unwrap();

    let scope = mgr.file_scope(&file);
    assert_eq!(store.value(&owner_id("x", Some(&scope)), PW), None);
    assert_eq!(
        store.value(&owner_id("y", Some(&scope)), PW).as_deref(),
        Some("X")
    );
}

#[test]
fn a_rehoming_move_migrates_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("X/n", PW, "N")]));
    let (mgr, _recorded) = manager(dir.path(), store.clone());
    let file = external_path(dir.path(), "shared.json");
    save_external_file(
        &file,
        "shared",
        vec![folder("X", "X", None)],
        vec![ssh("X/n", "n", Some("X"))],
        &NullStore,
    )
    .unwrap();

    mgr.move_connection_to_file("X/n", Some(&file), None)
        .unwrap();

    assert_eq!(store.value("n", PW).as_deref(), Some("N"));
    assert_eq!(store.value("X/n", PW), None);
}

#[test]
fn moving_onto_a_same_named_connection_keeps_the_resident_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("n", PW, "N")]));
    let (mgr, _recorded) = manager(dir.path(), store.clone());
    mgr.save_connection(ssh("n", "n", None)).unwrap();
    let file = external_path(dir.path(), "shared.json");
    save_external_file(
        &file,
        "shared",
        vec![],
        vec![ssh("n", "n", None)],
        &NullStore,
    )
    .unwrap();

    mgr.move_connection_to_file("n", Some(&file), None).unwrap();

    // Ids are only unique per file, so the resident `n` keeps its secret.
    assert_eq!(store.value("n", PW).as_deref(), Some("N"));
    assert_eq!(store.value("n (1)", PW).as_deref(), Some("N"));
}

#[test]
fn a_folder_rename_migrates_every_descendant() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[
        ("W/x", PW, "X"),
        ("W/D/y", PW, "Y"),
    ]));
    let (mgr, _recorded) = manager(dir.path(), store.clone());
    mgr.save_folder(folder("W", "W", None)).unwrap();
    mgr.save_folder(folder("W/D", "D", Some("W"))).unwrap();
    mgr.save_connection(ssh("x", "x", Some("W"))).unwrap();
    mgr.save_connection(ssh("y", "y", Some("W/D"))).unwrap();

    mgr.save_folder(folder("W", "J", None)).unwrap();

    assert_eq!(store.value("J/x", PW).as_deref(), Some("X"));
    assert_eq!(store.value("J/D/y", PW).as_deref(), Some("Y"));
    assert_eq!(store.value("W/x", PW), None);
    assert_eq!(store.value("W/D/y", PW), None);
}

#[test]
fn deleting_a_folder_migrates_rehomed_connections_without_clobbering() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("F/a", PW, "FA"), ("a", PW, "RA")]));
    let (mgr, _recorded) = manager(dir.path(), store.clone());
    mgr.save_folder(folder("F", "F", None)).unwrap();
    let mut root = ssh("a", "a", None);
    root.config.settings["host"] = serde_json::json!("root-host");
    mgr.save_connection(root).unwrap();
    mgr.save_connection(ssh("new-a", "a", Some("F"))).unwrap();
    assert_eq!(main_ids(&mgr), vec!["F/a", "a"]);

    mgr.delete_folder("F").unwrap();

    // Both end up at the root as `a` and `a (1)`; whichever name each gets,
    // its own secret follows it and neither is clobbered.
    assert_eq!(main_ids(&mgr), vec!["a", "a (1)"]);
    let all = mgr.get_all().unwrap();
    let root_id = &all
        .connections
        .iter()
        .find(|c| c.config.settings["host"] == "root-host")
        .unwrap()
        .id;
    let other_id = if root_id == "a" { "a (1)" } else { "a" };
    assert_eq!(store.value(root_id, PW).as_deref(), Some("RA"));
    assert_eq!(store.value(other_id, PW).as_deref(), Some("FA"));
    assert_eq!(store.value("F/a", PW), None);
}

#[test]
fn id_changes_of_connections_without_auth_never_touch_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let locked = RecordingStore {
        fail_gets: true,
        ..Default::default()
    };
    let store = Arc::new(locked);
    let (mgr, _recorded) = manager(dir.path(), store.clone());
    mgr.save_folder(folder("W", "W", None)).unwrap();
    mgr.save_connection(local("x", "x", Some("W"))).unwrap();
    mgr.save_folder(folder("W", "J", None)).unwrap();
    mgr.delete_folder("J").unwrap();
    assert!(store.calls().is_empty(), "{:?}", store.calls());
}

#[test]
fn a_named_credential_is_untouched_by_a_rename() {
    // A `credentialRef` (#3557/#3566) points at the credential's own id.
    let dir = tempfile::tempdir().unwrap();
    let named_key = crate::credential::named::owner_id("cred-1");
    let store = Arc::new(RecordingStore::with(&[(&named_key, PW, "shared")]));
    let (mgr, _recorded) = manager(dir.path(), store.clone());
    let mut c = ssh("a", "a", None);
    c.config.settings["credentialRef"] = serde_json::json!("cred-1");
    c.config.settings["password"] = serde_json::json!("typed");
    c.config.settings["savePassword"] = serde_json::json!(true);
    mgr.save_connection(c.clone()).unwrap();
    c.name = "b".to_string();
    mgr.save_connection(c).unwrap();

    assert_eq!(store.value(&named_key, PW).as_deref(), Some("shared"));
    assert!(store
        .calls()
        .iter()
        .all(|call| !call.contains("named-credential:") || call.starts_with("get")));
    let snapshot = store.snapshot();
    assert_eq!(snapshot.len(), 1, "{snapshot:?}");
}

#[test]
fn renaming_an_external_connection_leaves_a_main_connections_same_id_secret_alone() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let (mgr, _recorded) = manager(dir.path(), store.clone());
    mgr.save_connection(with_password(ssh("x", "x", None), "MAIN"))
        .unwrap();
    let file = external_path(dir.path(), "shared.json");
    let mut c = with_password(ssh("x", "x", None), "EXT");
    c.source_file = Some(file.clone());
    mgr.save_connection_routed(c.clone()).unwrap();

    c.name = "y".to_string();
    c.config
        .settings
        .as_object_mut()
        .unwrap()
        .remove("password");
    mgr.save_connection_routed(c).unwrap();

    let scope = mgr.file_scope(&file);
    assert_eq!(store.value("x", PW).as_deref(), Some("MAIN"));
    assert_eq!(
        store.value(&owner_id("y", Some(&scope)), PW).as_deref(),
        Some("EXT")
    );
    assert_eq!(store.value(&owner_id("x", Some(&scope)), PW), None);
}
