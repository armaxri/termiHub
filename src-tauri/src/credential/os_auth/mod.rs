//! OS-level user verification (#3433, PROD-064).
//!
//! termiHub asks the operating system to confirm that the person at the
//! keyboard is the logged-in user before two sensitive operations:
//!
//! - **Exporting credentials from the OS keychain** (credential-vault export
//!   and the credentials section of a unified backup). The keychain has no
//!   in-app secret to re-enter, and termiHub can read its own keychain items
//!   without an OS prompt, so without this gate anyone at an unattended,
//!   unlocked session could walk off with every saved secret.
//! - **Biometric unlock of the master-password store** (see
//!   [`biometric_unlock`](super::biometric_unlock)).
//!
//! Every platform implements [`OsUserVerifier`]:
//!
//! | Platform | Mechanism |
//! | --- | --- |
//! | macOS | LocalAuthentication `LAContext` — `deviceOwnerAuthentication` (Touch ID **or** the login password) for export re-authentication, `deviceOwnerAuthenticationWithBiometrics` (Touch ID only) for biometric unlock |
//! | Windows | Windows Hello `UserConsentVerifier` (face / fingerprint / PIN), parented to the termiHub window |
//! | Linux / other | **Unavailable** — there is no standard per-user re-authentication API (polkit authenticates *administrative* actions and needs a system-installed policy file); verification always fails closed |
//!
//! The contract is **fail closed**: an implementation must never report
//! success unless the OS confirmed the user. Cancellation, failure, timeout
//! and "not available" are all errors, and callers refuse the operation.
//!
//! Unit tests never talk to the real OS: under `cfg(test)` the platform
//! verifier is always the unavailable one, and tests inject
//! [`mock::MockVerifier`] to script success / cancel / failure / unavailable.

use serde::Serialize;

// The real verifiers are compiled (and linted) in test builds too, but only
// constructed by production builds — tests must never reach the real OS.
#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
mod macos;
#[cfg(test)]
pub mod mock;
#[cfg(any(test, not(any(target_os = "macos", windows))))]
mod unsupported;
#[cfg(windows)]
#[cfg_attr(test, allow(dead_code))]
mod windows_hello;

#[cfg(any(test, not(any(target_os = "macos", windows))))]
pub use unsupported::UnsupportedVerifier;

/// Why termiHub is asking the OS to verify the user. Selects the OS policy
/// (e.g. biometrics-only vs. biometrics-or-password on macOS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsAuthPurpose {
    /// Re-authenticate before exporting credentials from the OS keychain.
    /// Accepts biometrics or the device/login password.
    ReauthExport,
    /// Confirm the biometric works while enrolling biometric unlock.
    EnableBiometricUnlock,
    /// Release the stored vault key to unlock the master-password store.
    BiometricUnlock,
}

impl OsAuthPurpose {
    /// `true` for the purposes that must use a biometric-bound policy, so the
    /// enrollment fingerprint is meaningful and comparable between calls.
    pub fn is_biometric(self) -> bool {
        matches!(
            self,
            OsAuthPurpose::EnableBiometricUnlock | OsAuthPurpose::BiometricUnlock
        )
    }
}

/// Whether OS verification can be used for a purpose on this machine.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsAuthCapability {
    /// `true` when the OS can verify the user for this purpose right now.
    pub available: bool,
    /// User-facing name of the mechanism, e.g. "Touch ID", "Windows Hello",
    /// or "your Mac password".
    pub method_label: String,
    /// Why verification is unavailable (set when `available` is `false`).
    pub reason: Option<String>,
}

impl OsAuthCapability {
    /// A capability that is available through `method_label`.
    pub fn available(method_label: impl Into<String>) -> Self {
        Self {
            available: true,
            method_label: method_label.into(),
            reason: None,
        }
    }

    /// A capability that is not available, with a user-facing reason.
    pub fn unavailable(method_label: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            available: false,
            method_label: method_label.into(),
            reason: Some(reason.into()),
        }
    }
}

/// A successful OS verification.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OsAuthSuccess {
    /// SHA-256 of the OS biometric-enrollment state after a biometric
    /// verification (macOS `evaluatedPolicyDomainState`). It changes when a
    /// fingerprint/face is added or removed, which invalidates biometric
    /// unlock. `None` where the OS does not expose it (Windows) or for a
    /// non-biometric purpose.
    pub enrollment_fingerprint: Option<[u8; 32]>,
}

/// Why an OS verification did not succeed. Every variant means "refuse".
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OsAuthError {
    /// The user dismissed the prompt (or chose the fallback button).
    #[error("System authentication was cancelled.")]
    Cancelled,
    /// The OS rejected the user (wrong finger, too many attempts, lockout, …).
    #[error("System authentication failed: {0}")]
    Failed(String),
    /// OS verification cannot be used on this machine right now.
    #[error("System authentication is not available: {0}")]
    Unavailable(String),
    /// Any other error from the OS API.
    #[error("System authentication error: {0}")]
    Other(String),
}

/// Asks the OS to verify the logged-in user.
///
/// Implementations block the calling thread until the user answers the OS
/// prompt (bounded by an implementation timeout) and must **never** return
/// `Ok` unless the OS confirmed the user.
pub trait OsUserVerifier: Send + Sync {
    /// Whether verification for `purpose` is possible here. Never prompts.
    fn capability(&self, purpose: OsAuthPurpose) -> OsAuthCapability;

    /// Prompt the user. `reason` completes the sentence
    /// "termiHub is trying to …" (e.g. "export your saved credentials").
    /// `owner_window` is the native parent window handle (HWND on Windows) so
    /// the prompt is shown in front of termiHub; ignored where not needed.
    fn verify(
        &self,
        purpose: OsAuthPurpose,
        reason: &str,
        owner_window: Option<isize>,
    ) -> Result<OsAuthSuccess, OsAuthError>;
}

impl<T: OsUserVerifier + ?Sized> OsUserVerifier for std::sync::Arc<T> {
    fn capability(&self, purpose: OsAuthPurpose) -> OsAuthCapability {
        (**self).capability(purpose)
    }

    fn verify(
        &self,
        purpose: OsAuthPurpose,
        reason: &str,
        owner_window: Option<isize>,
    ) -> Result<OsAuthSuccess, OsAuthError> {
        (**self).verify(purpose, reason, owner_window)
    }
}

/// The verifier for the platform this build runs on.
///
/// Unit tests always get the unavailable verifier so a test can never pop a
/// real Touch ID / Windows Hello prompt; they inject a mock instead.
pub fn platform_verifier() -> Box<dyn OsUserVerifier> {
    #[cfg(test)]
    {
        Box::new(UnsupportedVerifier::new(
            "OS verification is disabled in unit tests",
        ))
    }
    #[cfg(all(not(test), target_os = "macos"))]
    {
        Box::new(macos::MacVerifier)
    }
    #[cfg(all(not(test), windows))]
    {
        Box::new(windows_hello::WindowsHelloVerifier)
    }
    #[cfg(all(not(test), not(target_os = "macos"), not(windows)))]
    {
        Box::new(UnsupportedVerifier::new(
            "This operating system has no supported way for termiHub to re-authenticate you \
             (Touch ID / Windows Hello). Use Master Password storage to export credentials.",
        ))
    }
}
