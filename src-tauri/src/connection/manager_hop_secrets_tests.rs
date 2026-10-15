//! Stored hop secrets follow the saved jump-host chain (#4792).

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::{json, Value};

use super::super::ConnectionManager;
use crate::connection::config::SavedConnection;
use crate::connection::credential_scope::owner_id;
use crate::connection::recording_credential_store::RecordingStore;
use crate::connection::secret_fields::{read_field_secrets, store_field_secrets};
use crate::connection::settings::ExternalFileConfig;
use crate::credential::CredentialType;
use crate::terminal::backend::ConnectionConfig;
use termihub_core::connection::secrets::TakenSecrets;

const A: &str = "ops@bastion:22";
const B: &str = "ops@relay:2200";

fn manager(dir: &Path, store: &Arc<RecordingStore>) -> ConnectionManager {
    ConnectionManager::new_for_test(dir, store.clone()).unwrap()
}

fn hop(host: &str, port: Option<u64>, password: Option<&str>) -> Value {
    let mut hop = json!({ "host": host, "username": "ops", "authMethod": "password" });
    if let Some(port) = port {
        hop["port"] = json!(port);
    }
    if let Some(password) = password {
        hop["password"] = json!(password);
    }
    hop
}

fn ssh(id: &str, hops: Vec<Value>) -> SavedConnection {
    SavedConnection {
        extra: Default::default(),
        icon: None,
        id: id.to_string(),
        name: "Target".to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: json!({ "host": "target", "username": "me", "authMethod": "key",
                              "proxyJump": hops }),
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

/// Save a connection with two inline hops carrying passwords; returns its id.
fn save_two_hops(mgr: &ConnectionManager) -> String {
    mgr.save_connection(ssh(
        "Target",
        vec![
            hop("bastion", None, Some("pw-a")),
            hop("relay", Some(2200), Some("pw-b")),
        ],
    ))
    .unwrap()
}

fn stored_hops(store: &RecordingStore, owner: &str) -> Vec<String> {
    read_field_secrets(store, owner)
        .unwrap()
        .hops
        .into_keys()
        .collect()
}

#[test]
fn editing_a_hops_host_drops_the_old_identitys_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = save_two_hops(&mgr);
    assert_eq!(stored_hops(&store, &id), vec![A, B]);

    // The editor sends unchanged passwords as absent; only the host changed.
    mgr.save_connection(ssh(
        &id,
        vec![hop("bastion2", None, None), hop("relay", Some(2200), None)],
    ))
    .unwrap();

    assert_eq!(stored_hops(&store, &id), vec![B]);
}

#[test]
fn editing_a_hops_port_or_user_drops_the_old_identitys_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = save_two_hops(&mgr);

    let mut renamed = hop("bastion", None, None);
    renamed["username"] = json!("root");
    mgr.save_connection(ssh(&id, vec![renamed, hop("relay", Some(2201), None)]))
        .unwrap();

    assert!(stored_hops(&store, &id).is_empty());
}

#[test]
fn removing_a_hop_drops_its_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = save_two_hops(&mgr);

    mgr.save_connection(ssh(&id, vec![hop("relay", Some(2200), None)]))
        .unwrap();
    assert_eq!(stored_hops(&store, &id), vec![B]);

    // Removing the last hop — even dropping the list — removes the entry.
    let mut no_chain = ssh(&id, vec![]);
    no_chain
        .config
        .settings
        .as_object_mut()
        .unwrap()
        .remove("proxyJump");
    mgr.save_connection(no_chain).unwrap();
    assert_eq!(store.value(&id, CredentialType::FieldSecrets), None);
}

#[test]
fn reordering_or_duplicating_hops_keeps_every_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = save_two_hops(&mgr);

    mgr.save_connection(ssh(
        &id,
        vec![
            hop("relay", Some(2200), None),
            hop("bastion", None, None),
            hop("bastion", Some(22), None),
        ],
    ))
    .unwrap();

    let stored = read_field_secrets(&*store, &id).unwrap();
    assert_eq!(stored.hops.get(A).map(String::as_str), Some("pw-a"));
    assert_eq!(stored.hops.get(B).map(String::as_str), Some("pw-b"));
}

#[test]
fn a_hop_moved_to_the_legacy_list_keeps_its_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = save_two_hops(&mgr);

    let mut legacy = ssh(&id, vec![]);
    let settings = legacy.config.settings.as_object_mut().unwrap();
    settings.remove("proxyJump");
    settings.insert("jumpHosts".into(), json!([hop("bastion", None, None)]));
    mgr.save_connection(legacy).unwrap();

    assert_eq!(stored_hops(&store, &id), vec![A]);
}

#[test]
fn a_hop_turned_into_a_saved_connection_reference_drops_its_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = save_two_hops(&mgr);

    let mut reference = hop("bastion", None, None);
    reference["connectionId"] = json!("Gateway");
    mgr.save_connection(ssh(&id, vec![reference, hop("relay", Some(2200), None)]))
        .unwrap();

    assert_eq!(stored_hops(&store, &id), vec![B]);
}

