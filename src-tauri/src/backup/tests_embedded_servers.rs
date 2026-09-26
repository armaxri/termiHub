//! Backup and restore of embedded servers now that their passwords live in the
//! credential store (#3514, #3520): a backup never carries one in the section,
//! and an older backup's plaintext passwords are moved into the credential
//! store on restore — never written back to `embedded_servers.json`.

use std::path::Path;

use serde_json::{json, Value};

use super::pending::apply_pending_restore;
use super::restore::{self, PENDING_DIR, STAGING_DIR};
use super::tests::{
    assert_not_on_disk, choice, mp_manager, no_creds, options, raw_backup, read_doc, request,
    restore_and_boot, write_doc, SERVER_SECRET,
};
use super::*;
use crate::credential::types::{CredentialKey, CredentialType, StorageMode};
use crate::credential::vault::{ConflictStrategy, VaultError};
use crate::credential::{CredentialManager, CredentialStore};
use crate::embedded_servers::config::EmbeddedServerStore;

const FILE: &str = "embedded_servers.json";
const HTTP_SECRET: &str = "sentinel-http-password-5be2";

fn ftp_key(id: &str) -> CredentialKey {
    CredentialKey::new(
        &format!("embedded-server:{id}:ftp"),
        CredentialType::Password,
    )
}

fn http_key(id: &str) -> CredentialKey {
    CredentialKey::new(
        &format!("embedded-server:{id}:http"),
        CredentialType::Password,
    )
}

fn ftp_server(id: &str, name: &str, password: Option<&str>) -> Value {
    let mut auth = json!({"type": "credentials", "username": "u"});
    if let Some(password) = password {
        auth["password"] = json!(password);
    }
    json!({"id": id, "name": name, "serverType": "ftp", "rootDirectory": "/tmp",
           "bindHost": "127.0.0.1", "port": 2121, "ftpAuth": auth})
}

fn http_server(id: &str, password: Option<&str>) -> Value {
    let mut auth = json!({"username": "web"});
    if let Some(password) = password {
        auth["password"] = json!(password);
    }
    json!({"id": id, "name": "Web", "serverType": "http", "rootDirectory": "/tmp",
           "bindHost": "127.0.0.1", "port": 8080, "httpAuth": auth})
}

/// An `embedded_servers.json` v1 document (before #3514) with plaintext
/// passwords.
fn legacy_doc() -> Value {
    json!({"version": "1", "servers": [
        ftp_server("s1", "FTP", Some(SERVER_SECRET)),
        http_server("s2", Some(HTTP_SECRET)),
    ]})
}

fn current_doc(servers: Vec<Value>) -> Value {
    json!({"version": EmbeddedServerStore::CURRENT_VERSION.to_string(), "servers": servers})
}

/// A backup as the #3516 build wrote it: a v1 section with plaintext passwords.
fn legacy_backup() -> String {
    raw_backup(
        vec![BackupSection {
            id: "embeddedServers".into(),
            schema_version: 1,
            data: legacy_doc(),
        }],
        BACKUP_FORMAT_VERSION,
    )
}

fn replace() -> BackupRestoreRequest {
    request(vec![choice(
        "embeddedServers",
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )])
}

fn merge(conflicts: ConflictStrategy) -> BackupRestoreRequest {
    request(vec![choice(
        "embeddedServers",
        RestoreMode::Merge,
        conflicts,
    )])
}

fn stored(mgr: &CredentialManager, key: &CredentialKey) -> Option<String> {
    mgr.get(key).unwrap()
}

/// The restored file holds no password at all (not even an empty one) and is
/// at the current schema version.
fn assert_file_has_no_passwords(dir: &Path) {
    let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
    assert!(!text.contains("password"), "{text}");
    assert_eq!(
        read_doc(dir, FILE)["version"],
        EmbeddedServerStore::CURRENT_VERSION.to_string()
    );
}

fn boot(dir: &Path) {
    assert!(apply_pending_restore(dir).is_none());
}

// --- export ---

#[test]
fn embedded_servers_no_longer_need_an_encrypted_backup() {
    let infos = export::section_infos(tempfile::tempdir().unwrap().path());
    let info = infos.iter().find(|i| i.id == "embeddedServers").unwrap();
    assert!(!info.contains_secrets && !info.requires_encryption);
}

