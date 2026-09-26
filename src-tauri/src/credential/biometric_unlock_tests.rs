//! Tests for biometric unlock of the master-password store (PROD-064).
//!
//! Everything runs against [`MockVerifier`] and an in-memory [`MemorySlot`]:
//! no test touches the real OS keychain or pops a real prompt.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::*;
use crate::credential::os_auth::mock::{MockOutcome, MockVerifier};
use crate::credential::os_auth::OsAuthPurpose;
use crate::credential::types::{CredentialKey, CredentialStoreStatus, CredentialType};
use crate::credential::{CredentialManager, CredentialStore, StorageMode};

const MASTER: &str = "master-pw";
const FINGERPRINT_A: [u8; 32] = [0xA1; 32];
const FINGERPRINT_B: [u8; 32] = [0xB2; 32];

struct Fixture {
    dir: tempfile::TempDir,
    mgr: CredentialManager,
    verifier: Arc<MockVerifier>,
    slot: Arc<MemorySlot>,
}

impl Fixture {
    fn metadata_path(&self) -> PathBuf {
        self.dir.path().join(METADATA_FILE_NAME)
    }

    fn lock(&self) {
        self.mgr.with_master_password_store(|s| s.lock()).unwrap();
    }

    fn is_unlocked(&self) -> bool {
        self.mgr.status() == CredentialStoreStatus::Unlocked
    }

    fn enrolled(&self) -> bool {
        self.metadata_path().exists() || self.slot.has_value()
    }
}

/// An unlocked master-password store with one saved credential.
fn fixture(verifier: MockVerifier) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let verifier = Arc::new(verifier);
    let slot = Arc::new(MemorySlot::default());
    let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf())
        .with_os_auth(Box::new(verifier.clone()))
        .with_biometric_slot(Box::new(slot.clone()));
    mgr.with_master_password_store(|s| s.setup(MASTER))
        .unwrap()
        .unwrap();
    mgr.set(&secret_key(), "s3cret-value").unwrap();
    Fixture {
        dir,
        mgr,
        verifier,
        slot,
    }
}

fn secret_key() -> CredentialKey {
    CredentialKey::new("conn-1", CredentialType::Password)
}

/// A fixture that is enrolled (fingerprint A) and then locked.
fn enrolled_and_locked(extra: impl IntoIterator<Item = MockOutcome>) -> Fixture {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    for outcome in extra {
        fx.verifier.push(outcome);
    }
    fx.lock();
    fx
}

// --- enabling ---

#[test]
fn enable_then_unlock_round_trip() {
    let fx = enrolled_and_locked([MockOutcome::Success(Some(FINGERPRINT_A))]);
    assert!(fx.mgr.biometric_unlock_status().enabled);
    assert!(!fx.is_unlocked());

    fx.mgr.unlock_with_biometrics().unwrap();

    assert!(fx.is_unlocked());
    assert_eq!(
        fx.mgr.get(&secret_key()).unwrap().as_deref(),
        Some("s3cret-value")
    );
    let purposes: Vec<_> = fx.verifier.calls().into_iter().map(|(p, _)| p).collect();
    assert_eq!(
        purposes,
        vec![
            OsAuthPurpose::EnableBiometricUnlock,
            OsAuthPurpose::BiometricUnlock
        ]
    );
}

#[test]
fn unlocked_store_keeps_working_after_biometric_unlock() {
    // The key recovered via biometrics must be the real vault key: writes
    // re-seal the file so that the master password still opens it.
    let fx = enrolled_and_locked([MockOutcome::Success(Some(FINGERPRINT_A))]);
    fx.mgr.unlock_with_biometrics().unwrap();
    let other = CredentialKey::new("conn-2", CredentialType::Password);
    fx.mgr.set(&other, "after-bio").unwrap();
    fx.lock();
    fx.mgr
        .with_master_password_store(|s| s.unlock(MASTER))
        .unwrap()
        .unwrap();
    assert_eq!(fx.mgr.get(&other).unwrap().as_deref(), Some("after-bio"));
}

#[test]
fn enable_requires_the_correct_master_password_before_prompting() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    assert!(matches!(
        fx.mgr.enable_biometric_unlock("wrong"),
        Err(BiometricUnlockError::WrongMasterPassword { .. })
    ));
    assert!(fx.verifier.calls().is_empty(), "no OS prompt for a typo");
    assert!(!fx.enrolled());
}

#[test]
fn enable_requires_an_unlocked_store() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.lock();
    assert!(matches!(
        fx.mgr.enable_biometric_unlock(MASTER),
        Err(BiometricUnlockError::StoreUnavailable { .. })
    ));
    assert!(!fx.enrolled());
}

