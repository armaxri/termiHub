//! A restore whose startup swap fails must also revert the credentials it
//! imported (PER2-006, #4295): the stores are rolled back at the next start,
//! so the credential vault is put back from the copy the restore took before
//! importing, and the warning only promises unchanged data when that is true.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;

use super::commit::{CREDENTIALS_COPY_FILE, CREDENTIALS_RECORD_FILE, MANIFEST_FILE};
use super::pending::{apply_pending_restore, ROLLBACK_DIR};
use super::restore::{self, PENDING_DIR};
use super::tests::{build, choice, mp_manager, options, populate, sealed_vault, PASSPHRASE};
use super::*;
use crate::credential::types::{CredentialKey, CredentialType, StorageMode};
use crate::credential::vault::ConflictStrategy;
use crate::credential::{CredentialManager, CredentialStore, CredentialStoreStatus};

const UNCHANGED: &str = "previous data was kept unchanged";
const KEPT: &str = "credentials from the backup had already been imported";

fn key(id: &str) -> CredentialKey {
    CredentialKey::new(id, CredentialType::Password)
}

/// A backup with the macros section and a sealed vault overwriting "Local"
/// and adding "Other".
fn backup_with_credentials() -> String {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    build(
        src.path(),
        &options(&["macros"], true, true),
        Some(sealed_vault(&[
            ("Local", "from-backup"),
            ("Other", "added"),
        ])),
    )
}

fn macros_and_credentials() -> BackupRestoreRequest {
    BackupRestoreRequest {
        sections: vec![choice(
            "macros",
            RestoreMode::Replace,
            ConflictStrategy::Skip,
        )],
        credentials: Some(ConflictStrategy::Overwrite),
    }
}

/// Restore into a master-password store holding `Local = "previous"`.
fn restore_into_master_password_store(dir: &Path) -> CredentialManager {
    let mgr = mp_manager(dir);
    mgr.set(&key("Local"), "previous").unwrap();
    let opened = restore::open(&backup_with_credentials(), Some(PASSPHRASE)).unwrap();
    restore::apply(&opened, dir, &macros_and_credentials(), Some(&mgr)).unwrap();
    // The import is live right away.
    assert_eq!(
        mgr.get(&key("Local")).unwrap().as_deref(),
        Some("from-backup")
    );
    mgr
}

/// Make the startup swap fail: a directory is where macros.json must go.
fn block_the_swap(dir: &Path) {
    std::fs::create_dir(dir.join("macros.json")).unwrap();
}

/// The vault as the next start sees it, unlocked with the master password.
fn vault_at_next_start(dir: &Path) -> CredentialManager {
    let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
    mgr.with_master_password_store(|s| s.unlock("master-pw"))
        .unwrap()
        .expect("the vault must still open with the master password");
    mgr
}

fn assert_vault_is_pre_restore(dir: &Path) {
    let mgr = vault_at_next_start(dir);
    assert_eq!(mgr.get(&key("Local")).unwrap().as_deref(), Some("previous"));
    assert_eq!(mgr.get(&key("Other")).unwrap(), None);
}

#[test]
fn failed_startup_swap_reverts_imported_credentials() {
    let dst = tempfile::tempdir().unwrap();
    drop(restore_into_master_password_store(dst.path()));

    block_the_swap(dst.path());
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");

    assert!(warning.message.contains(UNCHANGED), "{}", warning.message);
    assert_vault_is_pre_restore(dst.path());
    assert!(!dst.path().join(PENDING_DIR).exists());
    assert!(!dst.path().join(ROLLBACK_DIR).exists());
}

#[test]
fn invalid_pending_manifest_reverts_imported_credentials() {
    let dst = tempfile::tempdir().unwrap();
    drop(restore_into_master_password_store(dst.path()));

    std::fs::write(dst.path().join(PENDING_DIR).join(MANIFEST_FILE), "{ broken").unwrap();
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");

    assert!(warning.message.contains(UNCHANGED), "{}", warning.message);
    assert_vault_is_pre_restore(dst.path());
}

