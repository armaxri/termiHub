//! OS-enforced protection of the biometric-unlock wrapping key (#3534).
//!
//! The original biometric-unlock design (#3433) keeps a random wrapping key
//! in the OS credential store and only *reads* it after termiHub's own OS
//! verification — the gate is enforced by termiHub, so code running as the
//! user can read the key without a prompt. A [`HardwareKeyProtector`] moves
//! the gate into the OS:
//!
//! | Platform | Mechanism | Prompts on create | Prompts on release |
//! | --- | --- | --- | --- |
//! | macOS | Random key in the **data-protection keychain** with a `SecAccessControl` of `.biometryCurrentSet` (Secure Enclave-enforced; invalidated by enrollment changes). Needs the `keychain-access-groups` entitlement — unsigned builds get `errSecMissingEntitlement` and fall back | no | yes (Touch ID) |
//! | Windows | Windows Hello `KeyCredentialManager` key; the wrapping key is HKDF over the Hello signature of a fixed challenge, so it only exists after Hello | yes | yes (Hello) |
//! | Other / unit tests | [`NoHardwareKey`] — always unavailable | — | — |
//!
//! Selection happens at runtime: [`HardwareKeyProtector::probe`] never
//! prompts, and an `Unavailable` result (missing entitlement, Hello key
//! credentials not supported, non-deterministic signatures) makes biometric
//! unlock fall back to the app-enforced path, reported to the UI as
//! "OS-enforced: no".

use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
pub mod mock;
// Test builds never construct the real Windows protector (`platform_hw_key`
// hands tests `NoHardwareKey`), so the module is expected dead there.
#[cfg(windows)]
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "test builds never construct the real Windows Hello protector"
    )
)]
mod windows_hello;

/// Length of the wrapping key in bytes (AES-256).
pub const WRAPPING_KEY_LEN: usize = 32;

/// A 256-bit wrapping key, zeroized on drop.
pub type WrappingKey = Zeroizing<[u8; WRAPPING_KEY_LEN]>;

/// Name of the OS-enforced key (keychain service / Hello key credential).
#[cfg_attr(
    any(all(test, windows), not(any(target_os = "macos", windows))),
    expect(
        dead_code,
        reason = "only the real macOS and Windows protectors name a key"
    )
)]
pub const HW_KEY_NAME: &str = "termiHub-biometric-unlock-v2";

/// Why an OS-enforced key operation did not succeed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HwKeyError {
    /// OS-enforced protection cannot be used here (no entitlement, no Hello
    /// key credentials, …). Callers fall back to the app-enforced path.
    #[error("OS-enforced key protection is not available: {0}")]
    Unavailable(String),
    /// The key no longer exists (deleted, or invalidated by the OS after a
    /// biometric-enrollment change).
    #[cfg_attr(
        not(any(test, target_os = "macos", windows)),
        expect(dead_code, reason = "only produced by a real OS protector")
    )]
    #[error("The biometric unlock key no longer exists.")]
    Missing,
    /// The user dismissed the prompt.
    #[cfg_attr(
        not(any(test, target_os = "macos", windows)),
        expect(dead_code, reason = "only produced by a real OS protector")
    )]
    #[error("System authentication was cancelled.")]
    Cancelled,
    /// The OS rejected the user.
    #[cfg_attr(
        not(any(test, target_os = "macos", windows)),
        expect(dead_code, reason = "only produced by a real OS protector")
    )]
    #[error("System authentication failed: {0}")]
    Failed(String),
    /// Any other OS error.
    #[cfg_attr(
        not(any(test, target_os = "macos", windows)),
        expect(dead_code, reason = "only produced by a real OS protector")
    )]
    #[error("System error: {0}")]
    Other(String),
}