#[test]
fn plain_backup_carries_server_config_without_passwords() {
    let src = tempfile::tempdir().unwrap();
    write_doc(
        src.path(),
        FILE,
        &current_doc(vec![ftp_server("s1", "FTP", None)]),
    );
    let built = export::build(
        src.path(),
        &options(&["embeddedServers"], false, false),
        None,
        None,
        "t".into(),
        "v".into(),
    )
    .unwrap();
    assert_eq!(built.sections, vec!["embeddedServers"]);
    assert!(built.warnings.is_empty(), "{:?}", built.warnings);
    assert!(!built.json.contains("password"), "{}", built.json);

    let opened = restore::open(&built.json, None).unwrap();
    let section = &opened.sections[0];
    assert_eq!(section.schema_version, EmbeddedServerStore::CURRENT_VERSION);
    assert_eq!(section.data["servers"][0]["ftpAuth"]["username"], "u");
}

/// A file still holding legacy plaintext (its move into a locked store is
/// pending) is backed up migrated — without the passwords — and says so.
#[test]
fn legacy_plaintext_on_disk_is_left_out_of_the_backup() {
    let src = tempfile::tempdir().unwrap();
    write_doc(src.path(), FILE, &legacy_doc());
    for encrypt in [false, true] {
        let built = export::build(
            src.path(),
            &options(&["embeddedServers"], encrypt, false),
            encrypt.then_some(super::tests::PASSPHRASE),
            None,
            "t".into(),
            "v".into(),
        )
        .unwrap();
        assert_eq!(built.warnings.len(), 1, "{:?}", built.warnings);
        assert!(built.warnings[0].contains("2 password(s)"));
        let opened = restore::open(&built.json, Some(super::tests::PASSPHRASE)).unwrap();
        let section = &opened.sections[0];
        assert_eq!(section.schema_version, EmbeddedServerStore::CURRENT_VERSION);
        let data = section.data.to_string();
        assert!(!data.contains("password"), "{data}");
        assert!(!data.contains(SERVER_SECRET) && !data.contains(HTTP_SECRET));
    }
}

// --- restore of an older backup ---

#[test]
fn v1_section_plaintext_moves_into_the_credential_store() {
    let json = legacy_backup();
    let dst = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dst.path());
    let opened = restore::open(&json, None).unwrap();

    let preview = restore::plan(&opened, dst.path(), no_creds);
    let section = &preview.sections[0];
    assert_eq!(section.status, SectionStatus::Migrated);
    assert_eq!(section.new_count, 2);
    assert!(
        section.notes.iter().any(|n| n.contains("2 password(s)")),
        "{:?}",
        section.notes
    );

    restore::apply(&opened, dst.path(), &replace(), Some(&mgr)).unwrap();
    boot(dst.path());
    assert_file_has_no_passwords(dst.path());
    assert_eq!(read_doc(dst.path(), FILE)["servers"][0]["id"], "s1");
    assert_eq!(stored(&mgr, &ftp_key("s1")).as_deref(), Some(SERVER_SECRET));
    assert_eq!(stored(&mgr, &http_key("s2")).as_deref(), Some(HTTP_SECRET));
    // Only the (encrypted) credential store holds them.
    assert_not_on_disk(dst.path(), SERVER_SECRET);
    assert_not_on_disk(dst.path(), HTTP_SECRET);
}

#[test]
fn v1_section_plaintext_with_a_locked_store_refuses_the_restore() {
    let json = legacy_backup();
    let dst = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dst.path());
    mgr.with_master_password_store(|s| s.lock()).unwrap();
    let opened = restore::open(&json, None).unwrap();

    let err = restore::apply(&opened, dst.path(), &replace(), Some(&mgr)).unwrap_err();
    assert!(matches!(err, VaultError::StoreLocked { .. }), "{err:?}");
    assert!(!dst.path().join(FILE).exists());
    assert!(!dst.path().join(PENDING_DIR).exists());
    assert!(!dst.path().join(STAGING_DIR).exists());
}

/// With credential storage off there is nowhere to keep them: the servers are
/// restored without passwords (the preview warned), never with plaintext.
#[test]
fn v1_section_plaintext_without_a_store_is_dropped() {
    let json = legacy_backup();
    for mgr in [
        None,
        Some(CredentialManager::new(
            StorageMode::None,
            tempfile::tempdir().unwrap().path().to_path_buf(),
        )),
    ] {
        let dst = tempfile::tempdir().unwrap();
        let opened = restore::open(&json, None).unwrap();
        let store = mgr.as_ref().map(|m| m as &dyn CredentialStore);
        restore::apply(&opened, dst.path(), &replace(), store).unwrap();
        boot(dst.path());
        assert_file_has_no_passwords(dst.path());
        assert_not_on_disk(dst.path(), SERVER_SECRET);
        assert_not_on_disk(dst.path(), HTTP_SECRET);
    }
}