#[test]
fn top_level_field_secrets_are_never_pruned() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = save_two_hops(&mgr);
    let mut top = TakenSecrets::default();
    top.fields.insert("sshPassword".into(), "gw".into());
    top.fields.insert("pluginToken".into(), "tok".into());
    store_field_secrets(&*store, &id, top).unwrap();

    mgr.save_connection(ssh(&id, vec![])).unwrap();

    let stored = read_field_secrets(&*store, &id).unwrap();
    assert!(stored.hops.is_empty());
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some("gw")
    );
    assert_eq!(
        stored.fields.get("pluginToken").map(String::as_str),
        Some("tok")
    );
}

#[test]
fn a_save_with_a_locked_store_defers_the_prune_to_the_next_unlock() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = save_two_hops(&mgr);
    // The once-per-run sweep has already run.
    mgr.migrate_credential_scopes();
    assert!(mgr.hop_secrets_swept.load(Ordering::SeqCst));

    store.locked.store(true, Ordering::SeqCst);
    store.calls.lock().unwrap().clear();
    mgr.save_connection(ssh(&id, vec![hop("relay", Some(2200), None)]))
        .expect("a locked store never fails a save without new secrets");
    assert!(
        store.calls().is_empty(),
        "a locked store is never read: {:?}",
        store.calls()
    );
    assert_eq!(stored_hops(&store, &id), vec![A, B], "nothing pruned yet");
    assert!(
        !mgr.hop_secrets_swept.load(Ordering::SeqCst),
        "sweep scheduled"
    );

    // Every unlock runs the scope sync, which sweeps.
    store.locked.store(false, Ordering::SeqCst);
    mgr.migrate_credential_scopes();
    assert_eq!(stored_hops(&store, &id), vec![B]);
    assert!(mgr.hop_secrets_swept.load(Ordering::SeqCst));
}

#[test]
fn the_first_unlocked_sweep_of_a_run_drops_orphans_left_before() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let id = {
        let mgr = manager(dir.path(), &store);
        mgr.save_connection(ssh("Target", vec![hop("relay", Some(2200), Some("pw-b"))]))
            .unwrap()
    };
    // An orphan from an older build (or a deferral lost to a restart), and an
    // entry whose owner is no known connection, which is left alone.
    let mut orphan = TakenSecrets::default();
    orphan.hops.insert(A.into(), "pw-a".into());
    store_field_secrets(&*store, &id, orphan.clone()).unwrap();
    store_field_secrets(&*store, "Deleted", orphan).unwrap();

    let mgr = manager(dir.path(), &store);
    mgr.migrate_credential_scopes();

    assert_eq!(stored_hops(&store, &id), vec![B]);
    assert_eq!(stored_hops(&store, "Deleted"), vec![A]);
}

/// Configure `path` as an external connection file of `mgr`.
fn configure_external(mgr: &ConnectionManager, path: &str) {
    let mut settings = mgr.get_settings();
    settings.external_connection_files = vec![ExternalFileConfig {
        path: path.to_string(),
        enabled: true,
    }];
    mgr.save_settings(settings).unwrap();
}

#[test]
fn an_external_connections_old_hop_secret_is_dropped_on_save() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let file = dir.path().join("shared.json").to_str().unwrap().to_string();
    configure_external(&mgr, &file);
    let mut conn = ssh(
        "Target",
        vec![
            hop("bastion", None, Some("pw-a")),
            hop("relay", Some(2200), Some("pw-b")),
        ],
    );
    conn.source_file = Some(file.clone());
    let id = mgr.save_connection_routed(conn).unwrap();
    let owner = owner_id(&id, Some(&mgr.file_scope(&file)));
    assert_eq!(stored_hops(&store, &owner), vec![A, B]);

    let mut edited = ssh(&id, vec![hop("bastion2", None, None)]);
    edited.source_file = Some(file.clone());
    mgr.save_connection_routed(edited).unwrap();

    assert!(stored_hops(&store, &owner).is_empty());
}

#[test]
fn a_main_store_prune_waits_while_an_external_file_may_share_the_key() {
    // A configured external file that cannot be read may still hold a
    // same-id connection reading this bare key (#3591): defer, don't prune.
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = save_two_hops(&mgr);
    let missing = dir
        .path()
        .join("offline.json")
        .to_str()
        .unwrap()
        .to_string();
    configure_external(&mgr, &missing);

    mgr.save_connection(ssh(&id, vec![])).unwrap();
    assert_eq!(stored_hops(&store, &id), vec![A, B]);
    assert!(!mgr.hop_secrets_swept.load(Ordering::SeqCst));

    // Once the file is gone from the configuration, the next sweep prunes.
    let mut settings = mgr.get_settings();
    settings.external_connection_files.clear();
    mgr.save_settings(settings).unwrap();
    mgr.migrate_credential_scopes();
    assert!(stored_hops(&store, &id).is_empty());
}
