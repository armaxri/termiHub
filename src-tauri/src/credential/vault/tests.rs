//! Tests for the credential-vault export/import (PROD-063).

use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use std::collections::HashMap;

use zeroize::Zeroizing;

use super::import::{check_format_version, open, parse};
use super::*;
use crate::credential::crypto::{encrypt_with_password, Argon2Cost};
use crate::credential::types::CredentialType;
use crate::credential::{CredentialStore, MasterPasswordStore};

const PASSPHRASE: &str = "correct horse battery staple";
const SECRET_A: &str = "sentinel-secret-alpha-7f3c";
const SECRET_B: &str = "sentinel-secret-bravo-19ad";

fn key(id: &str, t: CredentialType) -> CredentialKey {
    CredentialKey::new(id, t)
}

fn unlocked_store(dir: &Path) -> MasterPasswordStore {
    let store = MasterPasswordStore::new(dir.join("credentials.enc"));
    store.setup("master-pw").unwrap();
    store
}

fn sample_export() -> String {
    let entries: Vec<VaultSecret> = vec![
        (
            key("conn-a", CredentialType::Password),
            Zeroizing::new(SECRET_A.to_string()),
        ),
        (
            key("conn-b", CredentialType::KeyPassphrase),
            Zeroizing::new(SECRET_B.to_string()),
        ),
    ];
    to_json(&seal(&entries, PASSPHRASE, "2026-09-26T00:00:00+00:00".into()).unwrap()).unwrap()
}

/// Every file under `dir`, recursively, must not contain any of `needles`.
fn assert_no_plaintext_on_disk(dir: &Path, needles: &[&str]) {
    for entry in walk(dir) {
        let bytes = std::fs::read(&entry).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        for needle in needles {
            assert!(
                !text.contains(needle),
                "plaintext secret found on disk in {}",
                entry.display()
            );
        }
    }
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[test]
fn round_trip_export_then_import_into_empty_store() {
    let src_dir = tempfile::tempdir().unwrap();
    let src = unlocked_store(src_dir.path());
    src.set(&key("conn-a", CredentialType::Password), SECRET_A)
        .unwrap();
    src.set(&key("conn-b", CredentialType::SudoPassword), SECRET_B)
        .unwrap();

    let entries = collect_entries(&src, &[]).unwrap();
    assert_eq!(entries.len(), 2);
    let json = to_json(&seal(&entries, PASSPHRASE, "t".into()).unwrap()).unwrap();
    assert!(!json.contains(SECRET_A) && !json.contains(SECRET_B));

    let dst_dir = tempfile::tempdir().unwrap();
    let dst = unlocked_store(dst_dir.path());
    let vault = open_json(&json, PASSPHRASE).unwrap();
    let result = apply_import(&vault, &dst, ConflictStrategy::Skip).unwrap();
    assert_eq!(result.imported_count, 2);

    dst.lock();
    dst.unlock("master-pw").unwrap();
    assert_eq!(
        dst.get(&key("conn-a", CredentialType::Password)).unwrap(),
        Some(SECRET_A.to_string())
    );
    assert_eq!(
        dst.get(&key("conn-b", CredentialType::SudoPassword))
            .unwrap(),
        Some(SECRET_B.to_string())
    );
}

#[test]
fn export_file_has_versioned_header_and_envelope() {
    let json = sample_export();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["format"], VAULT_FORMAT_ID);
    assert_eq!(value["formatVersion"], VAULT_FORMAT_VERSION);
    assert_eq!(value["envelope"]["kdf"]["algorithm"], "argon2id");
    assert!(value["envelope"]["kdf"]["salt"].is_string());
    assert!(value["envelope"]["nonce"].is_string());
    assert!(value["envelope"]["version"].is_number());
    // No secret metadata in the clear.
    assert!(!json.contains("conn-a"));
    assert!(!json.contains(SECRET_A));
}

#[test]
fn export_is_sealed_with_the_current_argon2_cost() {
    // Outside cfg(test), `current()` is compile-time pinned to production.
    let file = parse(&sample_export()).unwrap();
    assert_eq!(
        Argon2Cost::from_kdf(&file.envelope.kdf).unwrap(),
        Argon2Cost::current()
    );
}

#[test]
fn wrong_passphrase_is_a_clear_typed_error() {
    let result = open_json(&sample_export(), "not the right passphrase");
    assert!(matches!(result, Err(VaultError::WrongPassphrase { .. })));
}

#[test]
fn tampered_ciphertext_fails_authentication() {
    let mut file = parse(&sample_export()).unwrap();
    let mut data = BASE64.decode(&file.envelope.data).unwrap();
    data[0] ^= 0x01;
    file.envelope.data = BASE64.encode(data);
    assert!(matches!(
        open(&file, PASSPHRASE),
        Err(VaultError::WrongPassphrase { .. })
    ));
}

