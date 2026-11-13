//! Delete an OS keychain item without reading it (#5527).
//!
//! On macOS a keychain item's access list (and, in the login keychain, its
//! partition list) trusts the binary that wrote it by its code signature. An
//! ad-hoc signed build — every dev build and every update of the unsigned
//! v0.1.0 beta — gets a new signature each time, so it cannot read an item an
//! earlier build wrote: the read fails with `errSecAuthFailed`, or shows an
//! access prompt when prompts are allowed. `keyring` reads an item before it
//! updates or deletes it, so such an item also blocks every write
//! (`errSecDuplicateItem`) and delete of that account.
//!
//! Measured on macOS 27 (see #5527): looking an item up by its attributes and
//! deleting the reference never reads the value, never prompts and succeeds
//! for an item another build wrote. That is what [`UnreadItems::delete`]
//! does, so the store can replace such an item with a value the user saves.
//! Updating the value in place instead (`SecItemUpdate`) reports success but
//! leaves an item that no build can read, so it is never used.
//!
//! The Windows Credential Manager and the Linux Secret Service have no
//! per-build access lists, so there [`PlatformUnreadItems`] applies to
//! nothing.

use keyring::Entry;

/// Keychain operations the `keyring` crate lacks, injected into the OS
/// keychain store so its use of them is testable with the `keyring` mock.
pub(crate) trait UnreadItems: Send + Sync {
    /// Whether `entry` addresses an item in a keychain whose items trust only
    /// the build that wrote them (the macOS keychain). Never true for the
    /// `keyring` mock or another platform.
    fn applies_to(&self, entry: &Entry) -> bool;

    /// Delete the item `entry` addresses without reading its value:
    /// `Ok(true)` when one was deleted, `Ok(false)` when there was none, or
    /// the platform status code of the failure.
    fn delete(&self, entry: &Entry) -> Result<bool, i32>;
}

/// The platform implementation of [`UnreadItems`].
pub(crate) struct PlatformUnreadItems;

#[cfg(target_os = "macos")]
impl UnreadItems for PlatformUnreadItems {
    fn applies_to(&self, entry: &Entry) -> bool {
        entry
            .get_credential()
            .downcast_ref::<keyring::macos::MacCredential>()
            .is_some()
    }

    fn delete(&self, entry: &Entry) -> Result<bool, i32> {
        match entry
            .get_credential()
            .downcast_ref::<keyring::macos::MacCredential>()
        {
            Some(credential) => macos::delete_without_reading(credential),
            None => Ok(false),
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl UnreadItems for PlatformUnreadItems {
    fn applies_to(&self, _entry: &Entry) -> bool {
        false
    }

    fn delete(&self, _entry: &Entry) -> Result<bool, i32> {
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ptr;

    use core_foundation::array::CFArray;
    use core_foundation::base::{CFRelease, TCFType};
    use keyring::macos::{MacCredential, MacKeychainDomain};
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
    use security_framework_sys::base::{errSecItemNotFound, SecKeychainItemRef};
    use security_framework_sys::keychain::SecKeychainFindGenericPassword;
    use security_framework_sys::keychain_item::SecKeychainItemDelete;

    /// Delete the generic-password item of `credential` (the keychain
    /// `keyring` uses for it, its service and account) without reading its
    /// value. Deletes every match, though a keychain holds at most one.
    pub(super) fn delete_without_reading(credential: &MacCredential) -> Result<bool, i32> {
        let domain = match credential.domain {
            MacKeychainDomain::User => SecPreferencesDomain::User,
            MacKeychainDomain::System => SecPreferencesDomain::System,
            MacKeychainDomain::Common => SecPreferencesDomain::Common,
            MacKeychainDomain::Dynamic => SecPreferencesDomain::Dynamic,
        };
        let keychain = SecKeychain::default_for_domain(domain).map_err(|e| e.code())?;
        let keychains = CFArray::from_CFTypes(&[keychain]);
        let service = credential.service.as_bytes();
        let account = credential.account.as_bytes();
        let mut deleted = false;
        // Bounded: each pass deletes the item it found, or stops.
        for _ in 0..8 {
            let mut item: SecKeychainItemRef = ptr::null_mut();
            // SAFETY: the keychain array, service and account outlive the
            // call; null length/data pointers ask for no password data, so
            // the value is never read; `item` receives an owned reference.
            let status = unsafe {
                SecKeychainFindGenericPassword(
                    keychains.as_CFTypeRef(),
                    service.len() as u32,
                    service.as_ptr().cast(),
                    account.len() as u32,
                    account.as_ptr().cast(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    &mut item,
                )
            };
            if status == errSecItemNotFound {
                return Ok(deleted);
            }
            if status != 0 {
                return Err(status);
            }
            // SAFETY: `item` is the valid reference just returned; it is
            // released exactly once, after the delete.
            let status = unsafe {
                let status = SecKeychainItemDelete(item);
                CFRelease(item.cast());
                status
            };
            if status != 0 {
                return Err(status);
            }
            deleted = true;
        }
        Ok(deleted)
    }
}
