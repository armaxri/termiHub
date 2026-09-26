use super::*;
use crate::credential::{CredentialManager, NullStore};
use crate::terminal::backend::{ConnectionConfig, RemoteAgentConfig};
use serde_json::json;

/// An unlocked master-password manager in a temp dir.
fn unlocked_manager(dir: &Path) -> CredentialManager {
    let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
    mgr.with_master_password_store(|s| s.setup("master-pw"))
        .unwrap()
        .unwrap();
    mgr
}

fn conn(id: &str, name: &str, settings: Value) -> SavedConnection {
    SavedConnection {
        id: id.to_string(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings,
        },
        folder_id: None,
        terminal_options: None,
        icon: None,
        source_file: None,
    }
}

fn agent(id: &str, name: &str, credential_ref: Option<&str>) -> SavedRemoteAgent {
    SavedRemoteAgent {
        id: id.to_string(),
        name: name.to_string(),
        config: RemoteAgentConfig {
            credential_ref: credential_ref.map(str::to_string),
            ..RemoteAgentConfig::default()
        },
        agent_settings: Default::default(),
    }
}

#[test]
fn create_stores_secret_under_named_owner_and_lists_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let (reg, warnings) = NamedCredentialRegistry::load(dir.path());
    assert!(warnings.is_empty());

    let cred = reg
        .create(
            &mgr,
            &StorageMode::MasterPassword,
            "  Bastion  ",
            NamedCredentialKind::Password,
            "s3cret",
        )
        .unwrap();
    assert_eq!(cred.name, "Bastion");
    assert!(cred.id.starts_with("nc-"));
    assert_eq!(
        mgr.get(&secret_key(&cred.id, NamedCredentialKind::Password))
            .unwrap(),
        Some("s3cret".to_string())
    );
    assert_eq!(reg.list(), vec![cred.clone()]);

    // The metadata file never contains the secret.
    let raw = fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
    assert!(!raw.contains("s3cret"));
    assert!(raw.contains("Bastion"));

    // A fresh registry reloads it.
    let (reloaded, _) = NamedCredentialRegistry::load(dir.path());
    assert_eq!(reloaded.list(), vec![cred]);
}

#[test]
fn create_refused_when_storage_is_off() {
    let reg = NamedCredentialRegistry::in_memory();
    let err = reg
        .create(
            &NullStore,
            &StorageMode::None,
            "x",
            NamedCredentialKind::Password,
            "pw",
        )
        .unwrap_err();
    assert!(matches!(err, NamedCredentialError::StoreUnavailable { .. }));
    assert!(reg.list().is_empty());
}

#[test]
fn create_refused_when_store_locked() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    mgr.with_master_password_store(|s| s.lock()).unwrap();
    let reg = NamedCredentialRegistry::in_memory();
    let err = reg
        .create(
            &mgr,
            &StorageMode::MasterPassword,
            "x",
            NamedCredentialKind::Password,
            "pw",
        )
        .unwrap_err();
    assert!(matches!(err, NamedCredentialError::StoreLocked { .. }));
}

#[test]
fn create_validates_name_and_secret() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let mode = StorageMode::MasterPassword;
    let pw = NamedCredentialKind::Password;

    assert!(matches!(
        reg.create(&mgr, &mode, "  ", pw, "x"),
        Err(NamedCredentialError::Invalid { .. })
    ));
    assert!(matches!(
        reg.create(&mgr, &mode, "a", pw, ""),
        Err(NamedCredentialError::Invalid { .. })
    ));
    assert!(matches!(
        reg.create(&mgr, &mode, &"n".repeat(MAX_NAME_LEN + 1), pw, "x"),
        Err(NamedCredentialError::Invalid { .. })
    ));
    reg.create(&mgr, &mode, "Prod", pw, "x").unwrap();
    // Duplicate names are refused case-insensitively.
    assert!(matches!(
        reg.create(&mgr, &mode, "prod", pw, "y"),
        Err(NamedCredentialError::Invalid { .. })
    ));
    assert_eq!(reg.list().len(), 1);
}

#[test]
fn rotate_changes_the_secret_for_every_reference() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let mode = StorageMode::MasterPassword;
    let cred = reg
        .create(&mgr, &mode, "Shared", NamedCredentialKind::Password, "old")
        .unwrap();

    let rotated = reg.rotate(&mgr, &mode, &cred.id, "new").unwrap();
    assert!(rotated.rotated_at.is_some());
    assert_eq!(
        reg.resolve(&mgr, &cred.id, &CredentialType::Password)
            .unwrap(),
        Some("new".to_string())
    );
}

