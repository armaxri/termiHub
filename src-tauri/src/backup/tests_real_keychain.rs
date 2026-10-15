//! Opt-in end-to-end tests of the deferred credential import of a backup
//! restore (#4414) against the **real** OS credential store (#4659): the
//! macOS Keychain, the Windows Credential Manager or the Linux Secret Service.
//!
//! Every other test uses the `keyring` mock or a fake store, and a unit-test
//! `OsKeychainStore` imports right away, so these are the only tests that run
//! the real path: the seal key written to the OS keychain, the sealed import
//! promoted by the startup swap and applied once the store is available, and
//! the key deleted afterwards.
//!
//! They touch the keyring only when `TERMIHUB_REAL_KEYCHAIN_TESTS=1` is set;
//! otherwise they return immediately. Every entry lives under a service name
//! unique to the run (never the real `termiHub` / `termiHub-backup-restore`
//! services), and a drop guard deletes every entry the test may have written,
//! even when an assertion fails.
//!
//! Run them with `scripts/internal/real-keychain-tests.sh`, which provides a
//! throwaway store (a temporary macOS keychain, a private Secret Service on
//! Linux) and fails unless every test ran; CI runs it on every `Run Tests`
//! leg. Setting the flag by hand on macOS writes to the default keychain —
//! normally the login keychain. See `docs/testing.md`.

use std::path::Path;

use keyring::Entry;

use super::deferred::{
    apply_deferred_import, DEFERRED_IMPORT_FILE, SEALED_IMPORT_FILE, SEAL_KEY_CLEANUP_FILE,
};
use super::pending::apply_pending_restore;
use super::restore::{self, PENDING_DIR};
use super::tests::{build, choice, options, populate, sealed_vault, PASSPHRASE};
use super::*;
use crate::credential::os_keychain::test_support::install_platform;
use crate::credential::os_keychain::OsKeychainStore;
use crate::credential::types::{CredentialKey, CredentialType};
use crate::credential::vault::ConflictStrategy;
use crate::credential::CredentialStore;

/// The opt-in flag; only `1` enables the tests.
const FLAG: &str = "TERMIHUB_REAL_KEYCHAIN_TESTS";
const UNCHANGED: &str = "previous data was kept unchanged";
const PREVIOUS_SECRET: &str = "previous-4659-secret";
const BACKUP_SECRET: &str = "from-backup-4659-secret";
const ADDED_SECRET: &str = "added-4659-secret";
/// The connection ids the restore writes credentials for.
const CONNECTIONS: [&str; 2] = ["Local", "Other"];

fn enabled(test: &str) -> bool {
    let on = std::env::var(FLAG).is_ok_and(|v| v == "1");
    if !on {
        eprintln!("skipping {test}: set {FLAG}=1 to run it against the real OS keychain");
    }
    on
}

fn key(id: &str) -> CredentialKey {
    CredentialKey::new(id, CredentialType::Password)
}

/// Deletes every keychain entry a test may have written, on drop — also when
/// the test panics. Declared after the keyring guard, so it runs while the
/// platform keyring is still installed.
struct Cleanup<'a> {
    store: &'a OsKeychainStore,
    service: String,
    seal_service: String,
}

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        let credentials = CredentialType::ALL
            .into_iter()
            .flat_map(|t| CONNECTIONS.map(|id| CredentialKey::new(id, t.clone()).to_string()))
            .map(|account| (self.service.as_str(), account));
        let seal_keys = self
            .store
            .issued_seal_ids()
            .into_iter()
            .map(|id| (self.seal_service.as_str(), id));
        for (service, account) in credentials.chain(seal_keys) {
            let deleted = Entry::new(service, &account).and_then(|e| e.delete_credential());
            match deleted {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => {
                    eprintln!("could not delete test keychain entry {service}/{account}: {e}")
                }
            }
        }
    }
}

/// A run-unique service-name pair, never the production names.
fn services() -> (String, String) {
    let run = format!("{}-{}", std::process::id(), uuid::Uuid::new_v4().simple());
    (
        format!("termiHub-test-4659-{run}"),
        format!("termiHub-test-4659-seal-{run}"),
    )
}

