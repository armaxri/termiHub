//! Describe and classify the `keyring` errors of the OS keychain store
//! (#5514).
//!
//! A bare "Failed to read OS keychain entry" says nothing about *why*, so every
//! keychain failure carries [`describe`]: the `keyring` error variant plus,
//! on macOS, the Security.framework `OSStatus` and its name.
//!
//! [`is_access_denied`] picks out the failures where an item exists but this
//! build may not read it. On macOS a keychain item's access list trusts the
//! binary that wrote it, identified by its code signature; an unsigned or
//! ad-hoc signed build gets a new identity on every rebuild, so an item an
//! earlier build wrote reads back as `errSecAuthFailed` (or a prompt the user
//! declined) instead of `errSecItemNotFound`. The store decides with its key
//! index whether such an item is one of its own secrets (fail closed) or a
//! leftover it never wrote (absent).

use keyring::Error as KeyringError;

/// `errSecUserCanceled`: the user declined the keychain access prompt.
pub(crate) const ERR_SEC_USER_CANCELED: i32 = -128;
/// `errSecAuthFailed`: the item's access list does not trust this binary.
pub(crate) const ERR_SEC_AUTH_FAILED: i32 = -25293;
/// `errSecDuplicateItem`: an item with this service and account exists.
pub(crate) const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;
/// `errSecInteractionNotAllowed`: access needs a prompt that may not be shown.
pub(crate) const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

/// The names of the `OSStatus` codes a keychain call commonly returns
/// (Security/SecBase.h).
const STATUS_NAMES: [(i32, &str); 11] = [
    (ERR_SEC_USER_CANCELED, "errSecUserCanceled"),
    (-25244, "errSecInvalidOwnerEdit"),
    (-25291, "errSecNotAvailable"),
    (-25292, "errSecReadOnly"),
    (ERR_SEC_AUTH_FAILED, "errSecAuthFailed"),
    (-25294, "errSecNoSuchKeychain"),
    (-25295, "errSecInvalidKeychain"),
    (ERR_SEC_DUPLICATE_ITEM, "errSecDuplicateItem"),
    (-25300, "errSecItemNotFound"),
    (
        ERR_SEC_INTERACTION_NOT_ALLOWED,
        "errSecInteractionNotAllowed",
    ),
    (-34018, "errSecMissingEntitlement"),
];

/// The platform status code carried by a keyring error: the macOS
/// `OSStatus`, or `None` (other platforms, or no platform error attached).
pub(crate) fn os_status(error: &KeyringError) -> Option<i32> {
    match error {
        KeyringError::PlatformFailure(inner) | KeyringError::NoStorageAccess(inner) => {
            platform_status(inner.as_ref())
        }
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn platform_status(inner: &(dyn std::error::Error + Send + Sync + 'static)) -> Option<i32> {
    inner
        .downcast_ref::<security_framework::base::Error>()
        .map(|e| e.code())
}

#[cfg(not(target_os = "macos"))]
fn platform_status(_inner: &(dyn std::error::Error + Send + Sync + 'static)) -> Option<i32> {
    None
}

/// Whether the keychain refused access to an item that exists: its access
/// list does not trust this build, or the user declined (or could not be
/// shown) the access prompt. Never true for a missing item.
pub(crate) fn is_access_denied(error: &KeyringError) -> bool {
    matches!(
        os_status(error),
        Some(ERR_SEC_AUTH_FAILED | ERR_SEC_USER_CANCELED | ERR_SEC_INTERACTION_NOT_ALLOWED)
    )
}

/// Whether a write failed because an item for the account already exists
/// that this build could not read, so it could not update it either.
pub(crate) fn is_duplicate_item(error: &KeyringError) -> bool {
    os_status(error) == Some(ERR_SEC_DUPLICATE_ITEM)
}

/// A log- and user-safe description of a keyring error: the variant, the
/// `OSStatus` (with its name) when there is one, and the platform message.
/// Never includes a stored value (a `BadEncoding` error carries one).
pub(crate) fn describe(error: &KeyringError) -> String {
    let status = os_status(error).map(|code| {
        let name = STATUS_NAMES
            .iter()
            .find(|(c, _)| *c == code)
            .map_or("unknown", |(_, n)| n);
        format!(", OSStatus {code} {name}")
    });
    let status = status.unwrap_or_default();
    match error {
        KeyringError::PlatformFailure(inner) => format!("PlatformFailure{status}: {inner}"),
        KeyringError::NoStorageAccess(inner) => format!("NoStorageAccess{status}: {inner}"),
        KeyringError::NoEntry => "NoEntry: no keychain item".to_string(),
        KeyringError::BadEncoding(_) => "BadEncoding: the stored value is not UTF-8".to_string(),
        KeyringError::TooLong(attr, max) => {
            format!("TooLong: attribute {attr} is longer than {max}")
        }
        KeyringError::Invalid(attr, reason) => format!("Invalid: attribute {attr}: {reason}"),
        KeyringError::Ambiguous(items) => {
            format!("Ambiguous: {} matching keychain items", items.len())
        }
        other => format!("{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_a_platform_failure_with_its_message() {
        let e = KeyringError::PlatformFailure("boom".into());
        assert_eq!(describe(&e), "PlatformFailure: boom");
        assert!(!is_access_denied(&e));
        assert_eq!(os_status(&e), None);
    }

    #[test]
    fn never_describes_a_badly_encoded_value() {
        let e = KeyringError::BadEncoding(b"SECRET-\xff".to_vec());
        assert!(!describe(&e).contains("SECRET"));
    }

    #[test]
    fn a_missing_item_is_not_access_denied() {
        assert!(!is_access_denied(&KeyringError::NoEntry));
        assert_eq!(
            describe(&KeyringError::NoEntry),
            "NoEntry: no keychain item"
        );
    }

    #[cfg(target_os = "macos")]
    fn status_error(code: i32) -> KeyringError {
        KeyringError::PlatformFailure(Box::new(security_framework::base::Error::from_code(code)))
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_untrusted_item_is_access_denied_and_named() {
        let e = status_error(ERR_SEC_AUTH_FAILED);
        assert!(is_access_denied(&e));
        assert!(!is_duplicate_item(&e));
        let text = describe(&e);
        assert!(text.starts_with("PlatformFailure, OSStatus -25293 errSecAuthFailed"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_declined_or_suppressed_prompt_is_access_denied() {
        assert!(is_access_denied(&status_error(ERR_SEC_USER_CANCELED)));
        assert!(is_access_denied(&status_error(
            ERR_SEC_INTERACTION_NOT_ALLOWED
        )));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_duplicate_item_is_recognized() {
        let e = status_error(ERR_SEC_DUPLICATE_ITEM);
        assert!(is_duplicate_item(&e));
        assert!(!is_access_denied(&e));
        assert!(describe(&e).contains("errSecDuplicateItem"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_unknown_status_is_still_reported() {
        assert!(describe(&status_error(-1)).contains("OSStatus -1 unknown"));
    }
}
