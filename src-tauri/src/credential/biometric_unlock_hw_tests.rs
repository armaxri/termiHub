//! Tests for OS-enforced biometric-unlock keys (#3534): runtime selection,
//! fallback to the app-enforced path, migration and invalidation.
//!
//! Everything runs against [`MockVerifier`], an in-memory [`MemorySlot`] and
//! a scripted [`MockHwKey`] — no real keychain, no real prompt — so these run
//! on every platform, including the Windows-Hello-shaped flows.

use std::sync::Arc;

use super::*;
use crate::credential::hw_key::mock::{HwCall, MockHwKey};
use crate::credential::os_auth::mock::MockVerifier;
use crate::credential::os_auth::OsAuthPurpose;
use crate::credential::types::{CredentialKey, CredentialStoreStatus, CredentialType};
use crate::credential::{CredentialManager, CredentialStore, StorageMode};

const MASTER: &str = "master-pw";
const FINGERPRINT: [u8; 32] = [0xA1; 32];

struct Fixture {
    dir: tempfile::TempDir,
    mgr: CredentialManager,
    verifier: Arc<MockVerifier>,
    slot: Arc<MemorySlot>,
    hw: Arc<MockHwKey>,
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

    fn protection(&self) -> Option<KeyProtection> {
        self.mgr.biometric_unlock_status().protection
    }

    fn verifier_calls(&self) -> usize {
        self.verifier.calls().len()
    }

    fn hw_calls(&self, call: HwCall) -> usize {
        self.hw.calls().iter().filter(|c| **c == call).count()
    }

    fn secret(&self) -> Option<String> {
        self.mgr.get(&secret_key()).unwrap()
    }
}

fn secret_key() -> CredentialKey {
    CredentialKey::new("conn-1", CredentialType::Password)
}

/// An unlocked master-password store with one secret; the verifier succeeds
/// `verifier_successes` times.
fn fixture(hw: MockHwKey, verifier_successes: usize) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let verifier = Arc::new(MockVerifier::succeeding(
        verifier_successes,
        Some(FINGERPRINT),
    ));
    let slot = Arc::new(MemorySlot::default());
    let hw = Arc::new(hw);
    let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf())
        .with_os_auth(Box::new(verifier.clone()))
        .with_biometric_keys(Box::new(slot.clone()), Box::new(hw.clone()));
    mgr.with_master_password_store(|s| s.setup(MASTER))
        .unwrap()
        .unwrap();
    mgr.set(&secret_key(), "s3cret-value").unwrap();
    Fixture {
        dir,
        mgr,
        verifier,
        slot,
        hw,
    }
}

// --- selection ---

#[test]
fn macos_shaped_protector_verifies_first_then_creates_and_unlock_skips_the_app_prompt() {
    // macOS keychain: creating the item does not prompt, so termiHub's own
    // verification authorises the enrollment; the unlock prompt is the OS's.
    let fx = fixture(MockHwKey::available(false), 1);
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();

    assert_eq!(fx.verifier_calls(), 1);
    assert_eq!(
        fx.verifier.calls()[0].0,
        OsAuthPurpose::EnableBiometricUnlock
    );
    assert_eq!(fx.hw_calls(HwCall::Create), 1);
    assert_eq!(fx.protection(), Some(KeyProtection::OsEnforced));
    assert!(fx.mgr.biometric_unlock_status().os_enforced_available);
    assert!(!fx.slot.has_value(), "no app-enforced key is stored");

    fx.lock();
    fx.mgr.unlock_with_biometrics().unwrap();
    assert!(fx.is_unlocked());
    assert_eq!(fx.secret().as_deref(), Some("s3cret-value"));
    assert_eq!(
        fx.verifier_calls(),
        1,
        "unlock must not add termiHub's prompt"
    );
    assert_eq!(fx.hw_calls(HwCall::Release), 1);
}

#[test]
fn windows_shaped_protector_lets_hello_replace_the_separate_verification() {
    // Windows Hello: creating the key credential prompts, so the separate
    // UserConsentVerifier prompt is skipped on enable and on unlock.
    let fx = fixture(MockHwKey::available(true), 0);
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    assert_eq!(fx.verifier_calls(), 0);
    assert_eq!(fx.protection(), Some(KeyProtection::OsEnforced));

    fx.lock();
    fx.mgr.unlock_with_biometrics().unwrap();
    assert!(fx.is_unlocked());
    assert_eq!(fx.verifier_calls(), 0);
}

