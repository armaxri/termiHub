//! A restore into a store without a vault file (the OS keychain) defers its
//! credential import until the startup swap succeeded (#4414): a failed swap
//! leaves the credentials exactly as before the restore, a successful one
//! imports them exactly once, and no secret is ever on disk in plaintext.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use zeroize::Zeroizing;

use super::commit::MANIFEST_FILE;
use super::deferred::{
    apply_deferred_import, DEFERRED_IMPORT_FILE, SEALED_IMPORT_FILE, SEAL_KEY_CLEANUP_FILE,
};
use super::pending::apply_pending_restore;
use super::restore::{self, PENDING_DIR};
use super::tests::{build, choice, options, populate, sealed_vault, PASSPHRASE};
use super::*;
use crate::credential::biometric_slot::SecretSlot;
use crate::credential::types::{CredentialKey, CredentialType};
use crate::credential::vault::ConflictStrategy;
use crate::credential::{CredentialStore, CredentialStoreStatus};

const UNCHANGED: &str = "previous data was kept unchanged";
const KEPT: &str = "credentials from the backup had already been imported";
const BACKUP_SECRET: &str = "from-backup-4414-secret";
const ADDED_SECRET: &str = "added-4414-secret";

fn key(id: &str) -> CredentialKey {
    CredentialKey::new(id, CredentialType::Password)
}

type Map = Arc<Mutex<HashMap<String, String>>>;

/// Injected failures of a [`KeychainStore`] (#5163).
#[derive(Default, Clone)]
struct Faults {
    /// `restore_seal_slot` returns `None` (no slot for the import's key).
    no_seal_slot: bool,
    /// Reading a seal key fails (the keychain is locked or unreachable).
    seal_read_fails: bool,
    /// Reading a credential fails.
    get_fails: bool,
    /// Writing this credential (connection id) fails.
    set_fails_for: Option<&'static str>,
}

/// An OS-keychain-like store: always unlocked, no vault file, seal keys kept
/// in a separate slot namespace. Counts writes per credential.
#[derive(Default)]
struct KeychainStore {
    values: Map,
    seal_keys: Map,
    writes: Mutex<HashMap<String, usize>>,
    faults: Mutex<Faults>,
}

impl KeychainStore {
    fn value(&self, id: &str) -> Option<String> {
        self.values
            .lock()
            .unwrap()
            .get(&key(id).to_string())
            .cloned()
    }
    fn writes(&self, id: &str) -> usize {
        *self
            .writes
            .lock()
            .unwrap()
            .get(&key(id).to_string())
            .unwrap_or(&0)
    }
    fn seal_key_count(&self) -> usize {
        self.seal_keys.lock().unwrap().len()
    }
    fn set_faults(&self, faults: Faults) {
        *self.faults.lock().unwrap() = faults;
    }
    fn faults(&self) -> Faults {
        self.faults.lock().unwrap().clone()
    }
}

struct Slot {
    id: String,
    map: Map,
    read_fails: bool,
}

impl SecretSlot for Slot {
    fn read(&self) -> Result<Option<Zeroizing<String>>> {
        if self.read_fails {
            anyhow::bail!("the keychain is locked");
        }
        Ok(self
            .map
            .lock()
            .unwrap()
            .get(&self.id)
            .cloned()
            .map(Zeroizing::new))
    }
    fn write(&self, value: &str) -> Result<()> {
        self.map
            .lock()
            .unwrap()
            .insert(self.id.clone(), value.to_string());
        Ok(())
    }
    fn delete(&self) -> Result<()> {
        self.map.lock().unwrap().remove(&self.id);
        Ok(())
    }
}

impl CredentialStore for KeychainStore {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        if self.faults().get_fails {
            anyhow::bail!("the keychain is unreachable");
        }
        Ok(self.values.lock().unwrap().get(&key.to_string()).cloned())
    }
    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        if self.faults().set_fails_for == Some(key.connection_id.as_str()) {
            anyhow::bail!("the keychain refused the write");
        }
        *self
            .writes
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_default() += 1;
        self.values
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn remove(&self, key: &CredentialKey) -> Result<()> {
        self.values.lock().unwrap().remove(&key.to_string());
        Ok(())
    }
    fn remove_all_for_connection(&self, _: &str) -> Result<()> {
        Ok(())
    }
    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        Ok(Vec::new())
    }
    fn status(&self) -> CredentialStoreStatus {
        CredentialStoreStatus::Unlocked
    }
    fn restore_seal_slot(&self, id: &str) -> Option<Box<dyn SecretSlot>> {
        let faults = self.faults();
        if faults.no_seal_slot {
            return None;
        }
        Some(Box::new(Slot {
            id: id.to_string(),
            map: Arc::clone(&self.seal_keys),
            read_fails: faults.seal_read_fails,
        }))
    }
}