#[test]
fn tampered_header_is_detected() {
    // A header bumped to an unreadable version is rejected up-front ...
    let mut value: serde_json::Value = serde_json::from_str(&sample_export()).unwrap();
    value["formatVersion"] = serde_json::json!(VAULT_FORMAT_VERSION + 1);
    assert!(matches!(
        open_json(&value.to_string(), PASSPHRASE),
        Err(VaultError::UnsupportedVersion { .. })
    ));

    // ... and a header whose format id no longer matches is not a vault.
    let mut value: serde_json::Value = serde_json::from_str(&sample_export()).unwrap();
    value["format"] = serde_json::json!("something-else");
    assert!(matches!(
        open_json(&value.to_string(), PASSPHRASE),
        Err(VaultError::InvalidFile { .. })
    ));
}

/// Seal an arbitrary payload JSON into an otherwise-valid v1 file.
fn file_with_payload(payload: serde_json::Value) -> VaultExportFile {
    VaultExportFile {
        format: VAULT_FORMAT_ID.into(),
        format_version: VAULT_FORMAT_VERSION,
        created_at: "t".into(),
        envelope: encrypt_with_password(PASSPHRASE, payload.to_string().as_bytes()).unwrap(),
    }
}

#[test]
fn header_payload_mismatch_is_rejected() {
    // The header is in the clear; the sealed payload repeats the format
    // version, so a header that disagrees with it means the file was edited.
    let file = file_with_payload(serde_json::json!({
        "format": VAULT_FORMAT_ID,
        "formatVersion": VAULT_FORMAT_VERSION + 7,
        "entries": []
    }));
    assert!(matches!(
        open(&file, PASSPHRASE),
        Err(VaultError::InvalidFile { .. })
    ));
}

#[test]
fn newer_and_too_old_format_versions_are_rejected() {
    assert!(matches!(
        check_format_version(VAULT_FORMAT_VERSION + 1),
        Err(VaultError::UnsupportedVersion { ref message }) if message.contains("newer")
    ));
    assert!(matches!(
        check_format_version(MIN_SUPPORTED_VAULT_FORMAT_VERSION - 1),
        Err(VaultError::UnsupportedVersion { ref message }) if message.contains("no longer")
    ));
    assert!(check_format_version(VAULT_FORMAT_VERSION).is_ok());
}

#[test]
fn newer_envelope_version_is_reported_as_unsupported() {
    let mut file = parse(&sample_export()).unwrap();
    file.envelope.version += 1;
    assert!(matches!(
        open(&file, PASSPHRASE),
        Err(VaultError::UnsupportedVersion { .. })
    ));
}

#[test]
fn non_vault_json_is_invalid_file() {
    assert!(matches!(
        parse("{\"version\":\"2\",\"children\":[]}"),
        Err(VaultError::InvalidFile { .. })
    ));
    assert!(matches!(
        parse("not json"),
        Err(VaultError::InvalidFile { .. })
    ));
}

#[test]
fn oversized_file_is_rejected_before_parsing() {
    let huge = " ".repeat(MAX_VAULT_FILE_BYTES + 1);
    assert!(matches!(parse(&huge), Err(VaultError::InvalidFile { .. })));
}

fn store_with_existing(dir: &Path) -> MasterPasswordStore {
    let store = unlocked_store(dir);
    store
        .set(&key("conn-a", CredentialType::Password), "existing-a")
        .unwrap();
    store
        .set(&key("conn-b", CredentialType::KeyPassphrase), SECRET_B)
        .unwrap();
    store
}

#[test]
fn preview_reports_new_unchanged_conflicts_and_unknown_owners() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_existing(dir.path());
    let mut extra_entries = open_json(&sample_export(), PASSPHRASE).unwrap();
    extra_entries.entries.push((
        key("conn-c", CredentialType::Password),
        Zeroizing::new("brand-new".to_string()),
    ));

    let owners: HashMap<String, String> = [
        ("conn-a".to_string(), "Prod DB".to_string()),
        ("conn-b".to_string(), "Router".to_string()),
    ]
    .into_iter()
    .collect();
    let preview = plan_import(
        &extra_entries,
        &store,
        &StorageMode::MasterPassword,
        &owners,
    )
    .unwrap();

    assert_eq!(preview.total_count, 3);
    assert_eq!(preview.new_count, 1);
    assert_eq!(preview.unchanged_count, 1);
    assert_eq!(preview.conflict_count, 1);
    assert_eq!(
        preview.conflicts,
        vec![VaultConflict {
            connection_id: "conn-a".into(),
            credential_type: "password".into(),
            owner_name: Some("Prod DB".into()),
        }]
    );
    assert_eq!(preview.unknown_owner_count, 1);
    assert_eq!(preview.target_mode, "master_password");
    // The preview must not carry any secret value.
    let json = serde_json::to_string(&preview).unwrap();
    assert!(!json.contains(SECRET_A) && !json.contains("existing-a"));
}