#[test]
fn successful_startup_swap_keeps_imported_credentials() {
    let dst = tempfile::tempdir().unwrap();
    drop(restore_into_master_password_store(dst.path()));

    assert!(apply_pending_restore(dst.path()).is_none());

    let mgr = vault_at_next_start(dst.path());
    assert_eq!(
        mgr.get(&key("Local")).unwrap().as_deref(),
        Some("from-backup")
    );
    assert_eq!(mgr.get(&key("Other")).unwrap().as_deref(), Some("added"));
    assert!(!dst.path().join(PENDING_DIR).exists());
}

#[test]
fn interrupted_revert_is_finished_on_the_next_start() {
    let dst = tempfile::tempdir().unwrap();
    drop(restore_into_master_password_store(dst.path()));
    // A crash after the vault was put back but before the pending directory
    // was removed: the vault already holds the pre-restore copy.
    let pending = dst.path().join(PENDING_DIR);
    std::fs::copy(
        pending.join(CREDENTIALS_COPY_FILE),
        dst.path().join("credentials.enc"),
    )
    .unwrap();

    block_the_swap(dst.path());
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");

    assert!(warning.message.contains(UNCHANGED), "{}", warning.message);
    assert_vault_is_pre_restore(dst.path());
}

#[test]
fn vault_changed_after_restore_is_left_alone_and_reported() {
    let dst = tempfile::tempdir().unwrap();
    let mgr = restore_into_master_password_store(dst.path());
    // A credential saved between the restore and the restart must not be
    // silently undone.
    mgr.set(&key("Later"), "saved-after-restore").unwrap();
    drop(mgr);

    block_the_swap(dst.path());
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");

    assert!(warning.message.contains(KEPT), "{}", warning.message);
    assert!(!warning.message.contains(UNCHANGED));
    let mgr = vault_at_next_start(dst.path());
    assert_eq!(
        mgr.get(&key("Later")).unwrap().as_deref(),
        Some("saved-after-restore")
    );
}

#[test]
fn master_password_changed_after_restore_is_never_undone() {
    let dst = tempfile::tempdir().unwrap();
    let mgr = restore_into_master_password_store(dst.path());
    mgr.change_master_password("master-pw", "new-master-pw")
        .unwrap();
    drop(mgr);

    block_the_swap(dst.path());
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");

    assert!(warning.message.contains(KEPT), "{}", warning.message);
    let mgr = CredentialManager::new(StorageMode::MasterPassword, dst.path().to_path_buf());
    mgr.with_master_password_store(|s| s.unlock("new-master-pw"))
        .unwrap()
        .expect("the changed master password must still open the vault");
}

#[test]
fn restore_without_credentials_writes_no_import_record() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(src.path(), &options(&["macros"], true, false), None);
    let dst = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dst.path());
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = BackupRestoreRequest {
        sections: vec![choice(
            "macros",
            RestoreMode::Replace,
            ConflictStrategy::Skip,
        )],
        credentials: None,
    };
    restore::apply(&opened, dst.path(), &req, Some(&mgr)).unwrap();

    assert!(!dst
        .path()
        .join(PENDING_DIR)
        .join(CREDENTIALS_RECORD_FILE)
        .exists());
    block_the_swap(dst.path());
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");
    assert!(warning.message.contains(UNCHANGED), "{}", warning.message);
}

/// An unlocked store without a vault file, like the OS keychain.
#[derive(Default)]
struct KeychainLikeStore(Mutex<HashMap<String, String>>);

impl CredentialStore for KeychainLikeStore {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(&key.to_string()).cloned())
    }
    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn remove(&self, key: &CredentialKey) -> Result<()> {
        self.0.lock().unwrap().remove(&key.to_string());
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
}

#[test]
fn store_without_vault_file_reports_kept_credentials() {
    let dst = tempfile::tempdir().unwrap();
    let store = KeychainLikeStore::default();
    let opened = restore::open(&backup_with_credentials(), Some(PASSPHRASE)).unwrap();
    restore::apply(&opened, dst.path(), &macros_and_credentials(), Some(&store)).unwrap();

    block_the_swap(dst.path());
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");

    // The message must not claim nothing changed.
    assert!(warning.message.contains(KEPT), "{}", warning.message);
    assert!(!warning.message.contains(UNCHANGED));
    assert!(!dst.path().join(PENDING_DIR).exists());
}