/// Holds the biometric-unlock wrapping key under OS-enforced user presence.
///
/// Implementations block the calling (non-UI) thread while a prompt is open
/// and must never return a key unless the OS confirmed the user (for
/// [`release`](Self::release)) — the key store itself enforces this, not
/// termiHub.
pub trait HardwareKeyProtector: Send + Sync {
    /// Whether OS-enforced protection can be used here. **Never prompts.**
    fn probe(&self) -> Result<(), HwKeyError>;

    /// Whether [`create`](Self::create) itself prompts the user (Windows
    /// Hello). When it does, the separate OS verification is skipped on
    /// enable so the user is not asked more often than necessary.
    fn create_prompts(&self) -> bool;

    /// Create a fresh wrapping key under OS access control, replacing any
    /// previous one, and return it (it is needed once to wrap the vault key).
    fn create(&self, reason: &str, owner_window: Option<isize>) -> Result<WrappingKey, HwKeyError>;

    /// Release the wrapping key. Always prompts (Touch ID / Windows Hello).
    fn release(&self, reason: &str, owner_window: Option<isize>)
        -> Result<WrappingKey, HwKeyError>;

    /// Delete the key. Deleting a missing key, or deleting where the
    /// protector is unavailable, is not an error.
    fn delete(&self) -> Result<(), HwKeyError>;
}

impl<T: HardwareKeyProtector + ?Sized> HardwareKeyProtector for std::sync::Arc<T> {
    fn probe(&self) -> Result<(), HwKeyError> {
        (**self).probe()
    }
    fn create_prompts(&self) -> bool {
        (**self).create_prompts()
    }
    fn create(&self, reason: &str, owner_window: Option<isize>) -> Result<WrappingKey, HwKeyError> {
        (**self).create(reason, owner_window)
    }
    fn release(
        &self,
        reason: &str,
        owner_window: Option<isize>,
    ) -> Result<WrappingKey, HwKeyError> {
        (**self).release(reason, owner_window)
    }
    fn delete(&self) -> Result<(), HwKeyError> {
        (**self).delete()
    }
}

/// The protector for platforms (and unit tests) without OS-enforced keys.
#[cfg_attr(
    all(not(test), any(target_os = "macos", windows)),
    expect(
        dead_code,
        reason = "macOS and Windows builds use their real protector"
    )
)]
pub struct NoHardwareKey {
    reason: String,
}

impl NoHardwareKey {
    /// An always-unavailable protector reporting `reason`.
    #[cfg_attr(
        all(not(test), any(target_os = "macos", windows)),
        expect(
            dead_code,
            reason = "macOS and Windows builds use their real protector"
        )
    )]
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl HardwareKeyProtector for NoHardwareKey {
    fn probe(&self) -> Result<(), HwKeyError> {
        Err(HwKeyError::Unavailable(self.reason.clone()))
    }
    fn create_prompts(&self) -> bool {
        false
    }
    fn create(&self, _: &str, _: Option<isize>) -> Result<WrappingKey, HwKeyError> {
        Err(HwKeyError::Unavailable(self.reason.clone()))
    }
    fn release(&self, _: &str, _: Option<isize>) -> Result<WrappingKey, HwKeyError> {
        Err(HwKeyError::Unavailable(self.reason.clone()))
    }
    fn delete(&self) -> Result<(), HwKeyError> {
        Ok(())
    }
}

/// HKDF salt for deriving a wrapping key from a Windows Hello signature.
const SIGNATURE_KDF_SALT: &[u8] = b"termihub-biometric-unlock/hello-signature/v1";
/// HKDF info for the derived wrapping key.
const SIGNATURE_KDF_INFO: &[u8] = b"wrapping-key";