/// Restore macros plus a vault overwriting "Local" and adding "Other" into a
/// keychain store holding `Local = "previous"`.
fn restore_into_keychain(dir: &Path) -> KeychainStore {
    let store = KeychainStore::default();
    store.set(&key("Local"), "previous").unwrap();
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(
        src.path(),
        &options(&["macros"], true, true),
        Some(sealed_vault(&[
            ("Local", BACKUP_SECRET),
            ("Other", ADDED_SECRET),
        ])),
    );
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let request = BackupRestoreRequest {
        sections: vec![choice(
            "macros",
            RestoreMode::Replace,
            ConflictStrategy::Skip,
        )],
        credentials: Some(ConflictStrategy::Overwrite),
    };
    let result = restore::apply(&opened, dir, &request, Some(&store)).unwrap();
    assert!(result.restart_required);
    let imported = result.credentials.expect("the import result is reported");
    assert_eq!(
        (imported.imported_count, imported.overwritten_count),
        (1, 1)
    );
    store
}

fn assert_pre_restore(store: &KeychainStore) {
    assert_eq!(store.value("Local").as_deref(), Some("previous"));
    assert_eq!(store.value("Other"), None);
}

/// No file under `dir` contains a secret from the backup.
fn assert_no_plaintext_secret(dir: &Path) {
    for entry in walk(dir) {
        let bytes = std::fs::read(&entry).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        for secret in [BACKUP_SECRET, ADDED_SECRET] {
            assert!(!text.contains(secret), "{} holds a secret", entry.display());
        }
    }
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}

#[test]
fn restore_defers_the_import_and_writes_no_plaintext() {
    let dst = tempfile::tempdir().unwrap();
    let store = restore_into_keychain(dst.path());

    // Nothing was imported yet; the import is sealed in the pending dir.
    assert_pre_restore(&store);
    assert!(dst
        .path()
        .join(PENDING_DIR)
        .join(SEALED_IMPORT_FILE)
        .is_file());
    assert_eq!(store.seal_key_count(), 1);
    assert_no_plaintext_secret(dst.path());
}

#[test]
fn failed_startup_swap_leaves_keychain_credentials_unchanged() {
    let dst = tempfile::tempdir().unwrap();
    let store = restore_into_keychain(dst.path());

    std::fs::create_dir(dst.path().join("macros.json")).unwrap();
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");

    assert!(warning.message.contains(UNCHANGED), "{}", warning.message);
    assert!(!warning.message.contains(KEPT));
    assert!(!dst.path().join(PENDING_DIR).exists());
    assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists());

    // Once the store is available the orphaned seal key is deleted, and
    // nothing is imported.
    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_pre_restore(&store);
    assert_eq!(store.seal_key_count(), 0);
    assert!(!dst.path().join(SEAL_KEY_CLEANUP_FILE).exists());
    assert_no_plaintext_secret(dst.path());
}

#[test]
fn invalid_pending_manifest_leaves_keychain_credentials_unchanged() {
    let dst = tempfile::tempdir().unwrap();
    let store = restore_into_keychain(dst.path());

    std::fs::write(dst.path().join(PENDING_DIR).join(MANIFEST_FILE), "{ broken").unwrap();
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");

    assert!(warning.message.contains(UNCHANGED), "{}", warning.message);
    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_pre_restore(&store);
    assert_eq!(store.seal_key_count(), 0);
}

#[test]
fn successful_swap_applies_the_import_exactly_once() {
    let dst = tempfile::tempdir().unwrap();
    let store = restore_into_keychain(dst.path());

    assert!(apply_pending_restore(dst.path()).is_none());
    // Still nothing imported before the store is available.
    assert_pre_restore(&store);
    assert!(dst.path().join(DEFERRED_IMPORT_FILE).is_file());

    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_eq!(store.value("Local").as_deref(), Some(BACKUP_SECRET));
    assert_eq!(store.value("Other").as_deref(), Some(ADDED_SECRET));
    assert_eq!(store.writes("Local"), 2, "the seed write plus the import");
    assert_eq!(store.writes("Other"), 1);

    // All sealed material is gone, and a later start imports nothing again.
    assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists());
    assert!(!dst.path().join(SEAL_KEY_CLEANUP_FILE).exists());
    assert_eq!(store.seal_key_count(), 0);
    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_eq!(store.writes("Other"), 1);
    assert_no_plaintext_secret(dst.path());
}

