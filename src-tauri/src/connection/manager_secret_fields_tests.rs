//! Schema-classified secrets never reach a connection file, export or backup
//! in plaintext, and saved ones come back at connect time (#4289).

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use crate::connection::settings::ExternalFileConfig;
use crate::terminal::backend::ConnectionConfig;

const GATEWAY: &str = "gateway-s3cret-do-not-leak";
const HOP: &str = "hop-s3cret-do-not-leak";

fn manager(dir: &Path, store: &Arc<RecordingStore>) -> ConnectionManager {
    ConnectionManager::new_for_test(dir, store.clone()).unwrap()
}

fn conn(name: &str, type_id: &str, settings: serde_json::Value) -> SavedConnection {
    SavedConnection {
        extra: Default::default(),
        icon: None,
        id: name.to_string(),
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

fn tunnelled_vnc() -> SavedConnection {
    conn(
        "Desk",
        "vnc",
        json!({ "host": "desk", "port": 5900, "useSshTunnel": true, "sshHost": "gw",
                "sshUsername": "ops", "sshAuthMethod": "password", "sshPassword": GATEWAY }),
    )
}

fn jump_ssh() -> SavedConnection {
    conn(
        "Target",
        "ssh",
        json!({ "host": "target", "username": "me", "authMethod": "key",
                "proxyJump": [{ "host": "bastion", "username": "ops", "authMethod": "password",
                                "password": HOP }] }),
    )
}

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

fn assert_no_secret(text: &str, what: &str) {
    for secret in [GATEWAY, HOP] {
        assert!(!text.contains(secret), "{what} carries a secret: {text}");
    }
}

#[test]
fn saving_a_tunnelled_vnc_connection_keeps_ssh_password_out_of_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);

    let id = mgr.save_connection(tunnelled_vnc()).unwrap();

    assert_no_secret(&read(dir.path(), "connections.json"), "connections.json");
    let stored = secret_fields::read_field_secrets(&*store, &id).unwrap();
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some(GATEWAY)
    );
}

#[test]
fn an_inline_jump_host_password_is_kept_out_of_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);

    let id = mgr.save_connection(jump_ssh()).unwrap();

    let file = read(dir.path(), "connections.json");
    assert_no_secret(&file, "connections.json");
    assert!(file.contains("bastion"), "the hop itself is kept: {file}");
    let stored = secret_fields::read_field_secrets(&*store, &id).unwrap();
    assert_eq!(
        stored.hops.get("ops@bastion:22").map(String::as_str),
        Some(HOP)
    );
}

#[test]
fn an_empty_secret_on_save_keeps_the_stored_one() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = mgr.save_connection(tunnelled_vnc()).unwrap();

    // The editor never sees the stored secret, so it sends it back empty.
    let mut edited = tunnelled_vnc();
    edited.config.settings["sshPassword"] = json!("");
    edited.config.settings["port"] = json!(5901);
    mgr.save_connection(edited).unwrap();

    let stored = secret_fields::read_field_secrets(&*store, &id).unwrap();
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some(GATEWAY)
    );
}

#[test]
fn exports_and_backups_carry_no_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    mgr.save_connection(tunnelled_vnc()).unwrap();
    mgr.save_connection(jump_ssh()).unwrap();

    assert_no_secret(&mgr.export_json().unwrap(), "export");
    assert_no_secret(&mgr.export_encrypted_json(None, None).unwrap(), "export");

    // A backup of a connections.json still holding legacy plaintext.
    let mut doc: serde_json::Value =
        serde_json::from_str(&read(dir.path(), "connections.json")).unwrap();
    doc["children"][0]["config"]["config"]["sshPassword"] = json!(GATEWAY);
    crate::backup::sections::strip_connection_passwords(&mut doc);
    assert_no_secret(&doc.to_string(), "backup");
}

#[test]
fn an_encrypted_export_carries_field_secrets_encrypted() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    mgr.save_connection(tunnelled_vnc()).unwrap();

    let export = mgr.export_encrypted_json(Some("pw"), None).unwrap();
    assert_no_secret(&export, "encrypted export");

    let dir2 = tempfile::tempdir().unwrap();
    let store2 = Arc::new(RecordingStore::default());
    let mgr2 = manager(dir2.path(), &store2);
    let result = mgr2.import_encrypted_json(&export, Some("pw")).unwrap();
    assert_eq!(result.credentials_imported, 1);
    let stored = secret_fields::read_field_secrets(&*store2, "Desk").unwrap();
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some(GATEWAY)
    );
}

#[test]
fn saved_secrets_come_back_at_connect_time() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let vnc_id = mgr.save_connection(tunnelled_vnc()).unwrap();
    let ssh_id = mgr.save_connection(jump_ssh()).unwrap();

    let vnc = mgr
        .get_all()
        .unwrap()
        .connections
        .into_iter()
        .find(|c| c.id == vnc_id)
        .unwrap();
    let mut settings = vnc.config.settings.clone();
    assert!(settings.get("sshPassword").is_none());
    mgr.restore_saved_secrets(&mut settings, &vnc_id);
    assert_eq!(settings["sshPassword"], GATEWAY);

    let ssh = mgr
        .get_all()
        .unwrap()
        .connections
        .into_iter()
        .find(|c| c.id == ssh_id)
        .unwrap();
    let mut settings = ssh.config.settings.clone();
    mgr.resolve_jump_host_refs(&mut settings, Some(&ssh_id))
        .unwrap();
    assert_eq!(settings["proxyJump"][0]["password"], HOP);
}

