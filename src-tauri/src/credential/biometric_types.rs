//! Types shared by biometric unlock (PROD-064, #3433 / #3534): the error
//! taxonomy, the key-protection kind and the status reported to the UI.

use serde::{Deserialize, Serialize};

use super::hw_key::HwKeyError;
use super::os_auth::OsAuthError;

/// Who enforces user presence before the wrapping key can be used.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyProtection {
    /// The wrapping key sits in the login keychain / Credential Manager and
    /// termiHub checks Touch ID / Windows Hello before reading it. Code
    /// running as the user can read it without a prompt.
    #[default]
    App,
    /// The OS releases (macOS Secure Enclave access control) or derives
    /// (Windows Hello key credential) the wrapping key only after it verified
    /// the user itself.
    OsEnforced,
}

/// Why a biometric-unlock operation failed.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BiometricUnlockError {
    /// Biometric unlock has not been turned on.
    #[error("{message}")]
    NotEnabled { message: String },
    /// The enrollment no longer matches (master password or biometric
    /// enrollment changed, key missing or tampered). It has been deleted.
    #[error("{message}")]
    Invalidated { message: String },
    /// The OS prompt was cancelled (including the "use master password"
    /// fallback button).
    #[error("{message}")]
    Cancelled { message: String },
    /// The OS rejected the user or verification is unavailable.
    #[error("{message}")]
    AuthFailed { message: String },
    /// The master password given to opt in was wrong.
    #[error("{message}")]
    WrongMasterPassword { message: String },
    /// The store must be unlocked (to opt in) / in master-password mode.
    #[error("{message}")]
    StoreUnavailable { message: String },
    /// The credentials file itself cannot be read (not an enrollment issue).
    #[error("{message}")]
    StoreCorrupted { message: String },
    /// Any other failure.
    #[error("{message}")]
    Other { message: String },
}

impl BiometricUnlockError {
    pub(crate) fn other(message: impl Into<String>) -> Self {
        Self::Other {
            message: message.into(),
        }
    }

    pub(crate) fn store_unavailable(message: impl Into<String>) -> Self {
        Self::StoreUnavailable {
            message: message.into(),
        }
    }
}

impl From<OsAuthError> for BiometricUnlockError {
    fn from(error: OsAuthError) -> Self {
        match error {
            OsAuthError::Cancelled => Self::Cancelled {
                message: error.to_string(),
            },
            other => Self::AuthFailed {
                message: other.to_string(),
            },
        }
    }
}

impl From<HwKeyError> for BiometricUnlockError {
    fn from(error: HwKeyError) -> Self {
        match error {
            HwKeyError::Cancelled => Self::Cancelled {
                message: error.to_string(),
            },
            HwKeyError::Failed(_) | HwKeyError::Unavailable(_) => Self::AuthFailed {
                message: error.to_string(),
            },
            HwKeyError::Missing | HwKeyError::Other(_) => Self::other(error.to_string()),
        }
    }
}

/// Biometric-unlock state reported to the UI.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BiometricUnlockStatus {
    /// The OS can verify the user biometrically here (the option is shown).
    pub supported: bool,
    /// Biometric unlock is turned on for the current master-password store.
    pub enabled: bool,
    /// User-facing mechanism name, e.g. "Touch ID" or "Windows Hello".
    pub method_label: String,
    /// Why it is not supported, when `supported` is `false`.
    pub reason: Option<String>,
    /// How the current enrollment's key is protected (`None` when off).
    pub protection: Option<KeyProtection>,
    /// Whether turning it on now would use OS-enforced protection
    /// (signed macOS build with the keychain entitlement / Windows Hello key
    /// credentials). `false` means the app-enforced fallback.
    pub os_enforced_available: bool,
}