#[test]
fn crash_during_apply_is_finished_idempotently() {
    let dst = tempfile::tempdir().unwrap();
    let store = restore_into_keychain(dst.path());
    assert!(apply_pending_restore(dst.path()).is_none());

    // A crash right after the credentials were written: the sealed file and
    // its key are still there on the next start.
    let sealed = std::fs::read(dst.path().join(DEFERRED_IMPORT_FILE)).unwrap();
    let keys = store.seal_keys.lock().unwrap().clone();
    assert!(apply_deferred_import(dst.path(), &store).is_none());
    std::fs::write(dst.path().join(DEFERRED_IMPORT_FILE), &sealed).unwrap();
    *store.seal_keys.lock().unwrap() = keys;

    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_eq!(store.value("Other").as_deref(), Some(ADDED_SECRET));
    assert_eq!(store.writes("Other"), 1, "never written twice");
    assert_eq!(store.writes("Local"), 2);
    assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists());
    assert_eq!(store.seal_key_count(), 0);
}

#[test]
fn crash_after_promotion_before_cleanup_still_imports_once() {
    let dst = tempfile::tempdir().unwrap();
    let store = restore_into_keychain(dst.path());
    let pending = dst.path().join(PENDING_DIR);
    let saved: Vec<(std::path::PathBuf, Vec<u8>)> = walk(&pending)
        .into_iter()
        .filter(|p| !p.ends_with(SEALED_IMPORT_FILE))
        .map(|p| {
            (
                p.strip_prefix(&pending).unwrap().to_path_buf(),
                std::fs::read(&p).unwrap(),
            )
        })
        .collect();
    assert!(apply_pending_restore(dst.path()).is_none());

    // A crash after the sealed import was moved out but before the pending
    // dir was removed: the next start redoes the swap without the import.
    for (rel, bytes) in &saved {
        let target = pending.join(rel);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, bytes).unwrap();
    }
    assert!(apply_pending_restore(dst.path()).is_none());
    assert!(dst.path().join(DEFERRED_IMPORT_FILE).is_file());

    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_eq!(store.value("Other").as_deref(), Some(ADDED_SECRET));
    assert_eq!(store.writes("Other"), 1);
    assert_eq!(store.seal_key_count(), 0);
}

#[test]
fn credential_changed_after_the_restore_is_not_overwritten() {
    let dst = tempfile::tempdir().unwrap();
    let store = restore_into_keychain(dst.path());
    store.set(&key("Local"), "saved-after-restore").unwrap();
    assert!(apply_pending_restore(dst.path()).is_none());

    let warning = apply_deferred_import(dst.path(), &store).expect("the skip is reported");

    assert!(warning.message.contains("changed after the restore"));
    assert_eq!(store.value("Local").as_deref(), Some("saved-after-restore"));
    assert_eq!(store.value("Other").as_deref(), Some(ADDED_SECRET));
    assert_eq!(store.seal_key_count(), 0);
}

#[test]
fn missing_seal_key_imports_nothing_and_cleans_up() {
    let dst = tempfile::tempdir().unwrap();
    let store = restore_into_keychain(dst.path());
    assert!(apply_pending_restore(dst.path()).is_none());
    store.seal_keys.lock().unwrap().clear();

    let warning = apply_deferred_import(dst.path(), &store).expect("the loss is reported");

    assert!(warning.message.contains("could not be imported"));
    assert_pre_restore(&store);
    assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists());
    assert!(!dst.path().join(SEAL_KEY_CLEANUP_FILE).exists());
}

