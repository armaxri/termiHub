//! macOS: wrapping key in the data-protection keychain behind
//! `SecAccessControl(.biometryCurrentSet)` (#3534).
//!
//! The item is created with `kSecUseDataProtectionKeychain` and an access
//! control of `.biometryCurrentSet` (accessible only while a passcode is set,
//! this device only). Reading it makes the **Secure Enclave** require Touch ID
//! of a currently enrolled finger; adding or removing a finger invalidates
//! the item permanently, so termiHub cannot read it back without the OS.
//!
//! The data-protection keychain requires the `keychain-access-groups`
//! entitlement, which only a code-signed build with a provisioning profile can
//! carry. Unsigned / ad-hoc builds (the v0.1.0 beta) get
//! `errSecMissingEntitlement` (-34018); [`probe`](HardwareKeyProtector::probe)
//! detects that without prompting by writing a throwaway item, and
//! biometric unlock falls back to the app-enforced login-keychain path.

use std::ptr;
use std::sync::OnceLock;

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use objc2::rc::Retained;
use objc2_foundation::NSString;
use objc2_local_authentication::LAContext;
use rand::rngs::OsRng;
use rand::RngCore;
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework_sys::access_control::kSecAccessControlBiometryCurrentSet;
use security_framework_sys::item::{
    kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword,
    kSecReturnData, kSecUseAuthenticationContext, kSecUseDataProtectionKeychain, kSecValueData,
};
use security_framework_sys::keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete};
use zeroize::Zeroizing;

use super::{HardwareKeyProtector, HwKeyError, WrappingKey, HW_KEY_NAME, WRAPPING_KEY_LEN};

const ACCOUNT: &str = "master-password-store";
/// Account of the throwaway item [`MacKeychainKey::probe`] writes.
const PROBE_ACCOUNT: &str = "entitlement-probe";

// OSStatus codes (Security/SecBase.h).
const ERR_SEC_SUCCESS: i32 = 0;
const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_SEC_AUTH_FAILED: i32 = -25293;
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;
const ERR_SEC_MISSING_ENTITLEMENT: i32 = -34018;
const ERR_SEC_NOT_AVAILABLE: i32 = -25291;
const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;

/// The data-protection keychain protector.
pub struct MacKeychainKey;

/// Map an `OSStatus` from a keychain call to the protector taxonomy.
fn map_status(status: i32) -> HwKeyError {
    match status {
        ERR_SEC_MISSING_ENTITLEMENT => HwKeyError::Unavailable(
            "this build is not code-signed with the keychain-access-groups entitlement".into(),
        ),
        ERR_SEC_NOT_AVAILABLE => HwKeyError::Unavailable("no keychain is available".into()),
        ERR_SEC_ITEM_NOT_FOUND => HwKeyError::Missing,
        ERR_SEC_USER_CANCELED => HwKeyError::Cancelled,
        ERR_SEC_AUTH_FAILED => HwKeyError::Failed("Touch ID did not recognise you".into()),
        ERR_SEC_INTERACTION_NOT_ALLOWED => {
            HwKeyError::Failed("the keychain refused to show the Touch ID prompt".into())
        }
        other => HwKeyError::Other(format!("keychain error {other}")),
    }
}

/// The query for the wrapping-key item.
fn base_query() -> Vec<(CFString, CFType)> {
    item_query(ACCOUNT)
}

/// `(kSecClass, generic password) + service + account + data-protection`.
fn item_query(account: &str) -> Vec<(CFString, CFType)> {
    // SAFETY: the `kSec*` statics are immutable CFStrings exported by the
    // Security framework; wrapping under the get rule retains them.
    unsafe {
        vec![
            (
                CFString::wrap_under_get_rule(kSecClass),
                CFString::wrap_under_get_rule(kSecClassGenericPassword).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrService),
                CFString::new(HW_KEY_NAME).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrAccount),
                CFString::new(account).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecUseDataProtectionKeychain),
                CFBoolean::true_value().into_CFType(),
            ),
        ]
    }
}