#[test]
fn skip_strategy_keeps_existing_values() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_existing(dir.path());
    let vault = open_json(&sample_export(), PASSPHRASE).unwrap();

    let result = apply_import(&vault, &store, ConflictStrategy::Skip).unwrap();
    assert_eq!(
        result,
        VaultImportResult {
            imported_count: 0,
            overwritten_count: 0,
            skipped_count: 1,
            unchanged_count: 1,
        }
    );
    assert_eq!(
        store.get(&key("conn-a", CredentialType::Password)).unwrap(),
        Some("existing-a".to_string())
    );
}

#[test]
fn overwrite_strategy_replaces_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_existing(dir.path());
    let vault = open_json(&sample_export(), PASSPHRASE).unwrap();

    let result = apply_import(&vault, &store, ConflictStrategy::Overwrite).unwrap();
    assert_eq!(result.overwritten_count, 1);
    assert_eq!(result.unchanged_count, 1);
    assert_eq!(
        store.get(&key("conn-a", CredentialType::Password)).unwrap(),
        Some(SECRET_A.to_string())
    );
}

#[test]
fn wrong_passphrase_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = unlocked_store(dir.path());
    let before = std::fs::read(dir.path().join("credentials.enc")).unwrap();

    assert!(open_json(&sample_export(), "wrong wrong wrong").is_err());

    assert!(store.list_keys().unwrap().is_empty());
    assert_eq!(
        std::fs::read(dir.path().join("credentials.enc")).unwrap(),
        before
    );
}

/// A store whose `set` fails on a chosen key, to prove the batch is
/// all-or-nothing through the default `set_many` rollback.
struct FlakyStore {
    map: Mutex<HashMap<String, String>>,
    fail_on: String,
}

impl CredentialStore for FlakyStore {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        Ok(self.map.lock().unwrap().get(&key.to_string()).cloned())
    }
    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        if key.to_string() == self.fail_on {
            anyhow::bail!("simulated write failure");
        }
        self.map
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn remove(&self, key: &CredentialKey) -> Result<()> {
        self.map.lock().unwrap().remove(&key.to_string());
        Ok(())
    }
    fn remove_all_for_connection(&self, _connection_id: &str) -> Result<()> {
        Ok(())
    }
    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        Ok(Vec::new())
    }
    fn status(&self) -> CredentialStoreStatus {
        CredentialStoreStatus::Unlocked
    }
}

#[test]
fn failed_write_mid_import_rolls_back_everything() {
    let store = FlakyStore {
        map: Mutex::new(
            [("conn-a:password".to_string(), "existing-a".to_string())]
                .into_iter()
                .collect(),
        ),
        fail_on: "conn-b:key_passphrase".to_string(),
    };
    let vault = open_json(&sample_export(), PASSPHRASE).unwrap();

    let result = apply_import(&vault, &store, ConflictStrategy::Overwrite);
    assert!(result.is_err());
    let map = store.map.lock().unwrap();
    assert_eq!(
        map.get("conn-a:password").map(String::as_str),
        Some("existing-a"),
        "the already-overwritten entry must be restored"
    );
    assert!(!map.contains_key("conn-b:key_passphrase"));
}

#[test]
fn no_plaintext_reaches_disk_during_export_and_import() {
    let src_dir = tempfile::tempdir().unwrap();
    let src = unlocked_store(src_dir.path());
    src.set(&key("conn-a", CredentialType::Password), SECRET_A)
        .unwrap();
    let entries = collect_entries(&src, &[]).unwrap();
    let before: Vec<_> = walk(src_dir.path());
    let json = to_json(&seal(&entries, PASSPHRASE, "t".into()).unwrap()).unwrap();
    // Export produces text only — no new files, no temp artifacts.
    assert_eq!(walk(src_dir.path()), before);
    assert!(!json.contains(SECRET_A));
    assert_no_plaintext_on_disk(src_dir.path(), &[SECRET_A]);

    let dst_dir = tempfile::tempdir().unwrap();
    let dst = unlocked_store(dst_dir.path());
    let vault = open_json(&json, PASSPHRASE).unwrap();
    apply_import(&vault, &dst, ConflictStrategy::Overwrite).unwrap();
    // Only the encrypted store file exists afterwards (no leftover temp).
    assert_eq!(
        walk(dst_dir.path()),
        vec![dst_dir.path().join("credentials.enc")]
    );
    assert_no_plaintext_on_disk(dst_dir.path(), &[SECRET_A]);
}

