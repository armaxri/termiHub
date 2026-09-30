//! Direct (non-agent) VNC/RDP connections honour the one "Save password"
//! option (#3818): the password goes to the desktop credential store, never
//! into `connections.json`, and leaves the store with the connection.

use std::path::Path;
use std::sync::Arc;

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use crate::terminal::backend::ConnectionConfig;

const SECRET: &str = "rdp-s3cret-do-not-leak";

fn manager(dir: &Path, store: Arc<RecordingStore>) -> ConnectionManager {
    ConnectionManager::new_for_test(dir, store).unwrap()
}

fn graphical(type_id: &str, name: &str, settings: serde_json::Value) -> SavedConnection {
    SavedConnection {
        extra: Default::default(),
        icon: None,
        id: format!("conn-{name}"),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: type_id.to_string(),
            settings,
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

fn connections_file(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("connections.json")).unwrap()
}

#[test]
fn a_direct_graphical_password_is_saved_to_the_store_only() {
    for type_id in ["vnc", "rdp"] {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(RecordingStore::default());
        let mgr = manager(dir.path(), store.clone());

        let id = mgr
            .save_connection(graphical(
                type_id,
                "Desk",
                serde_json::json!({ "host": "h", "port": 5900, "password": SECRET,
                                    "savePassword": true }),
            ))
            .unwrap();

        assert_eq!(
            store.value(&id, CredentialType::Password).as_deref(),
            Some(SECRET),
            "{type_id}: the password is kept in the credential store"
        );
        let file = connections_file(dir.path());
        assert!(!file.contains(SECRET), "{type_id}: secret on disk: {file}");
        assert!(!file.contains("\"password\""), "{type_id}: {file}");
    }
}

#[test]
fn a_direct_graphical_password_without_the_option_is_not_kept() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), store.clone());

    mgr.save_connection(graphical(
        "vnc",
        "Desk",
        serde_json::json!({ "host": "h", "password": SECRET }),
    ))
    .unwrap();

    assert!(store.snapshot().is_empty());
    assert!(!connections_file(dir.path()).contains(SECRET));
}

#[test]
fn the_legacy_save_to_store_option_is_honoured_and_rewritten() {
    // A connection saved with the old graphical "Save to store" option (which
    // no code read) keeps its password now, under the unified flag.
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), store.clone());

    let id = mgr
        .save_connection(graphical(
            "rdp",
            "Old",
            serde_json::json!({ "host": "h", "password": SECRET, "saveToStore": true }),
        ))
        .unwrap();

    assert_eq!(
        store.value(&id, CredentialType::Password).as_deref(),
        Some(SECRET)
    );
    let file = connections_file(dir.path());
    assert!(!file.contains(SECRET));
    assert!(!file.contains("saveToStore"), "legacy flag written: {file}");
    assert!(file.contains("\"savePassword\": true"), "{file}");
}

#[test]
fn a_legacy_connections_file_loads_with_the_unified_flag() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("connections.json"),
        r#"{"version":"4","children":[{"type":"connection","name":"Old",
            "config":{"type":"vnc","config":{"host":"h","saveToStore":true}}}]}"#,
    )
    .unwrap();
    let mgr = manager(dir.path(), Arc::new(RecordingStore::default()));

    let all = mgr.get_all().unwrap();
    let old = all.connections.iter().find(|c| c.name == "Old").unwrap();
    assert_eq!(
        old.config.settings,
        serde_json::json!({ "host": "h", "savePassword": true })
    );
}

#[test]
fn deleting_a_direct_graphical_connection_clears_its_password() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), store.clone());
    let id = mgr
        .save_connection(graphical(
            "vnc",
            "Desk",
            serde_json::json!({ "host": "h", "password": SECRET, "savePassword": true }),
        ))
        .unwrap();
    assert!(store.value(&id, CredentialType::Password).is_some());

    mgr.delete_connection(&id).unwrap();

    assert!(store.value(&id, CredentialType::Password).is_none());
}