#[test]
fn a_referenced_jump_hosts_own_inline_hop_secret_is_restored() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let gateway_id = mgr.save_connection(jump_ssh()).unwrap();

    let mut settings = json!({ "host": "inner", "proxyJump": [{ "connectionId": gateway_id }] });
    mgr.resolve_jump_host_refs(&mut settings, None).unwrap();
    let hops = settings["proxyJump"].as_array().unwrap();
    assert_eq!(hops[0]["host"], "bastion");
    assert_eq!(hops[0]["password"], HOP);
}

#[test]
fn a_locked_store_restores_nothing_and_does_not_fail() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = mgr.save_connection(tunnelled_vnc()).unwrap();
    store.locked.store(true, Ordering::SeqCst);

    let mut settings = json!({ "host": "desk" });
    mgr.restore_saved_secrets(&mut settings, &id);
    assert!(settings.get("sshPassword").is_none());
}

#[test]
fn plaintext_secrets_in_connections_json_are_moved_on_load() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    // A connections.json written before #4289, with secrets in plaintext.
    {
        let writer = manager(dir.path(), &Arc::new(RecordingStore::default()));
        writer
            .storage
            .save_flat(&FlatConnectionStore {
                connections: vec![tunnelled_vnc(), jump_ssh()],
                folders: Vec::new(),
                agents: Vec::new(),
            })
            .unwrap();
    }
    assert!(read(dir.path(), "connections.json").contains(GATEWAY));

    let mgr = manager(dir.path(), &store);
    mgr.migrate_credential_scopes();

    assert_no_secret(&read(dir.path(), "connections.json"), "connections.json");
    let desk = secret_fields::read_field_secrets(&*store, "Desk").unwrap();
    assert_eq!(
        desk.fields.get("sshPassword").map(String::as_str),
        Some(GATEWAY)
    );
    let target = secret_fields::read_field_secrets(&*store, "Target").unwrap();
    assert_eq!(
        target.hops.get("ops@bastion:22").map(String::as_str),
        Some(HOP)
    );
}

#[test]
fn a_failed_store_write_leaves_connections_json_untouched() {
    let dir = tempfile::tempdir().unwrap();
    {
        let writer = manager(dir.path(), &Arc::new(RecordingStore::default()));
        writer
            .storage
            .save_flat(&FlatConnectionStore {
                connections: vec![tunnelled_vnc()],
                folders: Vec::new(),
                agents: Vec::new(),
            })
            .unwrap();
    }
    let before = read(dir.path(), "connections.json");
    let store = Arc::new(RecordingStore {
        fail_sets: true,
        ..Default::default()
    });
    let mgr = manager(dir.path(), &store);
    mgr.migrate_credential_scopes();
    assert_eq!(read(dir.path(), "connections.json"), before);
    assert!(store.snapshot().is_empty());
}

#[test]
fn plaintext_secrets_in_an_external_file_are_moved_on_load() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let file = dir.path().join("shared.json").to_str().unwrap().to_string();
    std::fs::write(
        &file,
        serde_json::to_string(&json!({
            "name": "Shared", "fileId": "f-1", "version": "2",
            "children": [{ "type": "connection", "name": "Desk",
                           "config": { "type": "vnc", "config": tunnelled_vnc().config.settings } }]
        }))
        .unwrap(),
    )
    .unwrap();
    let mut settings = mgr.get_settings();
    settings.external_connection_files = vec![ExternalFileConfig {
        path: file.clone(),
        enabled: true,
    }];
    mgr.save_settings(settings).unwrap();

    let view = mgr.load_unified_view().unwrap();
    assert!(
        view.external_errors.is_empty(),
        "{:?}",
        view.external_errors
    );
    let loaded = view.connections.iter().find(|c| c.name == "Desk").unwrap();
    assert!(loaded.config.settings.get("sshPassword").is_none());
    assert_no_secret(&std::fs::read_to_string(&file).unwrap(), "external file");

    let mut connect = loaded.config.settings.clone();
    mgr.restore_saved_secrets(&mut connect, &loaded.id);
    assert_eq!(connect["sshPassword"], GATEWAY);
}

#[test]
fn field_secrets_are_read_and_saved_for_the_connect_prompt() {
    // The frontend connect flow reads stored field secrets and saves prompted
    // ones through the manager, scoped like every per-connection secret (#4429).
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let id = mgr.save_connection(tunnelled_vnc()).unwrap();

    let stored = mgr.stored_field_secrets(&id, None).unwrap();
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some(GATEWAY)
    );

    let mut prompted = termihub_core::connection::secrets::TakenSecrets::default();
    prompted.hops.insert("ops@bastion:22".into(), HOP.into());
    mgr.save_field_secrets(&id, None, prompted).unwrap();
    let stored = mgr.stored_field_secrets(&id, None).unwrap();
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some(GATEWAY),
        "saving merges over the stored secrets"
    );
    assert_eq!(
        stored.hops.get("ops@bastion:22").map(String::as_str),
        Some(HOP)
    );
}

#[test]
fn reading_field_secrets_from_a_locked_store_fails_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore {
        fail_gets: true,
        ..Default::default()
    });
    let mgr = manager(dir.path(), &store);
    assert!(mgr.stored_field_secrets("Desk", None).is_err());
    let mut prompted = termihub_core::connection::secrets::TakenSecrets::default();
    prompted.fields.insert("sshPassword".into(), GATEWAY.into());
    assert!(mgr.save_field_secrets("Desk", None, prompted).is_err());
    assert!(store.snapshot().is_empty());
}