#[test]
fn unavailable_protector_falls_back_to_the_app_enforced_key() {
    // Unsigned macOS build (errSecMissingEntitlement) / no Hello keys.
    let fx = fixture(MockHwKey::unavailable(), 2);
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();

    assert_eq!(fx.hw_calls(HwCall::Create), 0, "probe decides, no create");
    assert_eq!(fx.protection(), Some(KeyProtection::App));
    assert!(!fx.mgr.biometric_unlock_status().os_enforced_available);
    assert!(fx.slot.has_value());

    fx.lock();
    fx.mgr.unlock_with_biometrics().unwrap();
    assert!(fx.is_unlocked());
    assert_eq!(fx.verifier_calls(), 2);
}

#[test]
fn create_reporting_unavailable_falls_back_on_both_shapes() {
    for create_prompts in [false, true] {
        let hw = MockHwKey::available(create_prompts);
        hw.fail_next_create(HwKeyError::Unavailable("signatures differ".into()));
        let fx = fixture(hw, 1);
        fx.mgr.enable_biometric_unlock(MASTER).unwrap();
        assert_eq!(fx.protection(), Some(KeyProtection::App));
        assert!(fx.slot.has_value());
        assert_eq!(
            fx.verifier_calls(),
            1,
            "the fallback still verifies the user"
        );
    }
}

#[test]
fn cancelled_or_failed_create_refuses_enable_and_enrolls_nothing() {
    for (error, cancelled) in [
        (HwKeyError::Cancelled, true),
        (HwKeyError::Failed("no".into()), false),
    ] {
        let hw = MockHwKey::available(true);
        hw.fail_next_create(error);
        let fx = fixture(hw, 1);
        let err = fx.mgr.enable_biometric_unlock(MASTER).unwrap_err();
        assert_eq!(
            matches!(err, BiometricUnlockError::Cancelled { .. }),
            cancelled
        );
        assert!(!fx.metadata_path().exists());
        assert!(!fx.slot.has_value());
        assert!(!fx.mgr.biometric_unlock_status().enabled);
    }
}

// --- unlock outcomes ---

fn os_enforced_and_locked(create_prompts: bool) -> Fixture {
    let fx = fixture(MockHwKey::available(create_prompts), 1);
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    fx.lock();
    fx
}

#[test]
fn missing_os_key_invalidates_the_enrollment() {
    // biometryCurrentSet: adding a finger makes the OS drop the item.
    let fx = os_enforced_and_locked(false);
    fx.hw.forget_key();
    let err = fx.mgr.unlock_with_biometrics().unwrap_err();
    assert!(matches!(err, BiometricUnlockError::Invalidated { .. }));
    assert!(!fx.metadata_path().exists());
    assert!(!fx.is_unlocked());
    assert!(!fx.mgr.biometric_unlock_status().enabled);
}

#[test]
fn os_key_unavailable_at_unlock_invalidates_with_a_clear_message() {
    // e.g. an OS-enforced enrollment opened by an unsigned build.
    let fx = os_enforced_and_locked(false);
    fx.hw.set_available(false);
    let err = fx.mgr.unlock_with_biometrics().unwrap_err();
    match err {
        BiometricUnlockError::Invalidated { message } => {
            assert!(message.contains("OS-protected"), "{message}")
        }
        other => panic!("expected invalidated, got {other:?}"),
    }
    assert!(!fx.metadata_path().exists());
}

#[test]
fn cancelled_or_failed_os_prompt_keeps_the_enrollment_and_the_lock() {
    let fx = os_enforced_and_locked(true);
    fx.hw.fail_next_release(HwKeyError::Cancelled);
    assert!(matches!(
        fx.mgr.unlock_with_biometrics().unwrap_err(),
        BiometricUnlockError::Cancelled { .. }
    ));
    fx.hw
        .fail_next_release(HwKeyError::Failed("wrong finger".into()));
    assert!(matches!(
        fx.mgr.unlock_with_biometrics().unwrap_err(),
        BiometricUnlockError::AuthFailed { .. }
    ));
    assert!(!fx.is_unlocked());
    assert!(fx.metadata_path().exists());

    fx.mgr.unlock_with_biometrics().unwrap();
    assert!(fx.is_unlocked());
}

