//! Regression tests for #5514: an OS keychain item this build may not read.
//!
//! On macOS an item written by an earlier (differently signed) build reads as
//! `errSecAuthFailed` rather than `errSecItemNotFound`. A store that never
//! wrote the key must treat it as absent — so a freshly chosen OS keychain
//! store can resolve, save and be switched away from — while a key the store
//! did write stays fail-closed. The `keyring` mock stands in for the keychain
//! and returns the error class the real keychain returns.

use keyring::Error as KeyringError;

use crate::credential::keychain_error::{
    ERR_SEC_AUTH_FAILED, ERR_SEC_DUPLICATE_ITEM, ERR_SEC_USER_CANCELED,
};
use super::test_support::install_mock;
use super::*;

/// The error the macOS keychain returns for `code`.
fn status_error(code: i32) -> KeyringError {
    KeyringError::PlatformFailure(Box::new(security_framework::base::Error::from_code(code)))
}

/// Arm the mock entry of `key` to fail its next keychain operation with the
/// macOS status `code`.
fn arm_status(store: &OsKeychainStore, key: &CredentialKey, code: i32) {
    let entry = store.entry(key).unwrap();
    let mock: &keyring::mock::MockCredential = entry.get_credential().downcast_ref().unwrap();
    mock.set_error(status_error(code));
}

fn key(id: &str, t: CredentialType) -> CredentialKey {
    CredentialKey::new(id, t)
}

#[test]
fn an_unreadable_item_the_store_never_wrote_reads_as_absent() {
    let _guard = install_mock();
    let store = OsKeychainStore::new();
    let pw = key("Chooser test (SSH)", CredentialType::Password);
    arm_status(&store, &pw, ERR_SEC_AUTH_FAILED);
    assert_eq!(store.get(&pw).unwrap(), None);

    // A declined access prompt is the same case.
    let fs = key("Chooser test (SSH)", CredentialType::FieldSecrets);
    arm_status(&store, &fs, ERR_SEC_USER_CANCELED);
    assert_eq!(store.get(&fs).unwrap(), None);
}

#[test]
fn an_unreadable_item_the_store_wrote_stays_fail_closed() {
    let _guard = install_mock();
    let store = OsKeychainStore::new();
    let pw = key("conn-own", CredentialType::Password);
    store.set(&pw, "secret").unwrap();
    arm_status(&store, &pw, ERR_SEC_AUTH_FAILED);

    let err = store.get(&pw).unwrap_err().to_string();
    assert!(err.contains("Failed to read OS keychain entry for conn-own:password"));
    // The underlying keyring error is in the message (#5514).
    assert!(
        err.contains("PlatformFailure, OSStatus -25293 errSecAuthFailed"),
        "{err}"
    );
    assert!(store.index.contains(&pw));
}

#[test]
fn seeding_records_no_unreadable_leftover() {
    let _guard = install_mock();
    let store = OsKeychainStore::new();
    let pw = key("Chooser test (SSH)", CredentialType::Password);
    store.note_key_candidates(std::slice::from_ref(&pw));
    arm_status(&store, &pw, ERR_SEC_AUTH_FAILED);

    store.seed_key_index(std::slice::from_ref(&pw));

    assert!(store.list_keys().unwrap().is_empty());
    assert!(store.index.candidates().is_empty());
}

#[test]
fn removing_an_unreadable_leftover_is_not_an_error() {
    // Deleting a connection deletes every credential type of it; a leftover
    // this store never wrote must not fail that.
    let _guard = install_mock();
    let store = OsKeychainStore::new();
    let pw = key("conn-leftover", CredentialType::Password);
    arm_status(&store, &pw, ERR_SEC_AUTH_FAILED);
    store.remove_all_for_connection("conn-leftover").unwrap();
}

#[test]
fn removing_an_unreadable_own_item_stays_an_error() {
    let _guard = install_mock();
    let store = OsKeychainStore::new();
    let pw = key("conn-own-rm", CredentialType::Password);
    store.set(&pw, "secret").unwrap();
    arm_status(&store, &pw, ERR_SEC_AUTH_FAILED);
    let err = store.remove(&pw).unwrap_err().to_string();
    assert!(err.contains("errSecAuthFailed"), "{err}");
    assert!(store.index.contains(&pw));
}

#[test]
fn a_write_blocked_by_a_leftover_says_what_to_do() {
    let _guard = install_mock();
    let store = OsKeychainStore::new();
    let pw = key("conn-dup", CredentialType::Password);
    arm_status(&store, &pw, ERR_SEC_DUPLICATE_ITEM);
    let err = store.set(&pw, "secret").unwrap_err().to_string();
    assert!(err.contains("errSecDuplicateItem"), "{err}");
    assert!(err.contains("Keychain Access"), "{err}");
    assert!(!store.index.contains(&pw));
}