fn dictionary(pairs: &[(CFString, CFType)]) -> CFDictionary<CFString, CFType> {
    CFDictionary::from_CFType_pairs(pairs)
}

/// Copy the item's data with `extra` query pairs. `Ok(bytes)` or the status.
fn copy_matching(extra: Vec<(CFString, CFType)>) -> Result<Vec<u8>, i32> {
    let mut pairs = base_query();
    // SAFETY: immutable framework constant.
    pairs.push(unsafe {
        (
            CFString::wrap_under_get_rule(kSecReturnData),
            CFBoolean::true_value().into_CFType(),
        )
    });
    pairs.extend(extra);
    let query = dictionary(&pairs);
    let mut result: CFTypeRef = ptr::null();
    // SAFETY: `query` is a valid CFDictionary for the call's duration and
    // `result` receives a +1 reference on success.
    let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) };
    if status != ERR_SEC_SUCCESS {
        return Err(status);
    }
    if result.is_null() {
        return Err(ERR_SEC_ITEM_NOT_FOUND);
    }
    // SAFETY: with kSecReturnData and the default match limit (one), the
    // result is a CFData returned under the create rule.
    let data = unsafe { CFData::wrap_under_create_rule(result as _) };
    Ok(data.bytes().to_vec())
}

fn delete_item() -> i32 {
    delete_account(ACCOUNT)
}

fn delete_account(account: &str) -> i32 {
    let query = dictionary(&item_query(account));
    // SAFETY: `query` is a valid CFDictionary for the call's duration.
    unsafe { SecItemDelete(query.as_concrete_TypeRef()) }
}

fn context_for(reason: &str) -> Retained<LAContext> {
    // SAFETY: `LAContext::new` has no preconditions; the setters take valid
    // NSStrings on the live context.
    unsafe {
        let context = LAContext::new();
        context.setLocalizedReason(&NSString::from_str(reason));
        context.setLocalizedFallbackTitle(Some(&NSString::from_str("Use Master Password")));
        context
    }
}

/// Write and remove a throwaway data-protection item (never prompts).
fn probe_entitlement() -> Result<(), HwKeyError> {
    // A lookup is not enough: an unsigned binary can *query* the
    // data-protection keychain (it just finds nothing). Writing needs the
    // entitlement, so add and remove a throwaway item without any access
    // control (no prompt). Missing entitlement fails with -34018.
    let mut pairs = item_query(PROBE_ACCOUNT);
    // SAFETY: immutable framework constant; the value is an owned CFData.
    pairs.push(unsafe {
        (
            CFString::wrap_under_get_rule(kSecValueData),
            CFData::from_buffer(b"probe").into_CFType(),
        )
    });
    let attributes = dictionary(&pairs);
    // SAFETY: valid dictionary; no result requested.
    let status = unsafe { SecItemAdd(attributes.as_concrete_TypeRef(), ptr::null_mut()) };
    let _ = delete_account(PROBE_ACCOUNT);
    match status {
        ERR_SEC_SUCCESS | ERR_SEC_DUPLICATE_ITEM => Ok(()),
        status => match map_status(status) {
            unavailable @ HwKeyError::Unavailable(_) => Err(unavailable),
            // Anything else would also break create/release: fall back.
            other => Err(HwKeyError::Unavailable(other.to_string())),
        },
    }
}

impl HardwareKeyProtector for MacKeychainKey {
    fn probe(&self) -> Result<(), HwKeyError> {
        // The entitlement cannot change while the process runs: probe once.
        static PROBE: OnceLock<Result<(), HwKeyError>> = OnceLock::new();
        PROBE.get_or_init(probe_entitlement).clone()
    }

    fn create_prompts(&self) -> bool {
        false
    }