#[test]
fn rotate_unknown_or_empty_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let mode = StorageMode::MasterPassword;
    assert!(matches!(
        reg.rotate(&mgr, &mode, "nc-missing", "x"),
        Err(NamedCredentialError::NotFound { .. })
    ));
    let cred = reg
        .create(&mgr, &mode, "A", NamedCredentialKind::Password, "old")
        .unwrap();
    assert!(matches!(
        reg.rotate(&mgr, &mode, &cred.id, ""),
        Err(NamedCredentialError::Invalid { .. })
    ));
    assert_eq!(
        reg.resolve(&mgr, &cred.id, &CredentialType::Password)
            .unwrap(),
        Some("old".to_string())
    );
}

#[test]
fn rename_keeps_id_and_rejects_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let mode = StorageMode::MasterPassword;
    let a = reg
        .create(&mgr, &mode, "A", NamedCredentialKind::Password, "x")
        .unwrap();
    reg.create(&mgr, &mode, "B", NamedCredentialKind::Password, "y")
        .unwrap();

    let renamed = reg.rename(&a.id, "A2").unwrap();
    assert_eq!(renamed.id, a.id);
    assert_eq!(renamed.name, "A2");
    // Renaming to its own name (different case) is fine.
    reg.rename(&a.id, "a2").unwrap();
    assert!(matches!(
        reg.rename(&a.id, "b"),
        Err(NamedCredentialError::Invalid { .. })
    ));
    assert!(matches!(
        reg.rename("nc-missing", "Z"),
        Err(NamedCredentialError::NotFound { .. })
    ));
}

#[test]
fn delete_in_use_is_refused_and_lists_users() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let mode = StorageMode::MasterPassword;
    let cred = reg
        .create(&mgr, &mode, "Shared", NamedCredentialKind::Password, "x")
        .unwrap();

    let connections = vec![
        conn("web", "web", json!({ SETTINGS_REF_KEY: cred.id })),
        conn("db", "Db", json!({ SETTINGS_REF_KEY: cred.id })),
        conn("other", "Other", json!({ SETTINGS_REF_KEY: "nc-else" })),
        conn("plain", "Plain", json!({})),
    ];
    let agents = vec![
        agent("ag", "Agent", Some(&cred.id)),
        agent("ag2", "A2", None),
    ];
    let usages = find_usages(&cred.id, &connections, &agents);
    let names: Vec<&str> = usages.iter().map(|u| u.owner_name.as_str()).collect();
    assert_eq!(names, vec!["Agent", "Db", "web"]);
    assert_eq!(usages[0].owner_kind, "agent");

    match reg.delete(&mgr, &mode, &cred.id, usages) {
        Err(NamedCredentialError::InUse { usages, message }) => {
            assert_eq!(usages.len(), 3);
            assert!(message.contains("3 connections"));
        }
        other => panic!("expected InUse, got {other:?}"),
    }
    // Nothing was removed.
    assert!(reg.get(&cred.id).is_some());
    assert!(reg
        .resolve(&mgr, &cred.id, &CredentialType::Password)
        .unwrap()
        .is_some());
}

#[test]
fn delete_unused_removes_metadata_and_secret() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let (reg, _) = NamedCredentialRegistry::load(dir.path());
    let mode = StorageMode::MasterPassword;
    let cred = reg
        .create(&mgr, &mode, "Old", NamedCredentialKind::KeyPassphrase, "x")
        .unwrap();
    reg.delete(&mgr, &mode, &cred.id, Vec::new()).unwrap();
    assert!(reg.list().is_empty());
    assert_eq!(
        mgr.get(&secret_key(&cred.id, NamedCredentialKind::KeyPassphrase))
            .unwrap(),
        None
    );
    let (reloaded, _) = NamedCredentialRegistry::load(dir.path());
    assert!(reloaded.list().is_empty());
}

#[test]
fn delete_with_locked_store_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let mode = StorageMode::MasterPassword;
    let cred = reg
        .create(&mgr, &mode, "X", NamedCredentialKind::Password, "x")
        .unwrap();
    mgr.with_master_password_store(|s| s.lock()).unwrap();
    assert!(matches!(
        reg.delete(&mgr, &mode, &cred.id, Vec::new()),
        Err(NamedCredentialError::StoreLocked { .. })
    ));
    assert!(reg.get(&cred.id).is_some());
}

#[test]
fn resolve_returns_none_for_unknown_or_mismatched_kind() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let mode = StorageMode::MasterPassword;
    let cred = reg
        .create(
            &mgr,
            &mode,
            "Key",
            NamedCredentialKind::KeyPassphrase,
            "phrase",
        )
        .unwrap();

    assert_eq!(
        reg.resolve(&mgr, "nc-unknown", &CredentialType::Password)
            .unwrap(),
        None
    );
    // A password-auth connection referencing a passphrase credential gets nothing.
    assert_eq!(
        reg.resolve(&mgr, &cred.id, &CredentialType::Password)
            .unwrap(),
        None
    );
    assert_eq!(
        reg.resolve(&mgr, &cred.id, &CredentialType::KeyPassphrase)
            .unwrap(),
        Some("phrase".to_string())
    );
}