/// Restore macros plus a vault overwriting "Local" and adding "Other" into a
/// real-keychain store holding `Local = PREVIOUS_SECRET`.
fn restore_into(store: &OsKeychainStore, dir: &Path) {
    store.set(&key("Local"), PREVIOUS_SECRET).unwrap();
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
    let result = restore::apply(&opened, dir, &request, Some(store)).unwrap();
    assert!(result.restart_required);

    // Deferred: nothing imported yet, the import sealed in the pending dir,
    // and its key in the real keychain.
    assert_pre_restore(store);
    assert!(dir.join(PENDING_DIR).join(SEALED_IMPORT_FILE).is_file());
    assert_eq!(seal_keys_present(store), 1, "one seal key in the keychain");
    assert_no_plaintext_secret(dir);
}

fn value(store: &OsKeychainStore, id: &str) -> Option<String> {
    store.get(&key(id)).unwrap()
}

fn assert_pre_restore(store: &OsKeychainStore) {
    assert_eq!(value(store, "Local").as_deref(), Some(PREVIOUS_SECRET));
    assert_eq!(value(store, "Other"), None);
}

/// How many of the seal keys the store handed out are still in the keychain.
fn seal_keys_present(store: &OsKeychainStore) -> usize {
    store
        .issued_seal_ids()
        .iter()
        .filter(|id| {
            let slot = store.restore_seal_slot(id).expect("deferral is enabled");
            slot.read().unwrap().is_some()
        })
        .count()
}

/// No file under `dir` contains a secret from the backup.
fn assert_no_plaintext_secret(dir: &Path) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        if path.is_dir() {
            for entry in std::fs::read_dir(&path).unwrap() {
                stack.push(entry.unwrap().path());
            }
            continue;
        }
        let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
        for secret in [BACKUP_SECRET, ADDED_SECRET] {
            assert!(!text.contains(secret), "{} holds a secret", path.display());
        }
    }
}

#[test]
fn real_keychain_successful_swap_imports_once_and_deletes_the_seal_key() {
    if !enabled("real_keychain_successful_swap_imports_once_and_deletes_the_seal_key") {
        return;
    }
    let _keyring = install_platform();
    let (service, seal_service) = services();
    let store = OsKeychainStore::with_test_services(&service, &seal_service);
    let _cleanup = Cleanup {
        store: &store,
        service,
        seal_service,
    };
    let dst = tempfile::tempdir().unwrap();
    restore_into(&store, dst.path());

    // The startup swap promotes the sealed import; still nothing imported.
    assert!(apply_pending_restore(dst.path()).is_none());
    assert_pre_restore(&store);
    assert!(dst.path().join(DEFERRED_IMPORT_FILE).is_file());

    // Once the store is available: imported, and every sealed bit is gone.
    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_eq!(value(&store, "Local").as_deref(), Some(BACKUP_SECRET));
    assert_eq!(value(&store, "Other").as_deref(), Some(ADDED_SECRET));
    assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists());
    assert!(!dst.path().join(SEAL_KEY_CLEANUP_FILE).exists());
    assert_eq!(seal_keys_present(&store), 0, "the seal key was deleted");

    // A later start imports nothing again and keeps the imported values.
    store.set(&key("Other"), "changed-later").unwrap();
    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_eq!(value(&store, "Other").as_deref(), Some("changed-later"));
    assert_no_plaintext_secret(dst.path());
}

#[test]
fn real_keychain_failed_swap_leaves_credentials_unchanged() {
    if !enabled("real_keychain_failed_swap_leaves_credentials_unchanged") {
        return;
    }
    let _keyring = install_platform();
    let (service, seal_service) = services();
    let store = OsKeychainStore::with_test_services(&service, &seal_service);
    let _cleanup = Cleanup {
        store: &store,
        service,
        seal_service,
    };
    let dst = tempfile::tempdir().unwrap();
    restore_into(&store, dst.path());

    // A directory where the restored file must go makes the swap fail.
    std::fs::create_dir(dst.path().join("macros.json")).unwrap();
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");
    assert!(warning.message.contains(UNCHANGED), "{}", warning.message);
    assert!(!dst.path().join(DEFERRED_IMPORT_FILE).exists());

    // Once the store is available: nothing imported, the orphaned seal key
    // deleted from the keychain.
    assert!(apply_deferred_import(dst.path(), &store).is_none());
    assert_pre_restore(&store);
    assert_eq!(seal_keys_present(&store), 0, "the seal key was deleted");
    assert!(!dst.path().join(SEAL_KEY_CLEANUP_FILE).exists());
    assert_no_plaintext_secret(dst.path());
}