    fn create(&self, _reason: &str, _owner: Option<isize>) -> Result<WrappingKey, HwKeyError> {
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenPasscodeSetThisDeviceOnly),
            kSecAccessControlBiometryCurrentSet,
        )
        .map_err(|e| HwKeyError::Other(format!("SecAccessControlCreateWithFlags: {e}")))?;

        let mut key = Zeroizing::new([0u8; WRAPPING_KEY_LEN]);
        OsRng.fill_bytes(key.as_mut());

        match delete_item() {
            ERR_SEC_SUCCESS | ERR_SEC_ITEM_NOT_FOUND => {}
            status => return Err(map_status(status)),
        }
        let mut pairs = base_query();
        // SAFETY: immutable framework constants; the values are owned CF
        // objects retained by the dictionary.
        unsafe {
            pairs.push((
                CFString::wrap_under_get_rule(kSecAttrAccessControl),
                access.into_CFType(),
            ));
            pairs.push((
                CFString::wrap_under_get_rule(kSecValueData),
                CFData::from_buffer(key.as_ref()).into_CFType(),
            ));
        }
        let attributes = dictionary(&pairs);
        // SAFETY: valid dictionary; no result requested.
        let status = unsafe { SecItemAdd(attributes.as_concrete_TypeRef(), ptr::null_mut()) };
        if status != ERR_SEC_SUCCESS {
            return Err(map_status(status));
        }
        Ok(key)
    }

    fn release(&self, reason: &str, _owner: Option<isize>) -> Result<WrappingKey, HwKeyError> {
        if reason.trim().is_empty() {
            return Err(HwKeyError::Other("a prompt reason is required".into()));
        }
        let context = context_for(reason);
        // SAFETY: `LAContext` is an NSObject, which is a valid CFTypeRef; the
        // dictionary retains it for the call and `context` outlives it.
        let auth_context = unsafe {
            (
                CFString::wrap_under_get_rule(kSecUseAuthenticationContext),
                CFType::wrap_under_get_rule(Retained::as_ptr(&context) as CFTypeRef),
            )
        };
        let bytes = Zeroizing::new(copy_matching(vec![auth_context]).map_err(map_status)?);
        if bytes.len() != WRAPPING_KEY_LEN {
            return Err(HwKeyError::Missing);
        }
        let mut key = Zeroizing::new([0u8; WRAPPING_KEY_LEN]);
        key.copy_from_slice(&bytes);
        Ok(key)
    }

    fn delete(&self) -> Result<(), HwKeyError> {
        match delete_item() {
            ERR_SEC_SUCCESS | ERR_SEC_ITEM_NOT_FOUND | ERR_SEC_MISSING_ENTITLEMENT => Ok(()),
            status => Err(map_status(status)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_codes_map_to_the_fail_closed_taxonomy() {
        assert!(matches!(
            map_status(ERR_SEC_MISSING_ENTITLEMENT),
            HwKeyError::Unavailable(_)
        ));
        assert_eq!(map_status(ERR_SEC_ITEM_NOT_FOUND), HwKeyError::Missing);
        assert_eq!(map_status(ERR_SEC_USER_CANCELED), HwKeyError::Cancelled);
        assert!(matches!(
            map_status(ERR_SEC_AUTH_FAILED),
            HwKeyError::Failed(_)
        ));
        assert!(matches!(map_status(-1), HwKeyError::Other(_)));
    }

    /// Exercises the real Security framework binding without prompting: an
    /// unsigned test binary has no `keychain-access-groups` entitlement, so
    /// the probe must report `Unavailable` (and delete must be a no-op).
    /// Ignored by default because it talks to the real keychain; run with
    /// `--ignored` on a Mac.
    #[test]
    #[ignore = "talks to the real macOS keychain"]
    fn unsigned_binary_probe_reports_missing_entitlement() {
        assert!(matches!(
            MacKeychainKey.probe(),
            Err(HwKeyError::Unavailable(_))
        ));
        assert_eq!(MacKeychainKey.delete(), Ok(()));
    }
}