#[test]
fn superseding_a_pending_restore_deletes_its_seal_key() {
    let dst = tempfile::tempdir().unwrap();
    let store = restore_into_keychain(dst.path());
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(
        src.path(),
        &options(&["macros"], true, true),
        Some(sealed_vault(&[("Other", ADDED_SECRET)])),
    );
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let request = BackupRestoreRequest {
        sections: vec![choice(
            "macros",
            RestoreMode::Replace,
            ConflictStrategy::Skip,
        )],
        credentials: Some(ConflictStrategy::Overwrite),
    };
    restore::apply(&opened, dst.path(), &request, Some(&store)).unwrap();

    // Only the new restore's key is left.
    assert_eq!(store.seal_key_count(), 1);
    assert!(apply_pending_restore(dst.path()).is_none());
    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_eq!(store.value("Local").as_deref(), Some("previous"));
    assert_eq!(store.value("Other").as_deref(), Some(ADDED_SECRET));
    assert_eq!(store.seal_key_count(), 0);
}

#[test]
fn credentials_only_restore_still_imports_right_away() {
    let dst = tempfile::tempdir().unwrap();
    let store = KeychainStore::default();
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(
        src.path(),
        &options(&[], true, true),
        Some(sealed_vault(&[("Other", ADDED_SECRET)])),
    );
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let request = BackupRestoreRequest {
        sections: Vec::new(),
        credentials: Some(ConflictStrategy::Overwrite),
    };
    let result = restore::apply(&opened, dst.path(), &request, Some(&store)).unwrap();

    // No restart, so nothing to defer.
    assert!(!result.restart_required);
    assert_eq!(store.value("Other").as_deref(), Some(ADDED_SECRET));
    assert_eq!(store.seal_key_count(), 0);
}

// --- unseal_and_write failure branches (#5163) ---

const NOT_YET: &str = "could not be imported yet";
const LOST: &str = "could not be imported. Your credentials were left unchanged";

/// Restore into a keychain store and run the startup swap, so the sealed
/// import waits in the config dir for the store.
fn promoted(dir: &Path) -> KeychainStore {
    let store = restore_into_keychain(dir);
    assert!(apply_pending_restore(dir).is_none());
    assert!(dir.join(DEFERRED_IMPORT_FILE).is_file());
    assert_eq!(store.seal_key_count(), 1);
    store
}

fn sealed_json(dir: &Path) -> serde_json::Value {
    let text = std::fs::read_to_string(dir.join(DEFERRED_IMPORT_FILE)).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn write_sealed_json(dir: &Path, value: &serde_json::Value) {
    std::fs::write(
        dir.join(DEFERRED_IMPORT_FILE),
        serde_json::to_string_pretty(value).unwrap(),
    )
    .unwrap();
}

/// A transient failure — the store, or the key that seals the import, is
/// unavailable — writes nothing and keeps the sealed file and its key for the
/// next start, which then imports everything exactly once.
#[test]
fn store_unavailable_keeps_the_sealed_import_and_writes_nothing() {
    let cases = [
        (
            "no seal slot",
            Faults {
                no_seal_slot: true,
                ..Faults::default()
            },
        ),
        (
            "seal key unreadable",
            Faults {
                seal_read_fails: true,
                ..Faults::default()
            },
        ),
        (
            "credentials unreadable",
            Faults {
                get_fails: true,
                ..Faults::default()
            },
        ),
        (
            "batch write fails midway",
            Faults {
                set_fails_for: Some("Other"),
                ..Faults::default()
            },
        ),
    ];
    for (case, faults) in cases {
        let dst = tempfile::tempdir().unwrap();
        let store = promoted(dst.path());
        let sealed = std::fs::read(dst.path().join(DEFERRED_IMPORT_FILE)).unwrap();
        let keys = store.seal_keys.lock().unwrap().clone();

        store.set_faults(faults);
        let warning = apply_deferred_import(dst.path(), &store)
            .unwrap_or_else(|| panic!("{case}: the failure is reported"));
        store.set_faults(Faults::default());

        assert!(
            warning.message.contains(NOT_YET),
            "{case}: {}",
            warning.message
        );
        // Nothing partially written: a failed batch was rolled back.
        assert_pre_restore(&store);
        // The sealed file is kept byte for byte, and so is its key.
        assert_eq!(
            std::fs::read(dst.path().join(DEFERRED_IMPORT_FILE)).unwrap(),
            sealed,
            "{case}: the sealed import is kept"
        );
        assert_eq!(*store.seal_keys.lock().unwrap(), keys, "{case}");
        assert!(!dst.path().join(SEAL_KEY_CLEANUP_FILE).exists(), "{case}");
        assert_no_plaintext_secret(dst.path());

        // Once the store is back, the next start imports exactly once.
        assert!(
            apply_deferred_import(dst.path(), &store).is_none(),
            "{case}"
        );
        assert_eq!(
            store.value("Local").as_deref(),
            Some(BACKUP_SECRET),
            "{case}"
        );
        assert_eq!(
            store.value("Other").as_deref(),
            Some(ADDED_SECRET),
            "{case}"
        );
        assert_eq!(store.writes("Other"), 1, "{case}: never written twice");
        assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists(), "{case}");
        assert_eq!(store.seal_key_count(), 0, "{case}");
    }
}