#[test]
fn enable_refused_when_os_verification_unavailable_cancelled_or_failed() {
    let fx = fixture(MockVerifier::unavailable());
    assert!(matches!(
        fx.mgr.enable_biometric_unlock(MASTER),
        Err(BiometricUnlockError::AuthFailed { .. })
    ));
    assert!(!fx.enrolled());
    assert!(!fx.mgr.biometric_unlock_status().supported);

    let fx = fixture(MockVerifier::new([
        MockOutcome::Error(OsAuthError::Cancelled),
        MockOutcome::Error(OsAuthError::Failed("no match".into())),
    ]));
    assert!(matches!(
        fx.mgr.enable_biometric_unlock(MASTER),
        Err(BiometricUnlockError::Cancelled { .. })
    ));
    assert!(matches!(
        fx.mgr.enable_biometric_unlock(MASTER),
        Err(BiometricUnlockError::AuthFailed { .. })
    ));
    assert!(!fx.enrolled());
}

#[test]
fn enable_is_refused_outside_master_password_mode() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = CredentialManager::new(StorageMode::OsKeychain, dir.path().to_path_buf())
        .with_os_auth(Box::new(MockVerifier::succeeding(1, None)))
        .with_biometric_slot(Box::new(MemorySlot::default()));
    assert!(matches!(
        mgr.enable_biometric_unlock(MASTER),
        Err(BiometricUnlockError::StoreUnavailable { .. })
    ));
    assert!(matches!(
        mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::StoreUnavailable { .. })
    ));
}

#[test]
fn failed_key_write_leaves_no_enrollment() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.slot.fail_writes.store(true, Ordering::SeqCst);
    assert!(matches!(
        fx.mgr.enable_biometric_unlock(MASTER),
        Err(BiometricUnlockError::Other { .. })
    ));
    assert!(!fx.enrolled());
}

#[test]
fn metadata_file_never_contains_the_vault_key() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    let (key, _) = fx
        .mgr
        .with_master_password_store(|s| s.key_material())
        .unwrap()
        .unwrap();
    let raw = std::fs::read_to_string(fx.metadata_path()).unwrap();
    assert!(!raw.contains(&BASE64.encode(key.as_slice())));
    assert!(!raw.contains(&hex::encode(key.as_slice())));
    // The wrapping key lives only in the OS store, never in the file.
    let wrapping = fx.slot.read().unwrap().unwrap();
    assert!(!raw.contains(wrapping.as_str()));
}

// --- unlocking ---

#[test]
fn cancelled_or_failed_prompt_keeps_the_store_locked_and_the_enrollment() {
    let fx = enrolled_and_locked([
        MockOutcome::Error(OsAuthError::Cancelled),
        MockOutcome::Error(OsAuthError::Failed("lockout".into())),
        MockOutcome::Error(OsAuthError::Unavailable("lid closed".into())),
    ]);
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::Cancelled { .. })
    ));
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::AuthFailed { .. })
    ));
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::AuthFailed { .. })
    ));
    assert!(!fx.is_unlocked());
    assert!(
        fx.enrolled(),
        "a cancelled prompt must not drop the enrollment"
    );
}

#[test]
fn unlock_without_enrollment_is_not_enabled_and_does_not_prompt() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.lock();
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::NotEnabled { .. })
    ));
    assert!(fx.verifier.calls().is_empty());
}

#[test]
fn already_unlocked_store_is_a_no_op_without_prompt() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    fx.mgr.unlock_with_biometrics().unwrap();
    assert_eq!(fx.verifier.calls().len(), 1, "only the enable prompt");
}

#[test]
fn biometric_enrollment_change_invalidates() {
    // A new fingerprint enrolled since opt-in (macOS domain state changed):
    // the stored key must not be released (biometryCurrentSet semantics).
    let fx = enrolled_and_locked([MockOutcome::Success(Some(FINGERPRINT_B))]);
    let err = fx.mgr.unlock_with_biometrics().unwrap_err();
    assert!(
        matches!(err, BiometricUnlockError::Invalidated { .. }),
        "{err:?}"
    );
    assert!(!fx.is_unlocked());
    assert!(!fx.enrolled(), "invalidation deletes both halves");
    assert!(!fx.mgr.biometric_unlock_status().enabled);
    // The master password still works.
    fx.mgr
        .with_master_password_store(|s| s.unlock(MASTER))
        .unwrap()
        .unwrap();
}

#[test]
fn missing_enrollment_fingerprint_is_treated_as_a_change() {
    let fx = enrolled_and_locked([MockOutcome::Success(None)]);
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::Invalidated { .. })
    ));
    assert!(!fx.enrolled());
}

#[test]
fn master_password_change_invalidates_the_enrollment() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    fx.mgr.change_master_password(MASTER, "new-master").unwrap();
    assert!(!fx.enrolled());
    fx.lock();
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::NotEnabled { .. })
    ));
}