#[test]
fn resolve_on_locked_store_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let cred = reg
        .create(
            &mgr,
            &StorageMode::MasterPassword,
            "X",
            NamedCredentialKind::Password,
            "x",
        )
        .unwrap();
    mgr.with_master_password_store(|s| s.lock()).unwrap();
    assert!(reg
        .resolve(&mgr, &cred.id, &CredentialType::Password)
        .is_err());
}

#[test]
fn settings_ref_ignores_empty_and_non_string_values() {
    assert_eq!(settings_ref(&json!({})), None);
    assert_eq!(settings_ref(&json!({ SETTINGS_REF_KEY: "" })), None);
    assert_eq!(settings_ref(&json!({ SETTINGS_REF_KEY: "   " })), None);
    assert_eq!(settings_ref(&json!({ SETTINGS_REF_KEY: 5 })), None);
    assert_eq!(
        settings_ref(&json!({ SETTINGS_REF_KEY: "nc-1" })),
        Some("nc-1")
    );
}

#[test]
fn secret_keys_and_owner_labels_cover_every_credential() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let mode = StorageMode::MasterPassword;
    let a = reg
        .create(&mgr, &mode, "A", NamedCredentialKind::Password, "x")
        .unwrap();
    let b = reg
        .create(&mgr, &mode, "B", NamedCredentialKind::KeyPassphrase, "y")
        .unwrap();
    let keys: Vec<String> = reg.secret_keys().iter().map(|k| k.to_string()).collect();
    assert!(keys.contains(&format!("named-credential:{}:password", a.id)));
    assert!(keys.contains(&format!("named-credential:{}:key_passphrase", b.id)));
    let labels = reg.owner_labels();
    assert!(labels
        .iter()
        .any(|(id, name)| id == &owner_id(&a.id) && name == "A (shared credential)"));
    assert!(owner_id(&b.id).starts_with(OWNER_PREFIX));
}

#[test]
fn newer_file_is_left_untouched_and_not_overwritten() {
    // Downgrade safety (PER-004): a file written by a newer schema loads as
    // empty with a warning, and a later change must not overwrite it.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    let newer = r#"{"version":"99","credentials":[],"futureField":true}"#;
    fs::write(&path, newer).unwrap();

    let (reg, warnings) = NamedCredentialRegistry::load(dir.path());
    assert!(!warnings.is_empty());
    assert!(reg.list().is_empty());

    let mgr = unlocked_manager(dir.path());
    let err = reg
        .create(
            &mgr,
            &StorageMode::MasterPassword,
            "X",
            NamedCredentialKind::Password,
            "secret-x",
        )
        .unwrap_err();
    assert!(matches!(err, NamedCredentialError::Other { .. }));
    assert_eq!(fs::read_to_string(&path).unwrap(), newer);
    // The secret written before the refused metadata save was rolled back.
    assert!(mgr.list_keys().unwrap().is_empty());
}

#[test]
fn corrupt_entry_is_dropped_and_others_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    fs::write(
        &path,
        r#"{"version":"1","credentials":[
            {"id":"nc-1","name":"Good","kind":"password","createdAt":"t"},
            {"id":"nc-2","name":"Bad","kind":"telepathy","createdAt":"t"}
        ]}"#,
    )
    .unwrap();
    let (reg, warnings) = NamedCredentialRegistry::load(dir.path());
    assert_eq!(warnings.len(), 1);
    let ids: Vec<String> = reg.list().into_iter().map(|c| c.id).collect();
    assert_eq!(ids, vec!["nc-1"]);
}

#[test]
fn unknown_top_level_fields_survive_a_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    fs::write(&path, r#"{"version":"1","credentials":[],"note":"keep"}"#).unwrap();
    let (reg, _) = NamedCredentialRegistry::load(dir.path());
    let mgr = unlocked_manager(dir.path());
    reg.create(
        &mgr,
        &StorageMode::MasterPassword,
        "X",
        NamedCredentialKind::Password,
        "x",
    )
    .unwrap();
    let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(raw["note"], "keep");
    assert_eq!(raw["version"], "1");
}

#[test]
fn error_serializes_with_kind_tag_and_usages() {
    let err = NamedCredentialError::InUse {
        message: "m".to_string(),
        usages: vec![NamedCredentialUsage {
            owner_kind: "connection".to_string(),
            owner_id: "c".to_string(),
            owner_name: "C".to_string(),
        }],
    };
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "inUse");
    assert_eq!(v["usages"][0]["ownerName"], "C");
}