/// A sealed import naming another key — one that exists in the store but did
/// not seal it — cannot be unsealed (the key id is bound into the AEAD
/// associated data). Nothing is written; the import, which can never be
/// applied, is dropped and the key it names is deleted.
#[test]
fn wrong_key_id_imports_nothing() {
    let dst = tempfile::tempdir().unwrap();
    let store = promoted(dst.path());
    let mut sealed = sealed_json(dst.path());
    let real_id = sealed["keyId"].as_str().unwrap().to_string();
    let other_id = uuid::Uuid::new_v4().to_string();
    let key = store.seal_keys.lock().unwrap()[&real_id].clone();
    store
        .seal_keys
        .lock()
        .unwrap()
        .insert(other_id.clone(), key);
    sealed["keyId"] = serde_json::Value::String(other_id.clone());
    write_sealed_json(dst.path(), &sealed);

    let warning = apply_deferred_import(dst.path(), &store).expect("the loss is reported");

    assert!(warning.message.contains(LOST), "{}", warning.message);
    assert_pre_restore(&store);
    assert_eq!(store.writes("Other"), 0);
    assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists());
    assert!(!store.seal_keys.lock().unwrap().contains_key(&other_id));
    assert!(!dst.path().join(SEAL_KEY_CLEANUP_FILE).exists());
    assert_no_plaintext_secret(dst.path());
}

/// A key id that is not a UUID is refused before it names a keychain entry.
#[test]
fn invalid_key_id_imports_nothing_and_reads_no_key() {
    let dst = tempfile::tempdir().unwrap();
    let store = promoted(dst.path());
    let mut sealed = sealed_json(dst.path());
    sealed["keyId"] = serde_json::Value::String("../termiHub".to_string());
    write_sealed_json(dst.path(), &sealed);
    // A slot read would fail: proves the id never reaches the store.
    store.set_faults(Faults {
        seal_read_fails: true,
        ..Faults::default()
    });

    let warning = apply_deferred_import(dst.path(), &store).expect("the loss is reported");

    assert!(warning.message.contains(LOST), "{}", warning.message);
    assert_pre_restore(&store);
    assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists());
}

/// A truncated sealed import — cut-off JSON, or a cut-off ciphertext that
/// fails authentication — writes nothing. It can never be applied, so it is
/// dropped; a readable key id gets its key deleted.
#[test]
fn truncated_seal_imports_nothing() {
    // Cut-off file: not even the key id is readable.
    let dst = tempfile::tempdir().unwrap();
    let store = promoted(dst.path());
    let path = dst.path().join(DEFERRED_IMPORT_FILE);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();

    let warning = apply_deferred_import(dst.path(), &store).expect("the loss is reported");

    assert!(warning.message.contains(LOST), "{}", warning.message);
    assert_pre_restore(&store);
    assert!(!path.exists());
    assert_no_plaintext_secret(dst.path());

    // Cut-off ciphertext: the AEAD tag check fails.
    let dst = tempfile::tempdir().unwrap();
    let store = promoted(dst.path());
    let mut sealed = sealed_json(dst.path());
    let data = BASE64.decode(sealed["data"].as_str().unwrap()).unwrap();
    sealed["data"] = serde_json::Value::String(BASE64.encode(&data[..data.len() - 1]));
    write_sealed_json(dst.path(), &sealed);

    let warning = apply_deferred_import(dst.path(), &store).expect("the loss is reported");

    assert!(warning.message.contains(LOST), "{}", warning.message);
    assert_pre_restore(&store);
    assert_eq!(store.writes("Other"), 0);
    assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists());
    assert_eq!(store.seal_key_count(), 0, "the key is deleted");
    assert!(!dst.path().join(SEAL_KEY_CLEANUP_FILE).exists());
    assert_no_plaintext_secret(dst.path());
}