#[test]
fn salt_change_behind_our_back_invalidates_before_prompting() {
    // The vault was re-keyed without going through the manager (e.g. a file
    // restored from elsewhere): the enrollment is stale and is dropped
    // *before* any OS prompt.
    let fx = enrolled_and_locked([MockOutcome::Success(Some(FINGERPRINT_A))]);
    fx.mgr
        .with_master_password_store(|s| {
            s.unlock(MASTER)?;
            s.change_password(MASTER, "other")?;
            s.lock();
            anyhow::Ok(())
        })
        .unwrap()
        .unwrap();
    let calls_before = fx.verifier.calls().len();
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::Invalidated { .. })
    ));
    assert_eq!(fx.verifier.calls().len(), calls_before, "no prompt");
    assert!(!fx.enrolled());
}

#[test]
fn missing_wrapping_key_invalidates() {
    let fx = enrolled_and_locked([MockOutcome::Success(Some(FINGERPRINT_A))]);
    fx.slot.overwrite(None);
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::Invalidated { .. })
    ));
    assert!(!fx.enrolled());
    assert!(!fx.is_unlocked());
}

#[test]
fn wrong_wrapping_key_invalidates() {
    let fx = enrolled_and_locked([MockOutcome::Success(Some(FINGERPRINT_A))]);
    fx.slot.overwrite(Some(&BASE64.encode([7u8; KEY_LEN])));
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::Invalidated { .. })
    ));
    assert!(!fx.is_unlocked());
}

#[test]
fn editing_the_enrollment_binding_in_the_file_does_not_bypass_it() {
    // An attacker who can edit the metadata to match a *new* fingerprint set
    // still fails: the binding is part of the AEAD associated data.
    let fx = enrolled_and_locked([MockOutcome::Success(Some(FINGERPRINT_B))]);
    let raw = std::fs::read_to_string(fx.metadata_path()).unwrap();
    let edited = raw.replace(&hex::encode(FINGERPRINT_A), &hex::encode(FINGERPRINT_B));
    assert_ne!(raw, edited);
    std::fs::write(fx.metadata_path(), edited).unwrap();
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::Invalidated { .. })
    ));
    assert!(!fx.is_unlocked());
}

#[test]
fn corrupt_metadata_invalidates() {
    let fx = enrolled_and_locked([]);
    std::fs::write(fx.metadata_path(), "{ not json").unwrap();
    assert!(matches!(
        fx.mgr.unlock_with_biometrics(),
        Err(BiometricUnlockError::Invalidated { .. })
    ));
    assert!(!fx.enrolled());
    assert!(fx.verifier.calls().len() == 1, "no unlock prompt");
}

// --- opting out / lifecycle ---

#[test]
fn disable_deletes_both_halves_and_is_idempotent() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    assert!(fx.metadata_path().exists() && fx.slot.has_value());
    fx.mgr.disable_biometric_unlock().unwrap();
    assert!(!fx.enrolled());
    fx.mgr.disable_biometric_unlock().unwrap();
}

#[test]
fn switching_away_from_master_password_drops_the_enrollment() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    fx.mgr.switch_store(StorageMode::None).unwrap();
    assert!(!fx.enrolled());
    assert!(!fx.mgr.biometric_unlock_status().enabled);
}

#[test]
fn resetting_the_store_drops_the_enrollment() {
    let fx = fixture(MockVerifier::succeeding(1, Some(FINGERPRINT_A)));
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    fx.mgr.reset_master_password_store().unwrap();
    assert!(!fx.enrolled());
}

#[test]
fn status_reports_support_and_enablement() {
    let fx = fixture(MockVerifier::succeeding(1, None));
    let status = fx.mgr.biometric_unlock_status();
    assert!(status.supported);
    assert!(!status.enabled);
    assert_eq!(status.method_label, "Mock ID");
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    assert!(fx.mgr.biometric_unlock_status().enabled);
}

#[test]
fn platforms_without_an_enrollment_fingerprint_still_round_trip() {
    // Windows Hello exposes no enrollment state: enrollment and unlock both
    // carry `None`, which must match.
    let fx = fixture(MockVerifier::succeeding(2, None));
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    fx.lock();
    fx.mgr.unlock_with_biometrics().unwrap();
    assert!(fx.is_unlocked());
}

#[test]
fn error_kinds_serialize_stably() {
    let value = serde_json::to_value(BiometricUnlockError::Invalidated {
        message: "m".into(),
    })
    .unwrap();
    assert_eq!(value["kind"], "invalidated");
    let value = serde_json::to_value(BiometricUnlockError::Cancelled {
        message: "m".into(),
    })
    .unwrap();
    assert_eq!(value["kind"], "cancelled");
}
