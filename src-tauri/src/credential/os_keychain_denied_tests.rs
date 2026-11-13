//! Regression tests for #5514: an OS keychain item this build may not read.
//!
//! On macOS an item written by an earlier (differently signed) build reads as
//! `errSecAuthFailed` rather than `errSecItemNotFound`. A store that never
//! wrote the key must treat it as absent — so a freshly chosen OS keychain
//! store can resolve, save and be switched away from — while a key the store
//! did write stays fail-closed. The `keyring` mock stands in for the keychain
//! and returns the error class the real keychain returns.

use keyring::Error as KeyringError;

use super::test_support::install_mock;
use super::*;
use crate::credential::keychain_error::{
    ERR_SEC_AUTH_FAILED, ERR_SEC_DUPLICATE_ITEM, ERR_SEC_USER_CANCELED,
};

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

/// Stands in for the macOS keychain's delete-without-reading (#5527) on the
/// `keyring` mock: the mock entry's own delete, or a scripted failure.
struct FakeUnread {
    fail_with: Option<i32>,
}

impl crate::credential::keychain_unread::UnreadItems for FakeUnread {
    fn applies_to(&self, _entry: &keyring::Entry) -> bool {
        true
    }

    fn delete(&self, entry: &keyring::Entry) -> Result<bool, i32> {
        if let Some(code) = self.fail_with {
            return Err(code);
        }
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(e) => panic!("mock delete failed: {e}"),
        }
    }
}

fn store_with(policy: ItemPolicy, fail_with: Option<i32>) -> OsKeychainStore {
    let mut store = OsKeychainStore::new();
    store.set_item_policy_for_test(policy);
    store.set_unread_items_for_test(Box::new(FakeUnread { fail_with }));
    store
}

/// Put `value` in the keychain under `key` behind the store's back, as
/// another build or profile sharing the namespace would.
fn plant(store: &OsKeychainStore, key: &CredentialKey, value: &str) {
    store.entry(key).unwrap().set_password(value).unwrap();
}

#[test]
fn a_release_write_replaces_an_item_it_may_not_read() {
    let _guard = install_mock();
    let store = store_with(ItemPolicy::Release, None);
    let pw = key("conn-update", CredentialType::Password);
    arm_status(&store, &pw, ERR_SEC_DUPLICATE_ITEM);
    store.set(&pw, "new-secret").unwrap();
    assert_eq!(store.get(&pw).unwrap().as_deref(), Some("new-secret"));
    assert!(store.index.contains(&pw));
}

#[test]
fn a_release_write_whose_leftover_cannot_be_removed_says_what_to_do() {
    let _guard = install_mock();
    let store = store_with(ItemPolicy::Release, Some(-25244));
    let pw = key("conn-update-stuck", CredentialType::Password);
    arm_status(&store, &pw, ERR_SEC_DUPLICATE_ITEM);
    let err = store.set(&pw, "new-secret").unwrap_err().to_string();
    assert!(err.contains("Keychain Access"), "{err}");
    assert!(!store.index.contains(&pw));
}

#[test]
fn a_release_read_denied_for_an_own_item_says_how_to_recover() {
    let _guard = install_mock();
    let store = store_with(ItemPolicy::Release, None);
    let pw = key("conn-denied", CredentialType::Password);
    store.set(&pw, "secret").unwrap();
    arm_status(&store, &pw, ERR_SEC_USER_CANCELED);
    let err = store.get(&pw).unwrap_err().to_string();
    assert!(err.contains("errSecUserCanceled"), "{err}");
    assert!(err.contains("save it to replace the item"), "{err}");
}

#[test]
fn a_release_store_adopts_an_unlisted_readable_item() {
    let _guard = install_mock();
    let store = store_with(ItemPolicy::Release, None);
    let pw = key("conn-older-version", CredentialType::Password);
    plant(&store, &pw, "older-version-secret");
    assert_eq!(
        store.get(&pw).unwrap().as_deref(),
        Some("older-version-secret")
    );
    store.seed_key_index(std::slice::from_ref(&pw));
    assert!(store.index.contains(&pw));
}

#[test]
fn an_isolated_store_ignores_another_profiles_item_and_saves_over_it() {
    let _guard = install_mock();
    let store = store_with(ItemPolicy::Isolated, None);
    let pw = key("Chooser test (SSH)", CredentialType::Password);
    plant(&store, &pw, "other-profile-secret");

    // Not read, not adopted, not deleted.
    assert_eq!(store.get(&pw).unwrap(), None);
    store.seed_key_index(std::slice::from_ref(&pw));
    assert!(store.list_keys().unwrap().is_empty());
    store.remove_all_for_connection("Chooser test (SSH)").unwrap();
    let raw = store.entry(&pw).unwrap().get_password().unwrap();
    assert_eq!(raw, "other-profile-secret");

    // Saving replaces it, and the store then owns the item.
    store.set(&pw, "this-profile-secret").unwrap();
    assert_eq!(
        store.get(&pw).unwrap().as_deref(),
        Some("this-profile-secret")
    );
    store.remove(&pw).unwrap();
    assert!(matches!(
        store.entry(&pw).unwrap().get_password(),
        Err(KeyringError::NoEntry)
    ));
}

#[test]
fn an_isolated_write_replaces_an_item_it_may_not_read() {
    let _guard = install_mock();
    let store = store_with(ItemPolicy::Isolated, None);
    let pw = key("conn-rebuilt", CredentialType::Password);
    plant(&store, &pw, "earlier-build-secret");
    store.set(&pw, "rebuilt-secret").unwrap();
    assert_eq!(store.get(&pw).unwrap().as_deref(), Some("rebuilt-secret"));
}