/// Derive a wrapping key from a signature over the fixed challenge
/// (HKDF-SHA256). The signature is the secret input: it can only be produced
/// by the OS after user verification.
///
/// Requires deterministic signatures (RSASSA-PKCS1-v1_5, which Windows Hello
/// key credentials use); callers verify that by signing twice on create.
#[cfg_attr(
    not(any(test, windows)),
    expect(dead_code, reason = "only the Windows Hello protector derives keys")
)]
pub fn derive_wrapping_key(signature: &[u8]) -> Result<WrappingKey, HwKeyError> {
    if signature.len() < WRAPPING_KEY_LEN {
        return Err(HwKeyError::Other(format!(
            "the OS returned a {}-byte signature, too short to derive a key from",
            signature.len()
        )));
    }
    let hkdf = Hkdf::<Sha256>::new(Some(SIGNATURE_KDF_SALT), signature);
    let mut key = Zeroizing::new([0u8; WRAPPING_KEY_LEN]);
    hkdf.expand(SIGNATURE_KDF_INFO, key.as_mut())
        .map_err(|e| HwKeyError::Other(format!("key derivation failed: {e}")))?;
    Ok(key)
}

/// Derive the wrapping key from two signatures of the same challenge,
/// refusing (as [`HwKeyError::Unavailable`], so callers fall back) when they
/// differ — a non-deterministic signature scheme could never reproduce the
/// key at unlock time.
#[cfg_attr(
    not(any(test, windows)),
    expect(dead_code, reason = "only the Windows Hello protector derives keys")
)]
pub fn derive_wrapping_key_checked(first: &[u8], second: &[u8]) -> Result<WrappingKey, HwKeyError> {
    if first != second {
        return Err(HwKeyError::Unavailable(
            "Windows Hello signatures are not reproducible on this device".to_string(),
        ));
    }
    derive_wrapping_key(first)
}

/// The OS-enforced protector for the platform this build runs on.
///
/// Unit tests always get [`NoHardwareKey`] so a test can never touch the real
/// keychain / Windows Hello; they inject [`mock::MockHwKey`] instead.
pub fn platform_hw_key() -> Box<dyn HardwareKeyProtector> {
    #[cfg(test)]
    {
        Box::new(NoHardwareKey::new(
            "OS-enforced key protection is disabled in unit tests",
        ))
    }
    #[cfg(all(not(test), target_os = "macos"))]
    {
        Box::new(macos::MacKeychainKey)
    }
    #[cfg(all(not(test), windows))]
    {
        Box::new(windows_hello::HelloKeyCredential)
    }
    #[cfg(all(not(test), not(target_os = "macos"), not(windows)))]
    {
        Box::new(NoHardwareKey::new(
            "This operating system has no OS-enforced biometric key store.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivation_is_deterministic_and_input_sensitive() {
        let sig = [7u8; 256];
        let a = derive_wrapping_key(&sig).unwrap();
        let b = derive_wrapping_key(&sig).unwrap();
        assert_eq!(*a, *b);
        let mut other = sig;
        other[255] ^= 1;
        assert_ne!(*a, *derive_wrapping_key(&other).unwrap());
        // The key is not the signature itself.
        assert_ne!(&a[..], &sig[..WRAPPING_KEY_LEN]);
    }

    #[test]
    fn short_signatures_are_refused() {
        assert!(matches!(
            derive_wrapping_key(&[1u8; 16]),
            Err(HwKeyError::Other(_))
        ));
    }

    #[test]
    fn differing_signatures_mean_unavailable_so_callers_fall_back() {
        assert!(matches!(
            derive_wrapping_key_checked(&[1u8; 256], &[2u8; 256]),
            Err(HwKeyError::Unavailable(_))
        ));
        assert!(derive_wrapping_key_checked(&[1u8; 256], &[1u8; 256]).is_ok());
    }

    #[test]
    fn no_hardware_key_is_unavailable_and_delete_is_ok() {
        let p = NoHardwareKey::new("nope");
        assert_eq!(p.probe(), Err(HwKeyError::Unavailable("nope".into())));
        assert!(matches!(
            p.create("r", None),
            Err(HwKeyError::Unavailable(_))
        ));
        assert!(matches!(
            p.release("r", None),
            Err(HwKeyError::Unavailable(_))
        ));
        assert_eq!(p.delete(), Ok(()));
        assert!(!p.create_prompts());
    }
}