/// A merge that keeps the current server keeps its stored password; one that
/// takes the backup's server takes the backup's password.
#[test]
fn v1_section_plaintext_follows_the_merge_strategy() {
    for (strategy, expected) in [
        (ConflictStrategy::Skip, "current-pw"),
        (ConflictStrategy::Overwrite, SERVER_SECRET),
    ] {
        let dst = tempfile::tempdir().unwrap();
        let mgr = mp_manager(dst.path());
        write_doc(
            dst.path(),
            FILE,
            &current_doc(vec![ftp_server("s1", "Renamed here", None)]),
        );
        mgr.set(&ftp_key("s1"), "current-pw").unwrap();

        let json = legacy_backup();
        let opened = restore::open(&json, None).unwrap();
        restore::apply(&opened, dst.path(), &merge(strategy), Some(&mgr)).unwrap();
        boot(dst.path());
        assert_file_has_no_passwords(dst.path());
        assert_eq!(
            stored(&mgr, &ftp_key("s1")).as_deref(),
            Some(expected),
            "{strategy:?}"
        );
        // The new server s2 is added either way, with its password.
        assert_eq!(stored(&mgr, &http_key("s2")).as_deref(), Some(HTTP_SECRET));
    }
}

/// Merging into a current file that still holds legacy plaintext (its move
/// into the store was pending) moves those passwords too: the restored file is
/// written without any, so they must not be lost.
#[test]
fn merging_over_a_legacy_current_file_moves_its_passwords_too() {
    let src = tempfile::tempdir().unwrap();
    write_doc(
        src.path(),
        FILE,
        &current_doc(vec![ftp_server("s9", "Other", None)]),
    );
    let json = export::build(
        src.path(),
        &options(&["embeddedServers"], false, false),
        None,
        None,
        "t".into(),
        "v".into(),
    )
    .unwrap()
    .json;

    let dst = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dst.path());
    write_doc(dst.path(), FILE, &legacy_doc());
    let opened = restore::open(&json, None).unwrap();
    restore::apply(
        &opened,
        dst.path(),
        &merge(ConflictStrategy::Skip),
        Some(&mgr),
    )
    .unwrap();
    boot(dst.path());
    assert_file_has_no_passwords(dst.path());
    assert_eq!(read_doc(dst.path(), FILE)["servers"][2]["id"], "s9");
    assert_eq!(stored(&mgr, &ftp_key("s1")).as_deref(), Some(SERVER_SECRET));
    assert_eq!(stored(&mgr, &http_key("s2")).as_deref(), Some(HTTP_SECRET));
    assert_not_on_disk(dst.path(), SERVER_SECRET);
}

/// A same-build round trip through a plain backup: the server comes back
/// without a password in the file.
#[test]
fn current_section_round_trips_without_touching_the_store() {
    let src = tempfile::tempdir().unwrap();
    write_doc(
        src.path(),
        FILE,
        &current_doc(vec![ftp_server("s1", "FTP", None)]),
    );
    let json = export::build(
        src.path(),
        &options(&["embeddedServers"], false, false),
        None,
        None,
        "t".into(),
        "v".into(),
    )
    .unwrap()
    .json;
    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, None).unwrap();
    let preview = restore::plan(&opened, dst.path(), no_creds);
    assert_eq!(preview.sections[0].status, SectionStatus::Ok);
    assert!(preview.sections[0].notes.is_empty());
    restore_and_boot(&json, dst.path(), &replace());
    assert_file_has_no_passwords(dst.path());
}

/// The credential preview labels embedded-server passwords by their server.
#[test]
fn backup_owner_names_label_embedded_server_credentials() {
    let json = legacy_backup();
    let opened = restore::open(&json, None).unwrap();
    let owners = restore::backup_owner_names(&opened);
    assert_eq!(
        owners.get("embedded-server:s1:ftp").map(String::as_str),
        Some("FTP (FTP login)")
    );
    assert_eq!(
        owners.get("embedded-server:s2:http").map(String::as_str),
        Some("Web (HTTP Basic auth)")
    );
}