#[test]
fn editing_the_protection_kind_in_the_file_does_not_bypass_it() {
    let fx = os_enforced_and_locked(false);
    let raw = std::fs::read_to_string(fx.metadata_path()).unwrap();
    std::fs::write(fx.metadata_path(), raw.replace("\"osEnforced\"", "\"app\"")).unwrap();
    fx.verifier
        .push(crate::credential::os_auth::mock::MockOutcome::Success(
            Some(FINGERPRINT),
        ));
    let err = fx.mgr.unlock_with_biometrics().unwrap_err();
    assert!(matches!(err, BiometricUnlockError::Invalidated { .. }));
    assert!(!fx.is_unlocked());
}

#[test]
fn master_password_change_drops_the_os_key() {
    let fx = os_enforced_and_locked(false);
    fx.mgr
        .with_master_password_store(|s| s.unlock(MASTER))
        .unwrap()
        .unwrap();
    fx.mgr.change_master_password(MASTER, "new-master").unwrap();
    assert!(!fx.hw.has_key(), "a password change drops the OS key too");
    assert!(!fx.metadata_path().exists());
}

#[test]
fn disable_deletes_the_os_enforced_key() {
    let fx = fixture(MockHwKey::available(false), 1);
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    assert!(fx.hw.has_key());
    fx.mgr.disable_biometric_unlock().unwrap();
    assert!(!fx.hw.has_key());
    assert!(!fx.metadata_path().exists());
    assert_eq!(fx.protection(), None);
}

// --- migration ---

/// An app-enforced enrollment (protector unavailable at enable time), locked.
fn legacy_enrollment(create_prompts: bool, verifier_successes: usize) -> Fixture {
    let hw = MockHwKey::available(create_prompts);
    hw.set_available(false);
    let fx = fixture(hw, verifier_successes);
    fx.mgr.enable_biometric_unlock(MASTER).unwrap();
    assert_eq!(fx.protection(), Some(KeyProtection::App));
    fx.lock();
    fx
}

#[test]
fn legacy_enrollment_is_upgraded_on_the_next_successful_unlock() {
    for create_prompts in [false, true] {
        let fx = legacy_enrollment(create_prompts, 2);
        // The build gains the entitlement / the user sets up Hello keys.
        fx.hw.set_available(true);

        fx.mgr.unlock_with_biometrics().unwrap();
        assert!(fx.is_unlocked());
        assert_eq!(fx.protection(), Some(KeyProtection::OsEnforced));
        assert!(!fx.slot.has_value(), "the app-enforced key is deleted");

        // From now on the OS releases the key; termiHub does not prompt.
        let before = fx.verifier_calls();
        fx.lock();
        fx.mgr.unlock_with_biometrics().unwrap();
        assert!(fx.is_unlocked());
        assert_eq!(fx.verifier_calls(), before);
        assert_eq!(fx.secret().as_deref(), Some("s3cret-value"));
    }
}

#[test]
fn failed_upgrade_keeps_the_legacy_enrollment_and_is_not_retried_this_run() {
    let fx = legacy_enrollment(true, 3);
    fx.hw.set_available(true);
    fx.hw.fail_next_create(HwKeyError::Cancelled);

    fx.mgr.unlock_with_biometrics().unwrap();
    assert!(fx.is_unlocked(), "a failed upgrade never fails the unlock");
    assert_eq!(fx.protection(), Some(KeyProtection::App));
    assert!(fx.slot.has_value());

    fx.lock();
    fx.mgr.unlock_with_biometrics().unwrap();
    assert!(fx.is_unlocked());
    assert_eq!(fx.hw_calls(HwCall::Create), 1, "no second upgrade prompt");
}

#[test]
fn version_1_metadata_without_protection_still_unlocks() {
    // Files written before #3534 have `version: 1` and no `protection`.
    let fx = legacy_enrollment(false, 2);
    let mut json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fx.metadata_path()).unwrap()).unwrap();
    let object = json.as_object_mut().unwrap();
    object.remove("protection");
    object.insert("version".into(), 1.into());
    std::fs::write(fx.metadata_path(), json.to_string()).unwrap();

    fx.mgr.unlock_with_biometrics().unwrap();
    assert!(fx.is_unlocked());
}

#[test]
fn version_1_metadata_claiming_os_enforced_is_rejected() {
    let fx = os_enforced_and_locked(false);
    let raw = std::fs::read_to_string(fx.metadata_path()).unwrap();
    std::fs::write(
        fx.metadata_path(),
        raw.replace("\"version\": 2", "\"version\": 1"),
    )
    .unwrap();
    assert!(matches!(
        fx.mgr.unlock_with_biometrics().unwrap_err(),
        BiometricUnlockError::Invalidated { .. }
    ));
}