#[test]
fn collect_entries_probes_known_owner_ids() {
    // The OS keychain lists no keys; saved connection/agent ids are probed.
    let store = FlakyStore {
        map: Mutex::new(
            [
                ("conn-x:password".to_string(), "x".to_string()),
                ("agent-1:key_passphrase".to_string(), "y".to_string()),
            ]
            .into_iter()
            .collect(),
        ),
        fail_on: String::new(),
    };
    let entries = collect_entries(&store, &["conn-x".to_string(), "agent-1".to_string()]).unwrap();
    let keys: Vec<String> = entries.iter().map(|(k, _)| k.to_string()).collect();
    assert_eq!(keys, vec!["agent-1:key_passphrase", "conn-x:password"]);
}

#[test]
fn export_passphrase_rules() {
    assert!(matches!(
        validate_export_passphrase("short", None),
        Err(VaultError::WeakPassphrase { .. })
    ));
    assert!(matches!(
        validate_export_passphrase("same-as-master-pw", Some("same-as-master-pw")),
        Err(VaultError::WeakPassphrase { .. })
    ));
    assert!(validate_export_passphrase(PASSPHRASE, Some("master-pw")).is_ok());
}

#[test]
fn duplicate_and_unknown_type_entries_are_rejected() {
    let file = file_with_payload(serde_json::json!({
        "format": VAULT_FORMAT_ID,
        "formatVersion": VAULT_FORMAT_VERSION,
        "entries": [
            {"connectionId": "c", "credentialType": "password", "value": "1"},
            {"connectionId": "c", "credentialType": "password", "value": "2"}
        ]
    }));
    assert!(matches!(
        open(&file, PASSPHRASE),
        Err(VaultError::InvalidFile { .. })
    ));

    let file = file_with_payload(serde_json::json!({
        "format": VAULT_FORMAT_ID,
        "formatVersion": VAULT_FORMAT_VERSION,
        "entries": [{"connectionId": "c", "credentialType": "totp_seed", "value": "1"}]
    }));
    assert!(matches!(
        open(&file, PASSPHRASE),
        Err(VaultError::UnsupportedVersion { .. })
    ));
}

// --- authorization (re-auth, locked store) ---

fn mp_manager(dir: &Path) -> CredentialManager {
    let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
    mgr.with_master_password_store(|s| s.setup("master-pw"))
        .unwrap()
        .unwrap();
    mgr
}

#[test]
fn export_refused_when_store_locked() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dir.path());
    mgr.with_master_password_store(|s| s.lock()).unwrap();
    assert!(matches!(
        authorize_export(&mgr, Some("master-pw")),
        Err(VaultError::StoreLocked { .. })
    ));
}

#[test]
fn export_requires_correct_master_password() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dir.path());
    assert!(matches!(
        authorize_export(&mgr, None),
        Err(VaultError::WrongMasterPassword { .. })
    ));
    assert!(matches!(
        authorize_export(&mgr, Some("nope")),
        Err(VaultError::WrongMasterPassword { .. })
    ));
    assert!(authorize_export(&mgr, Some("master-pw")).is_ok());
}

#[test]
fn export_and_import_refused_without_a_store() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
    assert!(matches!(
        authorize_export(&mgr, None),
        Err(VaultError::StoreUnavailable { .. })
    ));
    assert!(matches!(
        authorize_import(&mgr),
        Err(VaultError::StoreUnavailable { .. })
    ));
}

#[test]
fn import_refused_when_store_locked() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dir.path());
    mgr.with_master_password_store(|s| s.lock()).unwrap();
    assert!(matches!(
        authorize_import(&mgr),
        Err(VaultError::StoreLocked { .. })
    ));
}

#[test]
fn import_into_manager_goes_to_current_mode() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dir.path());
    authorize_import(&mgr).unwrap();
    let vault = open_json(&sample_export(), PASSPHRASE).unwrap();
    apply_import(&vault, &mgr, ConflictStrategy::Skip).unwrap();
    assert_eq!(
        mgr.get(&key("conn-a", CredentialType::Password)).unwrap(),
        Some(SECRET_A.to_string())
    );
}

#[test]
fn vault_error_serializes_with_stable_kind() {
    let value = serde_json::to_value(VaultError::WrongPassphrase {
        message: "m".into(),
    })
    .unwrap();
    assert_eq!(value["kind"], "wrongPassphrase");
    assert_eq!(value["message"], "m");
}
